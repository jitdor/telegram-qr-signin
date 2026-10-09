// The three access modes, and what makes "approval required" a registration flow rather than a
// refusal: the scan is recorded, the super admins are told, and the person is told when they are in.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { hubGate } from "../src/hub/gates.js";
import { MemoryHubStore } from "../src/hub/store.js";
import { D1HubStore } from "../src/hub/d1-store.js";
import { ACCESS_MODES } from "../src/hub/validate.js";
import { makeFakeD1, makeRequest, cookieFrom } from "./helpers.mjs";
import { ROOT, ADMIN2, ALICE, BOB, MALLORY, makeHub, makeSite, login, startUpdate, webhookRequest, signInToConsole, get, post, redirectTarget } from "./hub-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_TOKEN = "0123456789abcdef0123456789abcdef";

async function setup({ mode = "approval", config } = {}) {
  const ctx = makeHub({ config });
  await ctx.registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "The forum", access: mode });
  ctx.site = makeSite(ctx, "forum");
  return ctx;
}

/** Mints a QR on the site and scans it as `user` through the hub's webhook. */
async function scan(ctx, user) {
  const { token } = await login(ctx.site);
  const response = await ctx.hub.webhook(webhookRequest(startUpdate(`/start forum_${token}`, user)));
  assert.equal(response.status, 200);
  return token;
}

const messagesTo = (ctx, id) => ctx.telegram.calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === id).map((c) => c.payload.text);

test("there are three access modes, and invite only stays the default", () => {
  assert.deepEqual(ACCESS_MODES, ["granted", "approval", "anyone"]);
});

// --- Invite only: refuse, record nothing ------------------------------------------------------

test("invite only turns a stranger away with their id, and keeps no request and tells no admin", async () => {
  const ctx = await setup({ mode: "granted" });
  await scan(ctx, MALLORY);

  assert.match(messagesTo(ctx, MALLORY.id).at(-1), new RegExp(`Your Telegram ID is ${MALLORY.id}`));
  assert.doesNotMatch(messagesTo(ctx, MALLORY.id).at(-1), /request/i, "nothing was requested, so the reply does not say so");
  assert.deepEqual(await ctx.registry.listRequests("forum"), []);
  assert.deepEqual(messagesTo(ctx, ROOT.id), [], "no admin is bothered by a stranger on an invite-only site");
});

// --- Approval required: the scan is the registration ------------------------------------------

