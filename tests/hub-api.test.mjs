// The hub's HTTP API, called the way a site's code calls it: bearer key, JSON, nothing shared.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createHub } from "../src/hub/hub.js";
import { MemoryHubStore } from "../src/hub/store.js";
import { MemoryLoginStore } from "../src/stores/memory.js";
import { generateSiteKey, hashSiteKey, parseSiteKey } from "../src/hub/validate.js";
import { MAX_LOGIN_TTL_SECONDS } from "../src/hub/api.js";
import { makeFakeTelegram } from "./helpers.mjs";
import { ALICE, BOB, MALLORY, ORIGIN, ROOT, makeHub, startUpdate, webhookRequest } from "./hub-helpers.mjs";

const ACME = "https://acme.example";
const API = `${ORIGIN}/hub-api/v1`;
const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const now = () => Math.floor(Date.now() / 1000);

async function setup() {
  const ctx = makeHub();
  await ctx.registry.createNamespace({ namespace: "acme", name: "Acme", origins: [ACME] });
  await ctx.registry.createNamespace({ namespace: "forum", name: "Forum", origins: ["https://forum.example"], access: "anyone" });
  ctx.keys = {};
  for (const ns of ["acme", "forum"]) {
    ctx.keys[ns] = generateSiteKey(ns);
    await ctx.registry.setSiteKey(ns, await hashSiteKey(ctx.keys[ns]));
  }
  await ctx.registry.addGrant({ namespace: "acme", id: ALICE.id });
  return ctx;
}

/** One API call. `key` is a site's key, or null for none. */
function call(ctx, key, method, path, body, headers = {}) {
  const init = { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  return ctx.hub.fetch(new Request(`${API}${path}`, init));
}
const start = (ctx, over = {}) => call(ctx, ctx.keys.acme, "POST", "/logins", { token: token(), expiresAt: now() + 600, client: { origin: ACME, ip: "1.2.3.4", userAgent: "UA" }, ...over });

// --- Who may call -------------------------------------------------------------------------------

test("every route demands a valid key, and every refusal looks the same", async () => {
  const ctx = await setup();
  const routes = [["GET", "/site"], ["POST", "/logins"], ["GET", `/logins/${token()}`], ["POST", `/logins/${token()}/consume`], ["DELETE", `/logins/${token()}`], ["POST", "/check"], ["POST", "/blocks"], ["DELETE", "/blocks/5"]];
  const wrong = [
    null, // no header at all
    "tqk_acme_" + "0".repeat(64), // right shape, wrong secret
    "tqk_ghost_" + "1".repeat(64), // a site that does not exist
    "nonsense",
    `${ctx.keys.acme}x`,
    ctx.keys.acme.toUpperCase(),
  ];
  const bodies = new Set();
  for (const [method, path] of routes) {
    for (const key of wrong) {
      const response = await call(ctx, key, method, path, method === "POST" ? {} : undefined);
      assert.equal(response.status, 401, `${method} ${path} with ${key}`);
      assert.equal(response.headers.get("WWW-Authenticate"), 'Bearer realm="hub"');
      assert.equal(response.headers.get("Set-Cookie"), null);
      bodies.add(await response.text());
    }
  }
  assert.deepEqual([...bodies], ['{"error":"unauthorized"}'], "nothing says whether the site exists or the secret was close");
});

test("the key is accepted only as a Bearer header", async () => {
  const ctx = await setup();
  for (const headers of [{ Authorization: ctx.keys.acme }, { Authorization: `Basic ${ctx.keys.acme}` }, { "X-Api-Key": ctx.keys.acme }]) {
    assert.equal((await call(ctx, null, "GET", "/site", undefined, headers)).status, 401);
  }
  assert.equal((await call(ctx, null, "GET", "/site", undefined, { Authorization: `bearer ${ctx.keys.acme}` })).status, 200, "the scheme is case-insensitive");
  assert.equal((await ctx.hub.fetch(new Request(`${API}/site?key=${ctx.keys.acme}`))).status, 401, "never from the URL, where it would be logged");
});

test("the registry keeps a hash of each key, never the key", async () => {
  const ctx = await setup();
  const { hash } = await ctx.registry.getSiteKey("acme");
  assert.equal(hash, createHash("sha256").update(ctx.keys.acme).digest("hex"));
  assert.ok(!hash.includes(ctx.keys.acme.slice(-16)));
  assert.deepEqual(parseSiteKey(ctx.keys.acme), { namespace: "acme" });
  assert.equal(parseSiteKey("tqk_a_b"), null);
  assert.equal(parseSiteKey(`tqk_has_underscore_${"0".repeat(64)}`), null);
});

test("an unreadable registry is a 503 with Retry-After, not a 401 that would send an operator hunting for a bad key", async () => {
  const ctx = await setup();
  const quiet = [];
  ctx.registry.getSiteKey = async () => {
    throw new Error("D1 is down");
  };
  const response = await call(ctx, ctx.keys.acme, "GET", "/site");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "5");
  assert.equal(ctx.errors.length, 1, quiet.join());
});

