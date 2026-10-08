// One behavioural suite, run against the in-memory store and against D1HubStore over real SQLite
// and the real migration file. If they ever disagree, one of them is wrong.

import test from "node:test";
import assert from "node:assert/strict";

import { MemoryHubStore } from "../src/hub/store.js";
import { D1HubStore } from "../src/hub/d1-store.js";
import { makeFakeD1 } from "./helpers.mjs";

const IMPLEMENTATIONS = {
  memory: (options) => new MemoryHubStore(options),
  d1: (options) => new D1HubStore(makeFakeD1({ sql: "hub-d1.sql" }), options),
};

for (const [kind, make] of Object.entries(IMPLEMENTATIONS)) {
  const t = (name, fn) => test(`[${kind}] ${name}`, () => fn(make));

  t("creating a site is idempotent and never overwrites", async (make) => {
    const store = make();
    assert.equal(await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme", createdBy: 1 }), true);
    assert.equal(await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Other", createdBy: 2 }), false);
    const site = await store.getNamespace("acme");
    assert.equal(site.name, "Acme");
    assert.equal(site.enabled, true);
    assert.equal(site.createdBy, 1);
    assert.equal(await store.getNamespace("nope"), null);
  });

  t("a blank name falls back to the namespace", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "   " });
    assert.equal((await store.getNamespace("acme")).name, "acme");
    await store.updateNamespace("acme", { name: "Acme" });
    await store.updateNamespace("acme", { name: "" });
    assert.equal((await store.getNamespace("acme")).name, "acme");
  });

  t("namespaces that the flow could not carry are refused by the store itself", async (make) => {
    const store = make();
    for (const bad of ["", "has_underscore", "x".repeat(25), "sp ace", "hub-admin", "a/b", null]) {
      await assert.rejects(store.createNamespace({ namespace: bad, name: "x" }), /namespace|reserved/, String(bad));
    }
  });

  t("update changes only what it is given, and reports a missing site", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    assert.equal(await store.updateNamespace("acme", { enabled: false }), true);
    assert.deepEqual(
      (({ name, enabled }) => ({ name, enabled }))(await store.getNamespace("acme")),
      { name: "Acme", enabled: false }
    );
    assert.equal(await store.updateNamespace("acme", { name: "Acme 2" }), true);
    assert.deepEqual(
      (({ name, enabled }) => ({ name, enabled }))(await store.getNamespace("acme")),
      { name: "Acme 2", enabled: false }
    );
    assert.equal(await store.updateNamespace("ghost", { enabled: true }), false);
  });

  t("access reports unknown, disabled, granted and not granted apart", async (make) => {
    const store = make();
    assert.deepEqual(await store.access("acme", 111), { exists: false, enabled: false, mode: "granted", origins: [], granted: false, blocked: false });

    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    assert.deepEqual(await store.access("acme", 111), { exists: true, enabled: true, mode: "granted", origins: ["https://acme.example"], granted: false, blocked: false });

    await store.addGrant({ namespace: "acme", id: 111 });
    assert.deepEqual(await store.access("acme", 111), { exists: true, enabled: true, mode: "granted", origins: ["https://acme.example"], granted: true, blocked: false });
    assert.equal((await store.access("acme", 222)).granted, false);
    assert.equal((await store.access("other", 111)).granted, false, "a grant is per site");

    await store.updateNamespace("acme", { enabled: false });
    assert.deepEqual(await store.access("acme", 111), { exists: true, enabled: false, mode: "granted", origins: ["https://acme.example"], granted: true, blocked: false });
  });

  t("a site starts as approved-people-only, can be created open, and switches both ways", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    await store.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "Forum", access: "anyone" });
    assert.equal((await store.getNamespace("acme")).access, "granted");
    assert.equal((await store.getNamespace("forum")).access, "anyone");

    assert.equal(await store.updateNamespace("acme", { access: "anyone" }), true);
    assert.equal((await store.access("acme", 5)).mode, "anyone");
    assert.equal((await store.listNamespaces()).find((s) => s.namespace === "acme").access, "anyone");
    await store.updateNamespace("acme", { access: "granted" });
    assert.equal((await store.access("acme", 5)).mode, "granted");
  });

  t("an access mode that does not exist is refused, and refusing it changes nothing", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    for (const bad of ["open", "ANYONE", "", null, 1, {}]) {
      await assert.rejects(store.updateNamespace("acme", { access: bad }), /access must be/, String(bad));
    }
    await assert.rejects(store.createNamespace({ namespace: "x", origins: ["https://x.example"], name: "x", access: "public" }), /access must be/);
    assert.equal((await store.getNamespace("acme")).access, "granted");
    assert.equal(await store.getNamespace("x"), null);
  });

  t("switching access leaves the grants alone, so switching back restores them", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    await store.addGrant({ namespace: "acme", id: 111 });
    await store.updateNamespace("acme", { access: "anyone" });
    assert.equal((await store.access("acme", 111)).granted, true, "the grant is still there while the site is open");
    await store.updateNamespace("acme", { access: "granted" });
    assert.equal((await store.access("acme", 111)).granted, true);
    assert.equal((await store.listGrants("acme")).length, 1);
  });

  t("blocks add once, remove once, list newest first, and apply per site", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    await store.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "Forum", access: "anyone" });
    assert.equal(await store.addBlock({ namespace: "forum", id: 9, label: "spam", addedBy: 1 }), true);
    assert.equal(await store.addBlock({ namespace: "forum", id: 9, label: "again" }), false);
    await store.addBlock({ namespace: "forum", id: 8 });

    const blocks = await store.listBlocks("forum");
    assert.deepEqual(blocks.map((b) => b.id).sort(), [8, 9]);
    const nine = blocks.find((b) => b.id === 9);
    assert.deepEqual([nine.label, nine.addedBy], ["spam", 1], "re-adding does not rewrite the existing block");

    assert.equal((await store.access("forum", 9)).blocked, true);
    assert.equal((await store.access("forum", 7)).blocked, false);
    assert.equal((await store.access("acme", 9)).blocked, false, "a block is per site");
    assert.deepEqual(await store.listBlocks("acme"), []);

    assert.equal(await store.removeBlock("forum", 9), true);
    assert.equal(await store.removeBlock("forum", 9), false);
    assert.equal((await store.access("forum", 9)).blocked, false);
    assert.equal((await store.listBlocks("forum", { limit: 1 })).length, 1);
  });

  t("a block and a grant can coexist; the block is reported alongside, not instead", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    await store.addGrant({ namespace: "acme", id: 5 });
    await store.addBlock({ namespace: "acme", id: 5 });
    const state = await store.access("acme", 5);
    assert.deepEqual([state.granted, state.blocked], [true, true]);
  });

  t("block notes are cleaned and capped like every other label", async (make) => {
    const store = make();
    await store.addBlock({ namespace: "acme", id: 5, label: `x\n\ty${"z".repeat(200)}` });
    const [block] = await store.listBlocks("acme");
    assert.ok(block.label.startsWith("x y"));
    assert.ok(block.label.length <= 80);
  });

  t("ids beyond 32 bits survive a round trip", async (make) => {
    const store = make();
    const big = 7_123_456_789_012;
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    await store.addGrant({ namespace: "acme", id: big, label: "big" });
    assert.equal((await store.access("acme", big)).granted, true);
    assert.equal((await store.listGrants("acme"))[0].id, big);
    await store.addAdmin({ id: big });
    assert.equal(await store.isAdmin(big), true);
  });

  t("grants add once, remove once, and list newest first", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    assert.equal(await store.addGrant({ namespace: "acme", id: 1, label: "first", addedBy: 9 }), true);
    assert.equal(await store.addGrant({ namespace: "acme", id: 1, label: "changed" }), false);
    await store.addGrant({ namespace: "acme", id: 2 });

    const grants = await store.listGrants("acme");
    assert.deepEqual(grants.map((g) => g.id).sort(), [1, 2]);
    const first = grants.find((g) => g.id === 1);
    assert.equal(first.label, "first", "re-adding does not rewrite the existing grant");
    assert.equal(first.addedBy, 9);

    assert.equal(await store.removeGrant("acme", 1), true);
    assert.equal(await store.removeGrant("acme", 1), false);
    assert.equal((await store.access("acme", 1)).granted, false);
    assert.equal((await store.listGrants("acme", { limit: 1 })).length, 1);
  });

  t("labels are cleaned of control characters and capped", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    await store.addGrant({ namespace: "acme", id: 5, label: `a\n\tb${"x".repeat(200)}` });
    const [grant] = await store.listGrants("acme");
    assert.ok(grant.label.startsWith("a b"));
    assert.ok(grant.label.length <= 80);
  });

  t("deleting a site takes its grants and requests with it, and a re-created site starts empty", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
    await store.createNamespace({ namespace: "keep", origins: ["https://keep.example"], name: "Keep" });
    await store.addGrant({ namespace: "acme", id: 1 });
    await store.addGrant({ namespace: "keep", id: 1 });
    await store.addBlock({ namespace: "acme", id: 3 });
    await store.addBlock({ namespace: "keep", id: 3 });
    await store.recordRequest({ namespace: "acme", user: { id: 2, first_name: "B" } });

    assert.equal(await store.deleteNamespace("acme"), true);
    assert.equal(await store.deleteNamespace("acme"), false);
    assert.equal(await store.getNamespace("acme"), null);

    await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme again" });
    assert.deepEqual(await store.listGrants("acme"), []);
    assert.deepEqual(await store.listBlocks("acme"), [], "a re-registered site does not inherit the old ban list");
    assert.deepEqual(await store.listRequests("acme"), []);
    assert.equal((await store.access("keep", 1)).granted, true, "other sites are untouched");
    assert.equal((await store.access("keep", 3)).blocked, true);
  });

  t("listing sites reports user and request counts, ordered by name", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "b-site", origins: ["https://b-site.example"], name: "bravo" });
    await store.createNamespace({ namespace: "a-site", origins: ["https://a-site.example"], name: "Alpha" });
    await store.addGrant({ namespace: "a-site", id: 1 });
    await store.addGrant({ namespace: "a-site", id: 2 });
    await store.recordRequest({ namespace: "a-site", user: { id: 3 } });

    const sites = await store.listNamespaces();
    assert.deepEqual(sites.map((s) => s.namespace), ["a-site", "b-site"]);
    assert.deepEqual([sites[0].users, sites[0].requests, sites[1].users, sites[1].requests], [2, 1, 0, 0]);
  });

  t("super admins add once and remove once", async (make) => {
    const store = make();
    assert.equal(await store.isAdmin(5), false);
    assert.equal(await store.addAdmin({ id: 5, label: "Eve", addedBy: 1 }), true);
    assert.equal(await store.addAdmin({ id: 5, label: "dup" }), false);
    assert.equal(await store.isAdmin(5), true);
    assert.equal(await store.isAdmin("5"), true, "ids may arrive as strings");
    assert.deepEqual((await store.listAdmins()).map((a) => [a.id, a.label, a.addedBy]), [[5, "Eve", 1]]);
    assert.equal(await store.removeAdmin(5), true);
    assert.equal(await store.removeAdmin(5), false);
    assert.equal(await store.isAdmin(5), false);
  });

  t("a refused scan is recorded once per person and counted", async (make) => {
    const store = make();
    await store.recordRequest({ namespace: "acme", user: { id: 7, first_name: "Old", username: "old" } });
    await store.recordRequest({ namespace: "acme", user: { id: 7, first_name: "New", last_name: "Name", username: "new" } });
    const list = await store.listRequests("acme");
    assert.equal(list.length, 1);
    assert.deepEqual(
      { id: list[0].id, firstName: list[0].firstName, lastName: list[0].lastName, username: list[0].username, attempts: list[0].attempts },
      { id: 7, firstName: "New", lastName: "Name", username: "new", attempts: 2 }
    );
    assert.deepEqual(await store.getRequest("acme", 7), list[0]);
    assert.equal(await store.getRequest("acme", 8), null);
    assert.equal(await store.removeRequest("acme", 7), true);
    assert.equal(await store.removeRequest("acme", 7), false);
  });

  t("requests are capped per site, keeping the most recent", async (make) => {
    const store = make({ requestCap: 3 });
    for (let id = 1; id <= 6; id++) await store.recordRequest({ namespace: "acme", user: { id } });
    await store.recordRequest({ namespace: "other", user: { id: 1 } });
    const ids = (await store.listRequests("acme")).map((r) => r.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [4, 5, 6]);
    assert.equal((await store.listRequests("other")).length, 1, "the cap is per site");
  });

  t("the audit log lists newest first and keeps only the most recent entries", async (make) => {
    const store = make({ auditKeep: 3 });
    for (let n = 1; n <= 5; n++) await store.appendAudit({ actor: 1, action: `act.${n}`, target: "t", detail: `d${n}` });
    const log = await store.listAudit();
    assert.deepEqual(log.map((e) => e.action), ["act.5", "act.4", "act.3"]);
    assert.deepEqual({ actor: log[0].actor, target: log[0].target, detail: log[0].detail }, { actor: 1, target: "t", detail: "d5" });
    assert.equal((await store.listAudit({ limit: 1 })).length, 1);
  });

  t("a site cannot be created without a valid origin, and nothing is created when it is refused", async (make) => {
    const store = make();
    for (const origins of [undefined, null, [], "https://acme.example", [""], ["acme.example"], ["http://acme.example"], ["ftp://acme.example"], ["javascript:alert(1)"], ["https://u:p@acme.example"], ["https://ok.example", "nope"], [null], Array.from({ length: 11 }, (_, n) => `https://s${n}.example`)]) {
      await assert.rejects(store.createNamespace({ namespace: "acme", name: "Acme", origins }), /origin/, JSON.stringify(origins));
    }
    assert.equal(await store.getNamespace("acme"), null);
  });

  t("origins are normalised to scheme + host + port, de-duplicated, and localhost may use http", async (make) => {
    const store = make();
    await store.createNamespace({
      namespace: "acme",
      name: "Acme",
      origins: ["https://Acme.Example.com:443/login?x=1", "https://acme.example.com", " https://acme.example.com:8443/ ", "http://localhost:8787/app", "http://127.0.0.1:3000"],
    });
    assert.deepEqual((await store.getNamespace("acme")).origins, [
      "https://acme.example.com",
      "https://acme.example.com:8443",
      "http://localhost:8787",
      "http://127.0.0.1:3000",
    ]);
    assert.deepEqual((await store.access("acme", 1)).origins, (await store.getNamespace("acme")).origins);
    assert.deepEqual((await store.listNamespaces())[0].origins, (await store.getNamespace("acme")).origins);
  });

  t("origins can be added and removed, never duplicated, and a site never loses its last one", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme", origins: ["https://acme.example"] });
    assert.equal(await store.addOrigin("acme", "https://acme.workers.dev/some/path"), true);
    assert.equal(await store.addOrigin("acme", "HTTPS://ACME.workers.dev"), false, "the same origin, however it is written");
    assert.deepEqual((await store.getNamespace("acme")).origins, ["https://acme.example", "https://acme.workers.dev"]);

    assert.equal(await store.removeOrigin("acme", "https://nope.example"), false);
    assert.equal(await store.removeOrigin("acme", "not a url"), false);
    assert.equal(await store.removeOrigin("acme", "https://acme.workers.dev/ignored-path"), true);
    assert.equal(await store.removeOrigin("acme", "https://acme.example"), false, "the last origin stays");
    assert.deepEqual((await store.getNamespace("acme")).origins, ["https://acme.example"]);

    assert.equal(await store.addOrigin("ghost", "https://ghost.example"), false, "a site that does not exist cannot be given origins");
    assert.equal(await store.getNamespace("ghost"), null);
    assert.equal(await store.removeOrigin("ghost", "https://ghost.example"), false);
  });

  t("adding an invalid origin throws, and so does going past the limit", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme", origins: ["https://acme.example"] });
    for (const bad of ["acme.example", "http://acme.example", "ftp://x.example", "", null, "https://u:p@x.example"]) {
      await assert.rejects(store.addOrigin("acme", bad), /origin must be/, String(bad));
    }
    for (let n = 1; n < 10; n++) await store.addOrigin("acme", `https://s${n}.example`);
    await assert.rejects(store.addOrigin("acme", "https://one-too-many.example"), /at most 10/);
    assert.equal((await store.getNamespace("acme")).origins.length, 10);
  });

  t("edits made at the same moment are not lost", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme", origins: ["https://acme.example"] });
    const added = await Promise.all(["a", "b", "c", "d", "e"].map((n) => store.addOrigin("acme", `https://${n}.example`)));
    assert.deepEqual(added, [true, true, true, true, true]);
    assert.deepEqual((await store.getNamespace("acme")).origins.sort(), ["https://a.example", "https://acme.example", "https://b.example", "https://c.example", "https://d.example", "https://e.example"]);
  });

  t("renaming, switching off and changing the mode leave the origins alone", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme", origins: ["https://acme.example"] });
    await store.updateNamespace("acme", { name: "New", enabled: false, access: "anyone" });
    assert.deepEqual((await store.getNamespace("acme")).origins, ["https://acme.example"]);
  });

  t("a returned origins list is a copy: changing it does not change the site", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme", origins: ["https://acme.example"] });
    (await store.getNamespace("acme")).origins.push("https://evil.example");
    (await store.access("acme", 1)).origins.push("https://evil.example");
    (await store.listNamespaces())[0].origins.push("https://evil.example");
    assert.deepEqual((await store.getNamespace("acme")).origins, ["https://acme.example"]);
  });
}

