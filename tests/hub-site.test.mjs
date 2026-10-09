// A site as it is deployed in 2.0: it holds the hub's address and its own key, and nothing else of
// the hub's. Everything it learns, it learns by asking the hub over HTTPS.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { createSiteAuth } from "../src/hub/site.js";
import { D1HubStore } from "../src/hub/d1-store.js";
import { makeRequest, cookieFrom, makeFakeD1 } from "./helpers.mjs";
import { ROOT, ALICE, BOB, MALLORY, ORIGIN, makeHub, makeSite, plantLogin, startUpdate, webhookRequest, lastReply, post, get, signInToConsole, redirectTarget } from "./hub-helpers.mjs";

const ACME = "https://acme.example";
const FORUM = "https://forum.example";

async function setup() {
  const ctx = makeHub();
  await ctx.registry.createNamespace({ namespace: "acme", name: "Acme dashboard", origins: [ACME] });
  await ctx.registry.createNamespace({ namespace: "forum", name: "The forum", origins: [FORUM], access: "anyone" });
  await ctx.registry.addGrant({ namespace: "acme", id: ALICE.id });
  ctx.calls = [];
  const spy = (url, init) => {
    ctx.calls.push({ method: init?.method ?? "GET", url: String(url), headers: init?.headers });
    return ctx.hub.fetch(new Request(url, init));
  };
  ctx.acme = makeSite(ctx, "acme", { hub: { fetch: spy } });
  ctx.forum = makeSite(ctx, "forum", { hub: { fetch: spy } });
  return ctx;
}

/** Shows a QR at `host`, scans it through the hub as `user`, and polls. */
async function signIn(ctx, site, host, user) {
  const { token, payload } = await site.beginLogin({ request: makeRequest(`${host}/auth/login`) });
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start ${payload}`, user)));
  const polled = await site.poll(makeRequest(`${host}/auth/poll?token=${token}`));
  const body = await polled.json();
  const value = cookieFrom(polled, site.cookieName);
  return { token, payload, status: body.status, reason: body.reason, cookie: value ? `${site.cookieName}=${value}` : null };
}

test("a granted person signs in to a site that holds only the hub's address and its key", async () => {
  const ctx = await setup();
  const result = await signIn(ctx, ctx.acme, ACME, ALICE);
  assert.equal(result.status, "confirmed");
  assert.match(result.payload, /^acme_[0-9a-f]{32}$/, "the site's id in the QR comes from its key");

  const gate = await ctx.acme.guard(makeRequest(`${ACME}/`, { cookie: result.cookie }));
  assert.equal(gate.ok, true);
  assert.equal(gate.session.id, ALICE.id);
});

test("everything the site does is an HTTPS call to the hub's API with its key, and nothing else", async () => {
  const ctx = await setup();
  const { cookie } = await signIn(ctx, ctx.acme, ACME, ALICE);
  await ctx.acme.guard(makeRequest(`${ACME}/`, { cookie }));

  assert.ok(ctx.calls.length >= 5, "start, poll, consume, check at poll, check at guard");
  for (const call of ctx.calls) {
    assert.match(call.url, /^https:\/\/hub\.example\/hub-api\/v1\//, call.url);
    assert.match(call.headers.Authorization, /^Bearer tqk_acme_[0-9a-f]{64}$/);
  }
  assert.deepEqual(
    [...new Set(ctx.calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace(/[0-9a-f]{32}/, ":token")}`))].sort(),
    ["DELETE /hub-api/v1/logins/:token".replace("DELETE", "DELETE"), "GET /hub-api/v1/logins/:token", "POST /hub-api/v1/check", "POST /hub-api/v1/logins", "POST /hub-api/v1/logins/:token/consume"].filter((c) => !c.startsWith("DELETE")).sort(),
    "no call reads the access list, other sites, or the admins"
  );
});