test("paths that are not the API's are not answered by it, and everything it does answer is uncached JSON", async () => {
  const ctx = await setup();
  assert.equal((await ctx.hub.fetch(new Request(`${ORIGIN}/hub-apix/v1/site`))).status, 404);
  for (const response of [await call(ctx, ctx.keys.acme, "GET", "/site"), await call(ctx, null, "GET", "/site"), await call(ctx, ctx.keys.acme, "GET", "/nothing")]) {
    assert.match(response.headers.get("Content-Type"), /^application\/json/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  }
});

test("unknown versions and resources are 404, and the wrong method is 405 naming the right one", async () => {
  const ctx = await setup();
  const k = ctx.keys.acme;
  assert.equal((await call(ctx, k, "GET", "/../v2/site")).status, 404);
  assert.equal((await ctx.hub.fetch(new Request(`${ORIGIN}/hub-api/v2/site`, { headers: { Authorization: `Bearer ${k}` } }))).status, 404);
  assert.equal((await call(ctx, k, "GET", "/admins")).status, 404, "there is no call that reads the admins");
  assert.equal((await call(ctx, k, "GET", "/grants")).status, 404, "or the grants");
  assert.equal((await call(ctx, k, "GET", "/sites")).status, 404, "or other sites");
  for (const [method, path, allow] of [["POST", "/site", "GET"], ["GET", "/logins", "POST"], ["PUT", `/logins/${token()}`, "GET, DELETE"], ["GET", `/logins/${token()}/consume`, "POST"], ["GET", "/check", "POST"], ["GET", "/blocks", "POST"], ["POST", "/blocks/5", "DELETE"]]) {
    const response = await call(ctx, k, method, path);
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.equal(response.headers.get("Allow"), allow);
  }
});

// --- Starting a sign-in -------------------------------------------------------------------------

test("a site starts a sign-in: the hub keeps it under that site, and only the origin and a few facts about the visit", async () => {
  const ctx = await setup();
  const t = token();
  const response = await start(ctx, { token: t, client: { origin: `${ACME}/some/path`, ip: "9.9.9.9", userAgent: "x".repeat(900), at: "now", admin: true, __proto__: { polluted: 1 } } });
  assert.equal(response.status, 201);

  const record = await ctx.store.get(t, "acme");
  assert.equal(record.namespace, "acme", "the site is the key's, never the body's");
  assert.equal(record.status, "pending");
  assert.deepEqual(Object.keys(record.client).sort(), ["at", "ip", "origin", "userAgent"]);
  assert.equal(record.client.origin, ACME);
  assert.equal(record.client.userAgent.length, 300);
  assert.equal(await ctx.store.get(t, "forum"), null);
});

test("a site cannot pick another site's namespace in the body, or hold a sign-in longer than the hub allows", async () => {
  const ctx = await setup();
  const t = token();
  await start(ctx, { token: t, namespace: "forum", expiresAt: now() + 86400 });
  assert.equal(await ctx.store.get(t, "forum"), null);
  const record = await ctx.store.get(t, "acme");
  assert.ok(record.expiresAt <= now() + MAX_LOGIN_TTL_SECONDS && record.expiresAt > now() + MAX_LOGIN_TTL_SECONDS - 5, "clamped to what the hub allows");
});

test("a sign-in is refused if it is malformed, already over, or was not shown at one of the site's URLs", async () => {
  const ctx = await setup();
  const cases = [
    [{ token: "short" }, 400, "bad_token"],
    [{ token: "G".repeat(32) }, 400, "bad_token"],
    [{ expiresAt: "soon" }, 400, "bad_request"],
    [{ expiresAt: 1.5 }, 400, "bad_request"],
    [{ expiresAt: now() - 5 }, 400, "bad_request"],
    [{ client: null }, 403, "origin_not_allowed"],
    [{ client: {} }, 403, "origin_not_allowed"],
    [{ client: { origin: "https://staging.example" } }, 403, "origin_not_allowed"],
    [{ client: { origin: "http://acme.example" } }, 403, "origin_not_allowed"],
    [{ client: { origin: "https://forum.example" } }, 403, "origin_not_allowed"],
  ];
  for (const [over, status, error] of cases) {
    const response = await start(ctx, over);
    assert.equal(response.status, status, JSON.stringify(over));
    assert.equal((await response.json()).error, error, JSON.stringify(over));
  }
  assert.equal((await call(ctx, ctx.keys.acme, "POST", "/logins", "{not json")).status, 400);
  assert.equal((await call(ctx, ctx.keys.acme, "POST", "/logins", "[1,2]")).status, 400);
  assert.equal((await call(ctx, ctx.keys.acme, "POST", "/logins", JSON.stringify({ pad: "x".repeat(5000) }))).status, 413);
});

test("a switched-off site cannot start a sign-in", async () => {
  const ctx = await setup();
  await ctx.registry.updateNamespace("acme", { enabled: false });
  const response = await start(ctx);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "namespace_disabled");
});