test("approval required: the first scan registers, tells the person, and tells the super admins once", async () => {
  const ctx = await setup();
  await scan(ctx, MALLORY);

  const [request] = await ctx.registry.listRequests("forum");
  assert.deepEqual([request.id, request.username, request.attempts], [MALLORY.id, "mal", 1]);
  assert.match(messagesTo(ctx, MALLORY.id).at(-1), /Request received.*The forum.*once you're approved/s);

  const [notice, ...more] = messagesTo(ctx, ROOT.id);
  assert.equal(more.length, 0);
  assert.match(notice, /Mallory \(@mal\) is asking to join The forum/);
  assert.match(notice, new RegExp(`Telegram id: ${MALLORY.id}`));
  assert.match(notice, /Review: https:\/\/hub\.example\/admin\/ns\/forum#waiting/, "the link is where Telegram called the webhook");
});

test("a second scan by the same person says they are still waiting and does not message the admins again", async () => {
  const ctx = await setup();
  await scan(ctx, MALLORY);
  await scan(ctx, MALLORY);

  assert.equal((await ctx.registry.getRequest("forum", MALLORY.id)).attempts, 2);
  assert.match(messagesTo(ctx, MALLORY.id).at(-1), /still waiting for approval/);
  assert.equal(messagesTo(ctx, ROOT.id).length, 1);
});

test("a made-up payload is refused without a request, an admin message, or a claim that one was made", async () => {
  const ctx = await setup();
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start forum_${FAKE_TOKEN}`, BOB)));

  assert.deepEqual(await ctx.registry.listRequests("forum"), []);
  assert.deepEqual(messagesTo(ctx, ROOT.id), []);
  assert.doesNotMatch(messagesTo(ctx, BOB.id).join("\n"), /Request received/);
});

test("a blocked person is refused as blocked, not registered", async () => {
  const ctx = await setup();
  await ctx.registry.addBlock({ namespace: "forum", id: MALLORY.id });
  await scan(ctx, MALLORY);

  assert.match(messagesTo(ctx, MALLORY.id).at(-1), /can't sign in/);
  assert.deepEqual(await ctx.registry.listRequests("forum"), []);
  assert.deepEqual(messagesTo(ctx, ROOT.id), []);
});

test("approval end to end: scan, wait, get approved and told, scan again, signed in", async () => {
  const ctx = await setup();
  const cookie = await signInToConsole(ctx.hub, ROOT);

  const first = await scan(ctx, MALLORY);
  const waiting = await ctx.site.poll(makeRequest(`https://forum.example/auth/poll?token=${first}`));
  assert.equal((await waiting.json()).status, "pending", "the browser keeps waiting: nothing was confirmed");

  const approved = await post(ctx.hub, `/admin/ns/forum/requests/${MALLORY.id}/approve`, {}, { cookie });
  assert.equal(redirectTarget(approved).searchParams.get("ok"), "request_approved");
  assert.match(messagesTo(ctx, MALLORY.id).at(-1), /approved for The forum.*https:\/\/forum\.example/s);

  const second = await scan(ctx, MALLORY);
  const polled = await ctx.site.poll(makeRequest(`https://forum.example/auth/poll?token=${second}`));
  assert.equal((await polled.json()).status, "confirmed");
  assert.ok(cookieFrom(polled, ctx.site.cookieName));
});

// --- Telling the admins ------------------------------------------------------------------------

test("every super admin is told, bootstrap and console-added alike, but not the person asking", async () => {
  const ctx = await setup();
  await ctx.registry.addAdmin({ id: ADMIN2.id });
  await ctx.registry.addAdmin({ id: MALLORY.id }); // an admin asking to join a site needs no announcement to themselves
  await scan(ctx, MALLORY);

  assert.equal(messagesTo(ctx, ROOT.id).length, 1);
  assert.equal(messagesTo(ctx, ADMIN2.id).length, 1);
  assert.ok(!messagesTo(ctx, MALLORY.id).some((text) => /is asking to join/.test(text)));
});

test("a flood of strangers costs the admins six messages an hour per site, not one per stranger", async () => {
  const ctx = await setup();
  for (let n = 1; n <= 9; n++) await scan(ctx, { id: 5000 + n, first_name: `Person${n}` });

  const notices = messagesTo(ctx, ROOT.id);
  assert.equal(notices.length, 6);
  assert.match(notices[4], /Person5/);
  assert.match(notices[5], /More people are asking to join The forum/);
  assert.equal((await ctx.registry.listRequests("forum")).length, 9, "every one of them is still in the queue");
});

test("the notice link uses adminUrl when it is configured", async () => {
  const ctx = await setup({ config: { adminUrl: "https://console.example/admin/" } });
  await scan(ctx, MALLORY);
  assert.match(messagesTo(ctx, ROOT.id)[0], /Review: https:\/\/console\.example\/admin\/ns\/forum#waiting/);
});

test("with no adminUrl and no webhook call to learn the address from, the notice simply has no link", async () => {
  const ctx = await setup();
  const { token } = await login(ctx.site);
  await ctx.hub.handleUpdate(startUpdate(`/start forum_${token}`, MALLORY)); // not through the webhook
  const [notice] = messagesTo(ctx, ROOT.id);
  assert.match(notice, /is asking to join/);
  assert.doesNotMatch(notice, /Review:/);
});

test("an admin who cannot be reached does not stop the person getting their reply or the request being kept", async () => {
  const ctx = await setup();
  const call = ctx.telegram.call.bind(ctx.telegram);
  ctx.telegram.call = async (method, payload) => {
    if (method === "sendMessage" && payload.chat_id === ROOT.id) throw new Error("Forbidden: bot was blocked by the user");
    return call(method, payload);
  };
  await scan(ctx, MALLORY);

  assert.match(messagesTo(ctx, MALLORY.id).at(-1), /Request received/);
  assert.equal((await ctx.registry.listRequests("forum")).length, 1);
  assert.ok(ctx.errors.some((e) => /blocked by the user/.test(e.message)), "reported through onError");
});

// --- Telling the person ------------------------------------------------------------------------

test("approving someone the bot cannot message still approves them, and says to tell them yourself", async () => {
  const ctx = await setup();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  await scan(ctx, MALLORY);
  const call = ctx.telegram.call.bind(ctx.telegram);
  ctx.telegram.call = async (method, payload) => {
    if (method === "sendMessage" && payload.chat_id === MALLORY.id) throw new Error("Forbidden");
    return call(method, payload);
  };

  const approved = await post(ctx.hub, `/admin/ns/forum/requests/${MALLORY.id}/approve`, {}, { cookie });
  assert.equal(redirectTarget(approved).searchParams.get("ok"), "request_approved_unnotified");
  assert.equal((await ctx.registry.access("forum", MALLORY.id)).granted, true);
});

test("granting by id someone who is waiting approves them: the request goes and they are told", async () => {
  const ctx = await setup();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  await scan(ctx, MALLORY);

  await post(ctx.hub, "/admin/ns/forum/grants", { ids: `${MALLORY.id}, ${BOB.id}` }, { cookie });
  assert.deepEqual(await ctx.registry.listRequests("forum"), []);
  assert.match(messagesTo(ctx, MALLORY.id).at(-1), /approved for The forum/);
  assert.deepEqual(messagesTo(ctx, BOB.id), [], "someone who never asked is not messaged out of the blue");
});

test("dismissing or blocking a request tells the person nothing", async () => {
  const ctx = await setup();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  await scan(ctx, MALLORY);
  await scan(ctx, BOB);
  const before = (id) => messagesTo(ctx, id).length;
  const [m, b] = [before(MALLORY.id), before(BOB.id)];

  await post(ctx.hub, `/admin/ns/forum/requests/${MALLORY.id}/dismiss`, {}, { cookie });
  await post(ctx.hub, `/admin/ns/forum/requests/${BOB.id}/block`, {}, { cookie });
  assert.equal(before(MALLORY.id), m);
  assert.equal(before(BOB.id), b);
});

// --- Console -----------------------------------------------------------------------------------

test("switching between the three modes is audited, and the notice says what each now means", async () => {
  const ctx = await setup({ mode: "granted" });
  const cookie = await signInToConsole(ctx.hub, ROOT);

  const toApproval = await post(ctx.hub, "/admin/ns/forum/access", { mode: "approval" }, { cookie });
  assert.equal(redirectTarget(toApproval).searchParams.get("ok"), "access_approval");
  const html = await (await get(ctx.hub, "/admin/ns/forum", cookie)).text();
  assert.match(html, /Who can sign in <span class="pill">Approval required<\/span>/);
  assert.match(html, /Switch to invite only/);
  assert.match(html, /Open to anyone<\/button>/);
  assert.doesNotMatch(html, /Switch to approval required/, "the current mode has no button");

  const toInvite = await post(ctx.hub, "/admin/ns/forum/access", { mode: "granted" }, { cookie });
  assert.equal(redirectTarget(toInvite).searchParams.get("ok"), "access_granted");
  assert.deepEqual((await ctx.registry.listAudit()).slice(0, 2).map((e) => e.detail), ["approval -> granted", "granted -> approval"]);
});

test("switching to invite only hides the queue and stops recording, and switching back brings it back", async () => {
  const ctx = await setup();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  await scan(ctx, MALLORY);
  const page = async () => (await get(ctx.hub, "/admin/ns/forum", cookie)).text();
  assert.match(await page(), /Waiting for approval/);

  await post(ctx.hub, "/admin/ns/forum/access", { mode: "granted" }, { cookie });
  assert.doesNotMatch(await page(), /Waiting for approval/);
  await scan(ctx, BOB);
  assert.deepEqual((await ctx.registry.listRequests("forum")).map((r) => r.id), [MALLORY.id], "Bob was turned away, not registered");
  const overview = await (await get(ctx.hub, "/admin", cookie)).text();
  assert.match(overview, /<span class="pill">Invite only<\/span>/);

  await post(ctx.hub, "/admin/ns/forum/access", { mode: "approval" }, { cookie });
  assert.match(await page(), /Mallory/);
});

test("the overview badges each site with its mode and shows a queue count only for approval sites", async () => {
  const ctx = makeHub();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  for (const [ns, mode] of [["a", "granted"], ["b", "approval"], ["c", "anyone"]]) {
    await ctx.registry.createNamespace({ namespace: ns, origins: [`https://${ns}.example`], name: ns.toUpperCase(), access: mode });
  }
  const html = await (await get(ctx.hub, "/admin", cookie)).text();
  assert.match(html, /<span class="pill">Invite only<\/span>/);
  assert.match(html, /<span class="pill">Approval required<\/span>/);
  assert.match(html, /<span class="pill warn">Anyone with Telegram<\/span>/);
  assert.equal((html.match(/<small>waiting<\/small>/g) ?? []).length, 1, "only the approval site has a waiting count");
});

// --- The gate itself, for sites that run their own -------------------------------------------

test("hubGate: approval says pending_approval, and only a scan is written down and reported", async () => {
  const registry = new MemoryHubStore();
  await registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "Forum", access: "approval" });
  const seen = [];
  const gate = hubGate({ registry, namespace: "forum", onRequest: (r) => seen.push(r) });

  assert.deepEqual(await gate(MALLORY, { stage: "session" }), { ok: false, reason: "pending_approval", requested: false });
  assert.deepEqual(seen, []);
  assert.deepEqual(await gate(MALLORY, { stage: "confirm" }), { ok: false, reason: "pending_approval", requested: true });
  assert.deepEqual(await gate(MALLORY, { stage: "confirm" }), { ok: false, reason: "pending_approval", requested: true });
  assert.deepEqual(seen.map((r) => [r.isNew, r.attempts]), [[true, 1], [false, 2]]);
});

test("hubGate: invite only says not_granted and writes nothing, even for a scan", async () => {
  const registry = new MemoryHubStore();
  await registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "Forum" });
  const seen = [];
  const gate = hubGate({ registry, namespace: "forum", onRequest: (r) => seen.push(r) });
  assert.deepEqual(await gate(MALLORY, { stage: "confirm" }), { ok: false, reason: "not_granted" });
  assert.deepEqual(await registry.listRequests("forum"), []);
  assert.deepEqual(seen, []);
});