test("a site holds no store, registry, or bot token of the hub's", async () => {
  const ctx = await setup();
  assert.equal(ctx.acme.store.constructor.name, "HubLoginStore");
  assert.equal(ctx.acme.registry, undefined);
  await assert.rejects(ctx.acme.store.confirm(), /only the hub's bot/);
});

test("one site's key reaches nothing of another's: not its sign-ins, not its people", async () => {
  const ctx = await setup();
  const { token } = await ctx.acme.beginLogin({ request: makeRequest(`${ACME}/auth/login`) });

  // The forum's key asks for acme's token: it is looked up under the FORUM, so there is nothing there.
  assert.equal(await ctx.forum.store.get(token), null);
  assert.equal(await ctx.forum.store.consume(token), null);
  await ctx.forum.store.remove(token); // a no-op on someone else's record
  assert.equal((await ctx.store.get(token, "acme")).status, "pending", "acme's sign-in is untouched");

  // And its check is about the forum: Alice holds a grant on acme, not on the open forum's list.
  assert.equal(await ctx.forum.authorize({ id: ALICE.id }, { stage: "session", request: makeRequest(`${FORUM}/`) }), true, "open to anyone");
  assert.equal((await ctx.acme.authorize({ id: BOB.id }, { stage: "session", request: makeRequest(`${ACME}/`) })).reason, "not_granted");
});

// --- When the hub cannot answer ------------------------------------------------------------------

test("hub down: the login page, the poll and the guard each say 'try again', and nobody is signed out", async () => {
  const ctx = await setup();
  const { cookie } = await signIn(ctx, ctx.acme, ACME, ALICE);
  const errors = [];
  const down = makeSite(ctx, "acme", {
    onError: (err) => errors.push(err),
    hub: { fetch: async () => { throw new Error("connect ECONNREFUSED"); } },
  });

  const page = await down.handle(makeRequest(`${ACME}/auth/login`));
  assert.equal(page.status, 503);
  assert.equal(page.headers.get("Retry-After"), "5");
  assert.match(await page.text(), /temporarily unavailable/i);

  const poll = await down.poll(makeRequest(`${ACME}/auth/poll?token=${"a".repeat(32)}`));
  assert.equal(poll.status, 503);
  assert.deepEqual(await poll.json(), { status: "unavailable", reason: "hub_unavailable" }, "a status the page keeps polling through");

  const guarded = await down.guard(makeRequest(`${ACME}/`, { cookie }));
  assert.equal(guarded.ok, false);
  assert.equal(guarded.response.status, 503);
  assert.equal(guarded.response.headers.get("Set-Cookie"), null, "the cookie is not torn up on an outage");
  assert.ok(errors.length >= 3 && errors.every((e) => e.code === "hub_unreachable"));

  assert.equal((await ctx.acme.guard(makeRequest(`${ACME}/`, { cookie }))).ok, true, "and the same cookie works once the hub is back");
});

test("a hub that does not answer in time is treated as down", async () => {
  const ctx = await setup();
  const slow = makeSite(ctx, "acme", {
    hub: { timeoutMs: 25, fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) },
  });
  const started = Date.now();
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout does not hold the process open; a real pending fetch does
  try {
    const response = await slow.handle(makeRequest(`${ACME}/auth/login`));
    assert.equal(response.status, 503);
    assert.ok(Date.now() - started < 1000);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a wrong or revoked key is an operator's problem: visitors are asked to try again, and the cause is logged", async () => {
  const ctx = await setup();
  const { cookie } = await signIn(ctx, ctx.acme, ACME, ALICE);
  const errors = [];
  const wrong = createSiteAuth({
    hub: { url: `${ORIGIN}/hub-api`, key: `tqk_acme_${"0".repeat(64)}`, fetch: (url, init) => ctx.hub.fetch(new Request(url, init)) },
    botUsername: "hub_bot",
    session: { secret: "site-secret-acme-site-secret-00" },
    onError: (err) => errors.push(err),
  });
  const page = await wrong.handle(makeRequest(`${ACME}/auth/login`));
  assert.equal(page.status, 503);
  assert.doesNotMatch(await page.text(), /key|unauthorized|401/i, "a visitor is not told about the key");
  const guarded = await wrong.guard(makeRequest(`${ACME}/`, { cookie }));
  assert.equal(guarded.response.status, 503);
  assert.equal(guarded.response.headers.get("Set-Cookie"), null, "a bad key does not sign anyone out");
  assert.ok(errors.length >= 2 && errors.every((e) => e.code === "unauthorized"));
});

test("a URL the hub does not have for this site, and a switched-off site, are refused with their own answers", async () => {
  const ctx = await setup();
  const elsewhere = await ctx.acme.handle(makeRequest("https://staging.example/auth/login"));
  assert.equal(elsewhere.status, 403);
  assert.match(await elsewhere.text(), /not registered for this site/);

  // A sign-in made at the real address, collected from another: the hub refuses it at the poll.
  const { token, payload } = await ctx.acme.beginLogin({ request: makeRequest(`${ACME}/auth/login`) });
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start ${payload}`, ALICE)));
  const poll = await ctx.acme.poll(makeRequest(`https://staging.example/auth/poll?token=${token}`));
  assert.deepEqual(await poll.json(), { status: "denied", reason: "origin_not_allowed" });
  assert.equal(poll.headers.get("Set-Cookie"), null);

  await ctx.registry.updateNamespace("acme", { enabled: false });
  const off = await ctx.acme.handle(makeRequest(`${ACME}/auth/login`));
  assert.equal(off.status, 403);
  assert.match(await off.text(), /switched off/);
});

// --- Cost, and what is cached --------------------------------------------------------------------

test("by default the hub is asked on every request, so a revocation applies to the very next one", async () => {
  const ctx = await setup();
  const { cookie } = await signIn(ctx, ctx.acme, ACME, ALICE);
  const checks = () => ctx.calls.filter((c) => c.url.endsWith("/check")).length;
  const before = checks();
  await ctx.acme.guard(makeRequest(`${ACME}/`, { cookie }));
  await ctx.acme.guard(makeRequest(`${ACME}/`, { cookie }));
  assert.equal(checks() - before, 2);

  await ctx.registry.removeGrant("acme", ALICE.id);
  const denied = await ctx.acme.guard(makeRequest(`${ACME}/`, { cookie }));
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "not_granted");
});