// --- Reading, taking and dropping one -----------------------------------------------------------

test("a site reads its sign-in, takes it once when confirmed, and can drop it", async () => {
  const ctx = await setup();
  const t = token();
  await start(ctx, { token: t });
  const read = async () => (await (await call(ctx, ctx.keys.acme, "GET", `/logins/${t}`)).json()).record;
  assert.equal((await read()).status, "pending");

  const notYet = await (await call(ctx, ctx.keys.acme, "POST", `/logins/${t}/consume`)).json();
  assert.equal(notYet.record, null, "nothing to take until the bot has confirmed it");
  assert.equal((await read()).status, "pending");

  await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${t}`, ALICE)));
  assert.equal((await read()).status, "confirmed");
  const taken = await (await call(ctx, ctx.keys.acme, "POST", `/logins/${t}/consume`)).json();
  assert.equal(taken.record.user.id, ALICE.id);
  assert.equal((await (await call(ctx, ctx.keys.acme, "POST", `/logins/${t}/consume`)).json()).record, null, "once");
  assert.equal(await read(), null);

  const t2 = token();
  await start(ctx, { token: t2 });
  assert.equal((await call(ctx, ctx.keys.acme, "DELETE", `/logins/${t2}`)).status, 200);
  assert.equal(await ctx.store.get(t2, "acme"), null);
  assert.equal((await call(ctx, ctx.keys.acme, "GET", "/logins/not-a-token")).status, 400);
});

test("a login store without an atomic consume still works, by reading then removing", async () => {
  const ctx = await setup();
  const real = ctx.store;
  const plain = { create: (r) => real.create(r), get: (t, n) => real.get(t, n), confirm: (...a) => real.confirm(...a), remove: (t, n) => real.remove(t, n) };
  const hub = createHub({
    botUsername: "hub_bot", botToken: "1:T", telegram: makeFakeTelegram(), store: plain, registry: ctx.registry,
    superAdmins: [ROOT.id], sessionSecret: "console-secret-console-secret-00", webhookSecret: "whsec",
  });
  const t = token();
  await hub.fetch(new Request(`${API}/logins`, { method: "POST", headers: { Authorization: `Bearer ${ctx.keys.acme}` }, body: JSON.stringify({ token: t, expiresAt: now() + 60, client: { origin: ACME } }) }));
  await real.confirm(t, "acme", { id: ALICE.id });
  const taken = await (await hub.fetch(new Request(`${API}/logins/${t}/consume`, { method: "POST", headers: { Authorization: `Bearer ${ctx.keys.acme}` } }))).json();
  assert.equal(taken.record.user.id, ALICE.id);
  assert.equal(await real.get(t, "acme"), null);
});

test("a store that fails is a 503 to retry, and is reported", async () => {
  const ctx = await setup();
  ctx.store.get = async () => {
    throw new Error("store down");
  };
  const response = await call(ctx, ctx.keys.acme, "GET", `/logins/${token()}`);
  assert.equal(response.status, 503);
  assert.equal(ctx.errors.length, 1);
});

// --- "May this person come in?" -----------------------------------------------------------------

test("check answers yes, or no with a reason, and a refusal is a normal 200", async () => {
  const ctx = await setup();
  const ask = (user, over = {}) => call(ctx, ctx.keys.acme, "POST", "/check", { user, stage: "session", origin: ACME, ...over }).then((r) => r.json());
  assert.deepEqual(await ask({ id: ALICE.id }), { ok: true });
  assert.deepEqual(await ask({ id: BOB.id }), { ok: false, reason: "not_granted" });
  assert.deepEqual(await ask({ id: ALICE.id }, { origin: "https://staging.example" }), { ok: false, reason: "origin_not_allowed" });
  assert.deepEqual(await ask({ id: ALICE.id }, { origin: undefined }), { ok: false, reason: "origin_not_allowed" });
  await ctx.registry.addBlock({ namespace: "acme", id: ALICE.id });
  assert.deepEqual(await ask({ id: ALICE.id }), { ok: false, reason: "blocked" });
  await ctx.registry.updateNamespace("acme", { enabled: false });
  assert.deepEqual(await ask({ id: ALICE.id }), { ok: false, reason: "namespace_disabled" });
});

test("check is about the site whose key is used, whatever the body says", async () => {
  const ctx = await setup();
  const asForum = await (await call(ctx, ctx.keys.forum, "POST", "/check", { user: { id: BOB.id }, stage: "poll", origin: "https://forum.example", namespace: "acme" })).json();
  assert.deepEqual(asForum, { ok: true }, "the forum is open to anyone");
  const forumKeyAtAcme = await (await call(ctx, ctx.keys.forum, "POST", "/check", { user: { id: BOB.id }, stage: "poll", origin: ACME })).json();
  assert.deepEqual(forumKeyAtAcme, { ok: false, reason: "origin_not_allowed" }, "the forum's key cannot vouch for acme's address");
});

test("check refuses malformed questions, and a site can never ask as the bot (stage confirm records requests)", async () => {
  const ctx = await setup();
  await ctx.registry.updateNamespace("acme", { access: "approval" });
  for (const body of [{}, { user: {}, stage: "poll" }, { user: { id: -1 }, stage: "poll" }, { user: { id: "abc" }, stage: "poll" }, { user: { id: 1.5 }, stage: "poll" }, { user: { id: BOB.id }, stage: "confirm" }, { user: { id: BOB.id } }, { user: { id: BOB.id }, stage: "other" }]) {
    assert.equal((await call(ctx, ctx.keys.acme, "POST", "/check", { origin: ACME, ...body })).status, 400, JSON.stringify(body));
  }
  const pending = await (await call(ctx, ctx.keys.acme, "POST", "/check", { user: { id: BOB.id }, stage: "session", origin: ACME })).json();
  assert.deepEqual(pending, { ok: false, reason: "pending_approval" });
  assert.deepEqual(await ctx.registry.listRequests("acme"), [], "a site's question never registers anyone");
});

test("a registry that cannot be read makes check a 503, so the site asks the visitor to retry rather than signing them out", async () => {
  const ctx = await setup();
  ctx.registry.access = async () => {
    throw new Error("D1 is down");
  };
  const response = await call(ctx, ctx.keys.acme, "POST", "/check", { user: { id: ALICE.id }, stage: "session", origin: ACME });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "5");
});

// --- The site's own moderation ------------------------------------------------------------------

test("a site's blocks go on its own list only, are audited, and are validated", async () => {
  const ctx = await setup();
  const block = (key, body) => call(ctx, key, "POST", "/blocks", body);
  assert.deepEqual(await (await block(ctx.keys.forum, { id: MALLORY.id, label: "spam\nbot" })).json(), { ok: true, added: true });
  assert.deepEqual((await ctx.registry.listBlocks("forum")).map((b) => [b.id, b.addedBy]), [[MALLORY.id, null]]);
  assert.deepEqual(await ctx.registry.listBlocks("acme"), []);
  assert.deepEqual(await (await block(ctx.keys.forum, { id: MALLORY.id })).json(), { ok: true, added: false }, "idempotent");

  for (const body of [{}, { id: "x" }, { id: -4 }, { id: 0 }]) assert.equal((await block(ctx.keys.forum, body)).status, 400, JSON.stringify(body));
  assert.equal((await call(ctx, ctx.keys.forum, "DELETE", "/blocks/oops")).status, 400);
  assert.deepEqual(await (await call(ctx, ctx.keys.acme, "DELETE", `/blocks/${MALLORY.id}`)).json(), { ok: true, removed: false }, "acme cannot unblock the forum's list");
  assert.deepEqual(await (await call(ctx, ctx.keys.forum, "DELETE", `/blocks/${MALLORY.id}`)).json(), { ok: true, removed: true });
  assert.deepEqual((await ctx.registry.listAudit()).map((e) => e.action).slice(0, 2), ["block.remove", "block.add"]);
});

test("blocking someone from a site takes them out of its approval queue", async () => {
  const ctx = await setup();
  await ctx.registry.updateNamespace("acme", { access: "approval" });
  await ctx.registry.recordRequest({ namespace: "acme", user: MALLORY });
  await call(ctx, ctx.keys.acme, "POST", "/blocks", { id: MALLORY.id });
  assert.deepEqual(await ctx.registry.listRequests("acme"), []);
});

// --- The site's own details ---------------------------------------------------------------------

test("a site can read its own name and URLs, and nothing about anyone else", async () => {
  const ctx = await setup();
  const info = await (await call(ctx, ctx.keys.acme, "GET", "/site")).json();
  assert.deepEqual(info, { namespace: "acme", name: "Acme", enabled: true, origins: [ACME] });
});

// --- Mounting ---------------------------------------------------------------------------------

test("apiPath is configurable, and may not overlap the console or the webhook", async () => {
  const ctx = makeHub({ config: { apiPath: "/internal/hub" } });
  assert.equal(ctx.hub.paths.api, "/internal/hub");
  assert.equal((await ctx.hub.fetch(new Request(`${ORIGIN}/hub-api/v1/site`))).status, 404, "the default path is not also served");
  assert.equal((await ctx.hub.fetch(new Request(`${ORIGIN}/internal/hub/v1/site`))).status, 401);

  const make = (config) => () => makeHub({ config });
  assert.throws(make({ apiPath: "/admin/api" }), /must not overlap/);
  assert.throws(make({ apiPath: "/admin" }), /must not overlap/);
  assert.throws(make({ apiPath: "/telegram" , webhookPath: "/telegram/webhook" }), /must not overlap/);
  assert.throws(make({ apiPath: "hub-api" }), /apiPath/);
  assert.equal(makeHub().hub.paths.api, "/hub-api");
});