test("hubGate: a request that cannot be written is still a refusal, and says it was not recorded", async () => {
  const registry = new MemoryHubStore();
  await registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "Forum", access: "approval" });
  registry.recordRequest = async () => {
    throw new Error("disk full");
  };
  const errors = [];
  const gate = hubGate({ registry, namespace: "forum", onError: (e) => errors.push(e) });
  assert.deepEqual(await gate(MALLORY, { stage: "confirm" }), { ok: false, reason: "pending_approval", requested: false });
  assert.equal(errors.length, 1);
});

// --- Stores and schema -------------------------------------------------------------------------

for (const [kind, make] of Object.entries({
  memory: () => new MemoryHubStore(),
  d1: () => new D1HubStore(makeFakeD1({ sql: "hub-d1.sql" })),
})) {
  test(`[${kind}] recordRequest reports whether the person is new and how many times they have asked`, async () => {
    const store = make();
    assert.deepEqual(await store.recordRequest({ namespace: "forum", user: MALLORY }), { isNew: true, attempts: 1 });
    assert.deepEqual(await store.recordRequest({ namespace: "forum", user: MALLORY }), { isNew: false, attempts: 2 });
    assert.deepEqual(await store.recordRequest({ namespace: "other", user: MALLORY }), { isNew: true, attempts: 1 }, "per site");
    await store.removeRequest("forum", MALLORY.id);
    assert.deepEqual(await store.recordRequest({ namespace: "forum", user: MALLORY }), { isNew: true, attempts: 1 }, "dismissed, then asking again, is a new request");
  });

  test(`[${kind}] a site can be created in, and switched to, each of the three modes; anything else is refused`, async () => {
    const store = make();
    for (const mode of ACCESS_MODES) {
      await store.createNamespace({ namespace: `s-${mode}`, origins: [`https://${mode}.example`], name: mode, access: mode });
      assert.equal((await store.getNamespace(`s-${mode}`)).access, mode);
      assert.equal((await store.access(`s-${mode}`, 1)).mode, mode);
    }
    await assert.rejects(store.updateNamespace("s-granted", { access: "everyone" }), /access must be one of/);
    await assert.rejects(store.createNamespace({ namespace: "bad", origins: ["https://bad.example"], name: "x", access: "open" }), /access must be one of/);
  });
}