test("checkCacheSeconds trades that for fewer calls: a yes is reused for that long, a no never is", async () => {
  const ctx = await setup();
  const cached = makeSite(ctx, "acme", { hub: { checkCacheSeconds: 30, fetch: (url, init) => (ctx.calls.push({ url: String(url) }), ctx.hub.fetch(new Request(url, init))) } });
  const { cookie } = await signIn(ctx, cached, ACME, ALICE);
  const checks = () => ctx.calls.filter((c) => c.url.endsWith("/check")).length;

  const before = checks();
  for (let i = 0; i < 5; i++) assert.equal((await cached.guard(makeRequest(`${ACME}/`, { cookie }))).ok, true);
  assert.equal(checks() - before, 1, "one call to learn it, then the last yes is reused");

  let now = Date.now();
  const clock = mock.method(Date, "now", () => now);
  try {
    now += 31_000;
    assert.equal((await cached.guard(makeRequest(`${ACME}/`, { cookie }))).ok, true);
    assert.equal(checks() - before, 2, "asked again once it expired");

    await ctx.registry.removeGrant("acme", ALICE.id);
    now += 31_000;
    assert.equal((await cached.guard(makeRequest(`${ACME}/`, { cookie }))).ok, false);
    assert.equal((await cached.guard(makeRequest(`${ACME}/`, { cookie }))).ok, false);
    assert.equal(checks() - before, 4, "a refusal is asked about every time");
  } finally {
    clock.mock.restore();
  }
});

// --- A site's own moderation ---------------------------------------------------------------------

test("an open site can block and unblock people on its own list, through the hub, and only its own", async () => {
  const ctx = await setup();
  const { cookie } = await signIn(ctx, ctx.forum, FORUM, MALLORY);

  assert.deepEqual(await ctx.forum.block(MALLORY.id, "spam"), { ok: true, added: true });
  assert.deepEqual((await ctx.registry.listBlocks("forum")).map((b) => [b.id, b.label]), [[MALLORY.id, "spam"]]);
  assert.deepEqual(await ctx.registry.listBlocks("acme"), [], "acme's list is not touched");
  assert.equal((await ctx.forum.guard(makeRequest(`${FORUM}/`, { cookie }))).reason, "blocked", "it ends their session on the next request");

  assert.deepEqual(await ctx.forum.unblock(MALLORY.id), { ok: true, removed: true });
  assert.equal((await ctx.forum.guard(makeRequest(`${FORUM}/`, { cookie }))).ok, true);

  await ctx.forum.block(BOB.id);
  const [entry] = await ctx.registry.listAudit();
  assert.deepEqual([entry.actor, entry.action, entry.target, entry.detail], [null, "block.add", "forum", `${BOB.id} (by the site)`]);
});

// --- Through the console, start to finish --------------------------------------------------------

test("console end to end: add a site, copy its key from the page once, and the site works with only that", async () => {
  const ctx = makeHub();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  const created = await post(ctx.hub, "/admin/ns", { namespace: "docs", name: "Docs", url: "https://docs.example" }, { cookie });
  const html = await created.text();
  const key = html.match(/tqk_docs_[0-9a-f]{64}/)[0];
  assert.match(html, new RegExp(`url: &quot;${ORIGIN}/hub-api&quot;`), "the snippet shows the address to use");
  await ctx.registry.addGrant({ namespace: "docs", id: ALICE.id });

  const docs = createSiteAuth({
    hub: { url: `${ORIGIN}/hub-api`, key, fetch: (url, init) => ctx.hub.fetch(new Request(url, init)) },
    botUsername: "hub_bot",
    session: { secret: "docs-secret-docs-secret-docs-0000" },
  });
  assert.equal((await signIn(ctx, docs, "https://docs.example", ALICE)).status, "confirmed");
  assert.equal((await signIn(ctx, docs, "https://docs.example", BOB)).status, "pending", "Bob has no grant");
});