test("D1HubStore refuses a table prefix that is not a plain identifier", () => {
  assert.throws(() => new D1HubStore(makeFakeD1({ sql: "hub-d1.sql" }), { prefix: "x; DROP TABLE y;--" }), /unsafe/);
  assert.throws(() => new D1HubStore(null), /binding/);
});

test("D1HubStore honours a custom prefix", async () => {
  const db = makeFakeD1({ sql: "hub-d1.sql" });
  db.sqlite.exec(`ALTER TABLE hub_namespaces RENAME TO site_namespaces;
                  ALTER TABLE hub_grants RENAME TO site_grants;
                  ALTER TABLE hub_blocks RENAME TO site_blocks;
                  ALTER TABLE hub_requests RENAME TO site_requests;
                  ALTER TABLE hub_admins RENAME TO site_admins;
                  ALTER TABLE hub_audit RENAME TO site_audit;`);
  const store = new D1HubStore(db, { prefix: "site_" });
  await store.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme" });
  await store.addGrant({ namespace: "acme", id: 1 });
  await store.addBlock({ namespace: "acme", id: 2 });
  assert.equal((await store.access("acme", 1)).granted, true);
  assert.equal((await store.access("acme", 2)).blocked, true);
});

// The hub schema as first released: no `access` column, no hub_blocks table.
const SCHEMA_BEFORE_OPEN_ACCESS = `
  CREATE TABLE hub_namespaces (namespace TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, created_by INTEGER);
  CREATE TABLE hub_admins (telegram_id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT '', added_by INTEGER, added_at INTEGER NOT NULL);
  CREATE TABLE hub_grants (namespace TEXT NOT NULL, telegram_id INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '', added_by INTEGER, added_at INTEGER NOT NULL, PRIMARY KEY (namespace, telegram_id));
  CREATE TABLE hub_requests (namespace TEXT NOT NULL, telegram_id INTEGER NOT NULL, first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (namespace, telegram_id));
  CREATE TABLE hub_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor INTEGER, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
`;