test("the schema itself refuses a mode it does not know", () => {
  const db = makeFakeD1({ sql: "hub-d1.sql" });
  const insert = (access) =>
    db.sqlite.prepare("INSERT INTO hub_namespaces (namespace, name, access, origins, created_at) VALUES (?, 'n', ?, '[\"https://a.example\"]', 1)").run(`ns-${access}`, access);
  for (const mode of ACCESS_MODES) insert(mode);
  assert.throws(() => insert("everyone"), /CHECK/);
});

test("the 1.1 upgrade rebuilds an old database: rows kept, approval allowed, invite-only sites keep their queue as approval", async () => {
  const current = readFileSync(join(__dirname, "..", "migrations", "hub-d1.sql"), "utf8");
  const old = current.replace("('granted', 'approval', 'anyone')", "('granted', 'anyone')");
  assert.notEqual(old, current, "the old schema differs from the new one in exactly the CHECK");
  const db = makeFakeD1({ schema: old });
  const insert = db.sqlite.prepare("INSERT INTO hub_namespaces (namespace, name, enabled, access, origins, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("acme", "Acme", 1, "granted", '["https://acme.example"]', 100, 7);
  insert.run("forum", "Forum", 0, "anyone", '["https://forum.example","https://f.example"]', 200, null);
  assert.throws(() => insert.run("x", "X", 1, "approval", '["https://x.example"]', 1, null), /CHECK/, "the old database cannot hold the new mode");

  db.sqlite.exec(readFileSync(join(__dirname, "..", "migrations", "hub-d1-upgrade-1.1.sql"), "utf8"));

  const rows = db.sqlite.prepare("SELECT namespace, name, enabled, access, origins, created_at, created_by FROM hub_namespaces ORDER BY namespace").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { namespace: "acme", name: "Acme", enabled: 1, access: "approval", origins: '["https://acme.example"]', created_at: 100, created_by: 7 },
    { namespace: "forum", name: "Forum", enabled: 0, access: "anyone", origins: '["https://forum.example","https://f.example"]', created_at: 200, created_by: null },
  ]);
  assert.equal(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'hub_namespaces_before_approval'").get(), undefined, "no stray table is left");
  insert.run("fresh", "Fresh", 1, "approval", '["https://fresh.example"]', 300, null);
  assert.throws(() => insert.run("nope", "N", 1, "approval", "[]", 1, null), /CHECK/, "the origins rule survived the rebuild");

  const store = new D1HubStore(db);
  assert.equal((await store.namespacesForOrigin("https://f.example"))[0], "forum", "and the store reads the rebuilt table");
});
