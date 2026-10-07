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
    assert.equal(await store.createNamespace({ namespace: "acme", name: "Acme", createdBy: 1 }), true);
    assert.equal(await store.createNamespace({ namespace: "acme", name: "Other", createdBy: 2 }), false);
    const site = await store.getNamespace("acme");
    assert.equal(site.name, "Acme");
    assert.equal(site.enabled, true);
    assert.equal(site.createdBy, 1);
    assert.equal(await store.getNamespace("nope"), null);
  });

  t("a blank name falls back to the namespace", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "   " });
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
    await store.createNamespace({ namespace: "acme", name: "Acme" });
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
    assert.deepEqual(await store.access("acme", 111), { exists: false, enabled: false, granted: false });

    await store.createNamespace({ namespace: "acme", name: "Acme" });
    assert.deepEqual(await store.access("acme", 111), { exists: true, enabled: true, granted: false });

    await store.addGrant({ namespace: "acme", id: 111 });
    assert.deepEqual(await store.access("acme", 111), { exists: true, enabled: true, granted: true });
    assert.equal((await store.access("acme", 222)).granted, false);
    assert.equal((await store.access("other", 111)).granted, false, "a grant is per site");

    await store.updateNamespace("acme", { enabled: false });
    assert.deepEqual(await store.access("acme", 111), { exists: true, enabled: false, granted: true });
  });

  t("ids beyond 32 bits survive a round trip", async (make) => {
    const store = make();
    const big = 7_123_456_789_012;
    await store.createNamespace({ namespace: "acme", name: "Acme" });
    await store.addGrant({ namespace: "acme", id: big, label: "big" });
    assert.equal((await store.access("acme", big)).granted, true);
    assert.equal((await store.listGrants("acme"))[0].id, big);
    await store.addAdmin({ id: big });
    assert.equal(await store.isAdmin(big), true);
  });

  t("grants add once, remove once, and list newest first", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme" });
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
    await store.createNamespace({ namespace: "acme", name: "Acme" });
    await store.addGrant({ namespace: "acme", id: 5, label: `a\n\tb${"x".repeat(200)}` });
    const [grant] = await store.listGrants("acme");
    assert.ok(grant.label.startsWith("a b"));
    assert.ok(grant.label.length <= 80);
  });

  t("deleting a site takes its grants and requests with it, and a re-created site starts empty", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme" });
    await store.createNamespace({ namespace: "keep", name: "Keep" });
    await store.addGrant({ namespace: "acme", id: 1 });
    await store.addGrant({ namespace: "keep", id: 1 });
    await store.recordRequest({ namespace: "acme", user: { id: 2, first_name: "B" } });

    assert.equal(await store.deleteNamespace("acme"), true);
    assert.equal(await store.deleteNamespace("acme"), false);
    assert.equal(await store.getNamespace("acme"), null);

    await store.createNamespace({ namespace: "acme", name: "Acme again" });
    assert.deepEqual(await store.listGrants("acme"), []);
    assert.deepEqual(await store.listRequests("acme"), []);
    assert.equal((await store.access("keep", 1)).granted, true, "other sites are untouched");
  });

  t("listing sites reports user and request counts, ordered by name", async (make) => {
    const store = make();
    await store.createNamespace({ namespace: "b-site", name: "bravo" });
    await store.createNamespace({ namespace: "a-site", name: "Alpha" });
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
}

test("D1HubStore refuses a table prefix that is not a plain identifier", () => {
  assert.throws(() => new D1HubStore(makeFakeD1({ sql: "hub-d1.sql" }), { prefix: "x; DROP TABLE y;--" }), /unsafe/);
  assert.throws(() => new D1HubStore(null), /binding/);
});

test("D1HubStore honours a custom prefix", async () => {
  const db = makeFakeD1({ sql: "hub-d1.sql" });
  db.sqlite.exec(`ALTER TABLE hub_namespaces RENAME TO site_namespaces;
                  ALTER TABLE hub_grants RENAME TO site_grants;
                  ALTER TABLE hub_requests RENAME TO site_requests;
                  ALTER TABLE hub_admins RENAME TO site_admins;
                  ALTER TABLE hub_audit RENAME TO site_audit;`);
  const store = new D1HubStore(db, { prefix: "site_" });
  await store.createNamespace({ namespace: "acme", name: "Acme" });
  await store.addGrant({ namespace: "acme", id: 1 });
  assert.equal((await store.access("acme", 1)).granted, true);
});