test("making a new key replaces the old one at once, behind a typed confirmation, and shows the new one once", async () => {
  const ctx = makeHub();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  const html = await (await post(ctx.hub, "/admin/ns", { namespace: "docs", name: "Docs", url: "https://docs.example" }, { cookie })).text();
  const oldKey = html.match(/tqk_docs_[0-9a-f]{64}/)[0];
  const via = (key) => createSiteAuth({ hub: { url: `${ORIGIN}/hub-api`, key, fetch: (url, init) => ctx.hub.fetch(new Request(url, init)) }, botUsername: "hub_bot", session: { secret: "s-docs-s-docs-s-docs-s-docs-0" }, onError: () => {} });
  const request = makeRequest("https://docs.example/auth/login");
  assert.equal((await via(oldKey).handle(request)).status, 200);

  const refused = await post(ctx.hub, "/admin/ns/docs/key", {}, { cookie });
  assert.equal(redirectTarget(refused).searchParams.get("err"), "confirm_key", "replacing needs the id typed");
  assert.equal((await via(oldKey).handle(request)).status, 200, "nothing changed");

  const done = await post(ctx.hub, "/admin/ns/docs/key", { confirm: "docs" }, { cookie });
  assert.equal(done.status, 200);
  const newKey = (await done.text()).match(/tqk_docs_[0-9a-f]{64}/)[0];
  assert.notEqual(newKey, oldKey);
  assert.equal((await via(oldKey).handle(request)).status, 503, "the old key stopped at once");
  assert.equal((await via(newKey).handle(request)).status, 200);
  assert.ok(!JSON.stringify(await ctx.registry.listAudit()).includes(newKey));
});

test("a site with no key yet is flagged on its page, and one click makes it", async () => {
  const ctx = makeHub();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  await ctx.registry.createNamespace({ namespace: "old", name: "Old site", origins: ["https://old.example"] }); // as a 1.x hub had it
  const page = await (await get(ctx.hub, "/admin/ns/old", cookie)).text();
  assert.match(page, /Site key <span class="pill warn">None<\/span>/);
  assert.match(page, /cannot sign anyone in/);

  const made = await post(ctx.hub, "/admin/ns/old/key", {}, { cookie });
  assert.equal(made.status, 200, "no typed confirmation is needed when there is nothing to replace");
  assert.match(await made.text(), /tqk_old_[0-9a-f]{64}/);
});

test("deleting a site deletes its key", async () => {
  const ctx = await setup();
  assert.ok(await ctx.registry.getSiteKey("acme"));
  await ctx.registry.deleteNamespace("acme");
  assert.equal(await ctx.registry.getSiteKey("acme"), null);
  assert.equal((await ctx.acme.handle(makeRequest(`${ACME}/auth/login`))).status, 503);
});

// --- The rest of what a site does ----------------------------------------------------------------

test("only the sign-in endpoints are the site's: everything else passes through untouched", async () => {
  const ctx = await setup();
  assert.equal(await ctx.acme.handle(makeRequest(`${ACME}/dashboard`)), null);
  assert.equal(await ctx.acme.handle(makeRequest(`${ACME}/api/data`)), null);
  assert.equal(ctx.calls.length, 0, "and none of that asked the hub anything");
});

test("signing out needs no hub: clearing a cookie is local", async () => {
  const ctx = await setup();
  const down = makeSite(ctx, "acme", { hub: { fetch: async () => { throw new Error("down"); } } });
  const response = await down.handle(makeRequest(`${ACME}/auth/logout`));
  assert.ok([200, 302, 303].includes(response.status));
  assert.match(response.headers.get("Set-Cookie"), /Max-Age=0|Expires=/);
});

test("the QR can point at the site's own domain: scanning it redirects to Telegram, and asks the hub only whether it is live", async () => {
  const ctx = await setup();
  const site = makeSite(ctx, "acme", { qrOrigin: ACME, hub: { fetch: (url, init) => ctx.hub.fetch(new Request(url, init)) } });
  const { token, qrLink } = await site.beginLogin({ request: makeRequest(`${ACME}/auth/login`) });
  assert.equal(qrLink, `${ACME}/auth/q/${token}`);
  const scan = await site.handle(makeRequest(`${ACME}/auth/q/${token}`));
  assert.equal(scan.status, 302);
  assert.equal(scan.headers.get("Location"), `https://t.me/hub_bot?start=acme_${token}`);
});