test("the upgrade script brings a database from before open access up to date without changing anyone's access", async () => {
  const { readFileSync } = await import("node:fs");
  const upgradeAccess = readFileSync(new URL("../migrations/hub-d1-upgrade-access.sql", import.meta.url), "utf8");
  const upgradeOrigins = readFileSync(new URL("../migrations/hub-d1-upgrade-origins.sql", import.meta.url), "utf8");

  const db = makeFakeD1({ schema: SCHEMA_BEFORE_OPEN_ACCESS });
  db.sqlite.exec(`INSERT INTO hub_namespaces VALUES ('acme', 'Acme', 1, 100, 1);
                  INSERT INTO hub_namespaces VALUES ('off', 'Off', 0, 100, 1);
                  INSERT INTO hub_grants VALUES ('acme', 111, 'Alice', 1, 100);`);

  db.sqlite.exec(upgradeAccess);
  db.sqlite.exec(upgradeOrigins);
  const store = new D1HubStore(db);

  assert.deepEqual(await store.access("acme", 111), { exists: true, enabled: true, mode: "granted", origins: [], granted: true, blocked: false });
  assert.deepEqual(await store.access("acme", 222), { exists: true, enabled: true, mode: "granted", origins: [], granted: false, blocked: false });
  assert.equal((await store.getNamespace("off")).enabled, false, "a switched-off site stays off");
  assert.deepEqual((await store.listNamespaces()).map((s) => [s.namespace, s.access, s.users]), [["acme", "granted", 1], ["off", "granted", 0]]);

  // The new features work on the upgraded database.
  await store.updateNamespace("acme", { access: "anyone" });
  await store.addBlock({ namespace: "acme", id: 9 });
  assert.deepEqual([(await store.access("acme", 9)).mode, (await store.access("acme", 9)).blocked], ["anyone", true]);

  // A legacy site is unbound until someone binds it, and then it cannot be unbound again.
  assert.equal(await store.addOrigin("acme", "https://acme.example/some/path"), true);
  assert.deepEqual((await store.access("acme", 111)).origins, ["https://acme.example"]);
  assert.equal(await store.removeOrigin("acme", "https://acme.example"), false, "the last origin stays");

  assert.throws(() => db.sqlite.exec(upgradeAccess), /duplicate column/, "a second run fails loudly instead of half-applying");
  assert.throws(() => db.sqlite.exec(upgradeOrigins), /duplicate column/);
});