test("D1HubStore: one site's damaged origins do not stop every other site being found", async () => {
  const db = makeFakeD1({ sql: "hub-d1.sql" });
  const store = new D1HubStore(db);
  await store.createNamespace({ namespace: "acme", name: "Acme", origins: [ACME] });
  await store.createNamespace({ namespace: "bad", name: "Bad", origins: ["https://bad.example"] });
  db.sqlite.exec("PRAGMA ignore_check_constraints = ON");
  db.sqlite.exec(`UPDATE hub_namespaces SET origins = 'garbage' WHERE namespace = 'bad'`);

  assert.deepEqual(await store.namespacesForOrigin(ACME), ["acme"]);
  assert.deepEqual(await store.namespacesForOrigin("https://bad.example"), [], "the damaged site simply cannot be found, so it is refused");
});

// --- The sign-in page says which site it is ----------------------------------------------------

async function loginHtml(site, host) {
  return (await site.handle(makeRequest(`${host}/auth/login`))).text();
}
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a hub site's sign-in page names the site and shows its host", async () => {
  const ctx = await setup();
  const html = await loginHtml(ctx.acme, ACME);
  assert.match(html, /<h1>Sign in to Acme dashboard<\/h1>/);
  assert.match(html, /<title>Sign in to Acme dashboard<\/title>/);
  assert.match(html, /<p class="tqa-site">acme\.example<\/p>/);
  assert.match(visible(html), /Sign in to Acme dashboard acme\.example/);
  assert.doesNotMatch(visible(html), /acme_|namespace/i, "the id itself is never shown as text");
});

test("a port is part of the host shown, and each site names itself", async () => {
  const ctx = await setup();
  await ctx.registry.addOrigin("forum", "https://forum.example:8443");
  assert.match(await loginHtml(ctx.forum, FORUM), /Sign in to The forum/);
  assert.match(await loginHtml(ctx.forum, "https://forum.example:8443"), /class="tqa-site">forum\.example:8443</);
  assert.doesNotMatch(await loginHtml(ctx.acme, ACME), /The forum/);
});

test("the page follows a rename in the console, within the half minute the name is remembered", async () => {
  const ctx = await setup();
  let now = Date.now();
  const clock = mock.method(Date, "now", () => now);
  try {
    assert.match(await loginHtml(ctx.acme, ACME), /Sign in to Acme dashboard/);
    await ctx.registry.updateNamespace("acme", { name: "Acme HQ" });
    assert.match(await loginHtml(ctx.acme, ACME), /Sign in to Acme dashboard/, "still the remembered name");
    now += 31_000;
    assert.match(await loginHtml(ctx.acme, ACME), /<h1>Sign in to Acme HQ<\/h1>/);
  } finally {
    clock.mock.restore();
  }
});

test("a heading the site sets itself is kept, with the host still shown", async () => {
  const ctx = await setup();
  const site = makeSite(ctx, "acme", { branding: { heading: "📚 Internal docs" } });
  const html = await loginHtml(site, ACME);
  assert.match(html, /<h1>📚 Internal docs<\/h1>/);
  assert.match(html, /class="tqa-site">acme\.example</);
});

test("if the hub cannot name the site the page still shows, with the host alone", async () => {
  const ctx = await setup();
  const errors = [];
  const site = makeSite(ctx, "acme", {
    onError: (err) => errors.push(err),
    hub: { fetch: (url, init) => (new URL(url).pathname.endsWith("/site") ? Promise.reject(new Error("down")) : ctx.hub.fetch(new Request(url, init))) },
  });
  const html = await loginHtml(site, ACME);
  assert.match(html, /<h1>Sign in with Telegram<\/h1>/);
  assert.match(html, /class="tqa-site">acme\.example</);
  assert.equal(errors.length, 1);
});

test("a custom renderer is handed the site", async () => {
  const ctx = await setup();
  const seen = [];
  const custom = makeSite(ctx, "acme", { renderLoginPage: (params) => (seen.push(params.site), "<p>custom</p>") });
  assert.equal(await loginHtml(custom, ACME), "<p>custom</p>");
  assert.deepEqual(seen, [{ name: "Acme dashboard", host: "acme.example" }]);
});

test("a hostile site name cannot break out of the page", async () => {
  const ctx = await setup();
  await ctx.registry.updateNamespace("acme", { name: `<img src=x onerror=alert(1)>` });
  const html = await loginHtml(makeSite(ctx, "acme"), ACME);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Sign in to &lt;img src=x onerror=alert\(1\)&gt;/);
});