test("the database refuses an access value the code never writes", () => {
  const db = makeFakeD1({ sql: "hub-d1.sql" });
  assert.throws(() => db.sqlite.exec("INSERT INTO hub_namespaces (namespace, name, access, created_at) VALUES ('x', 'x', 'public', 1)"), /CHECK/);
});

test("D1HubStore: a damaged origins value shuts the site instead of unbinding it, and adding an origin repairs it", async () => {
  const db = makeFakeD1({ sql: "hub-d1.sql" });
  const store = new D1HubStore(db);
  await store.createNamespace({ namespace: "acme", name: "Acme", origins: ["https://acme.example"] });

  for (const damaged of ["garbage", "{}", '["not an origin"]', '[1, 2]', "null"]) {
    db.sqlite.exec(`UPDATE hub_namespaces SET origins = '${damaged.replace(/'/g, "''")}' WHERE namespace = 'acme'`);
    const origins = (await store.access("acme", 1)).origins;
    assert.deepEqual(origins, ["(unreadable)"], damaged);
    assert.deepEqual((await store.getNamespace("acme")).origins, ["(unreadable)"], damaged);
  }
  // An empty list is the legitimate legacy state, and stays that.
  db.sqlite.exec("UPDATE hub_namespaces SET origins = '[]' WHERE namespace = 'acme'");
  assert.deepEqual((await store.access("acme", 1)).origins, []);

  db.sqlite.exec("UPDATE hub_namespaces SET origins = 'garbage' WHERE namespace = 'acme'");
  assert.equal(await store.addOrigin("acme", "https://acme.example"), true);
  assert.deepEqual((await store.getNamespace("acme")).origins, ["https://acme.example"]);
});

test("D1HubStore: deleting a site switches it off first, so an interrupted delete cannot leave it open", async () => {
  const db = makeFakeD1({ sql: "hub-d1.sql" });
  const store = new D1HubStore(db);
  await store.createNamespace({ namespace: "forum", name: "Forum", origins: ["https://forum.example"], access: "anyone" });
  await store.addGrant({ namespace: "forum", id: 1 });

  // Make the cleanup fail partway, the way a dropped connection would.
  const real = db.prepare.bind(db);
  db.prepare = (query) => {
    if (/DELETE FROM hub_requests/.test(query)) throw new Error("connection lost");
    return real(query);
  };
  await assert.rejects(store.deleteNamespace("forum"), /connection lost/);
  db.prepare = real;

  const state = await store.access("forum", 999);
  assert.equal(state.exists, true, "the site is still there, half removed");
  assert.equal(state.enabled, false, "but it is off, so nobody can use it");
});
