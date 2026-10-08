// A site that is not told its namespace: createSiteAuth({ registry, store, session, ... }) with no
// `namespace`, resolving it from the origin each request arrives at.

import test from "node:test";
import assert from "node:assert/strict";

import { createSiteAuth } from "../src/hub/site.js";
import { MemoryHubStore } from "../src/hub/store.js";
import { D1HubStore } from "../src/hub/d1-store.js";
import { OriginInUseError } from "../src/hub/validate.js";
import { makeRequest, cookieFrom, makeFakeD1 } from "./helpers.mjs";
import { ROOT, ALICE, BOB, MALLORY, makeHub, makeDynamicSite, startUpdate, webhookRequest, lastReply, post, signInToConsole } from "./hub-helpers.mjs";

const ACME = "https://acme.example";
const FORUM = "https://forum.example";

async function setup() {
  const ctx = makeHub();
  await ctx.registry.createNamespace({ namespace: "acme", name: "Acme dashboard", origins: [ACME] });
  await ctx.registry.createNamespace({ namespace: "forum", name: "The forum", origins: [FORUM], access: "anyone" });
  await ctx.registry.addGrant({ namespace: "acme", id: ALICE.id });
  ctx.site = makeDynamicSite(ctx);
  return ctx;
}

/** Shows a QR at `host`, scans it through the hub as `user`, and polls. */
async function signIn(ctx, host, user, site = ctx.site) {
  const { token, payload } = await site.beginLogin({ request: makeRequest(`${host}/auth/login`) });
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start ${payload}`, user)));
  const polled = await site.poll(makeRequest(`${host}/auth/poll?token=${token}`));
  const body = await polled.json();
  const value = cookieFrom(polled, site.cookieName);
  return { token, payload, status: body.status, reason: body.reason, cookie: value ? `${site.cookieName}=${value}` : null };
}

test("a site with no namespace works out which site it is from the URL it was reached at", async () => {
  const ctx = await setup();
  assert.equal(await ctx.site.namespaceFor(makeRequest(`${ACME}/anything?x=1`)), "acme");
  assert.equal(await ctx.site.namespaceFor(makeRequest(`${FORUM}/`)), "forum");
  assert.equal(await ctx.site.namespaceFor(makeRequest("https://nobody.example/")), null);
  assert.equal(await ctx.site.namespaceFor(makeRequest("http://acme.example/")), null, "scheme is part of the origin");
});

test("it signs a granted person in end to end, with the namespace in the QR taken from the origin", async () => {
  const ctx = await setup();
  const result = await signIn(ctx, ACME, ALICE);
  assert.match(result.payload, /^acme_[0-9a-f]{32}$/, "the QR says which site, and the site never said");
  assert.equal(result.status, "confirmed");
  assert.match(lastReply(ctx.telegram), /signed in to Acme dashboard/i);

  const guarded = await ctx.site.guard(makeRequest(`${ACME}/`, { cookie: result.cookie }));
  assert.equal(guarded.ok, true);
  assert.equal(guarded.session.id, ALICE.id);
});

test("one Worker serving two registered sites keeps them apart", async () => {
  const ctx = await setup();
  // The same code, the same auth object, reached at two different URLs.
  const alice = await signIn(ctx, ACME, ALICE);
  assert.equal(alice.status, "confirmed");
  assert.equal((await signIn(ctx, ACME, MALLORY)).status, "pending", "acme needs a grant");
  const stranger = await signIn(ctx, FORUM, MALLORY);
  assert.equal(stranger.status, "confirmed", "the forum is open");
  assert.match(stranger.payload, /^forum_/);

  // Alice's acme session is not a forum session, and does not make the forum her site.
  assert.equal((await ctx.site.guard(makeRequest(`${ACME}/`, { cookie: alice.cookie }))).ok, true);
  const crossed = await ctx.site.guard(makeRequest(`${FORUM}/`, { cookie: alice.cookie }));
  assert.equal(crossed.ok, true, "the forum is open to anyone, which includes her; the cookie is only a signed id");
  await ctx.registry.addBlock({ namespace: "forum", id: ALICE.id });
  assert.equal((await ctx.site.guard(makeRequest(`${FORUM}/`, { cookie: alice.cookie }))).reason, "blocked");
  assert.equal((await ctx.site.guard(makeRequest(`${ACME}/`, { cookie: alice.cookie }))).ok, true, "a block on one site is not a block on another");
});

test("an unregistered URL gets no QR, no login page, no poll and no session — from the very same code", async () => {
  const ctx = await setup();
  const elsewhere = "https://staging.example";

  const login = await ctx.site.handle(makeRequest(`${elsewhere}/auth/login`));
  assert.equal(login.status, 403);
  assert.doesNotMatch(await login.text(), /<svg|t\.me/i);

  const guard = await ctx.site.guard(makeRequest(`${elsewhere}/`));
  assert.deepEqual([guard.ok, guard.reason, guard.response.status], [false, "origin_not_allowed", 403]);

  const poll = await ctx.site.poll(makeRequest(`${elsewhere}/auth/poll?token=${"a".repeat(32)}`));
  assert.deepEqual([poll.status, (await poll.json()).reason], [403, "origin_not_allowed"]);

  assert.equal((await ctx.site.scan(makeRequest(`${elsewhere}/auth/q/${"a".repeat(32)}`))).status, 403);
  assert.equal((await ctx.site.loginResponse({ request: makeRequest(`${elsewhere}/`) })).status, 403);
  await assert.rejects(ctx.site.beginLogin({ request: makeRequest(`${elsewhere}/`) }), /not a registered site/);
  await assert.rejects(ctx.site.loginPage({ request: makeRequest(`${elsewhere}/`) }), /not a registered site/);
  await assert.rejects(ctx.site.beginLogin(), /not a registered site/, "no request, no site");

  assert.deepEqual(await ctx.site.authorize({ id: ALICE.id }, { stage: "session" }), { ok: false, reason: "origin_not_allowed" }, "no request, no site");
});

test("only the sign-in endpoints are the site's: everything else passes through untouched", async () => {
  const ctx = await setup();
  assert.equal(await ctx.site.handle(makeRequest(`${ACME}/dashboard`)), null);
  assert.equal(await ctx.site.handle(makeRequest("https://staging.example/dashboard")), null, "the app's own routes are the app's business");
  assert.equal((await ctx.site.handle(makeRequest(`${ACME}/auth/login`))).status, 200);
});

test("the login page at a registered URL carries a QR for that site's namespace", async () => {
  const ctx = await setup();
  const html = await (await ctx.site.handle(makeRequest(`${FORUM}/auth/login`))).text();
  assert.match(html, /start=forum_[0-9a-f]{32}/);
  assert.doesNotMatch(html, /start=acme_/);
});

test("signing out works from anywhere: clearing a cookie needs no site", async () => {
  const ctx = await setup();
  const response = await ctx.site.handle(makeRequest("https://staging.example/auth/logout"));
  assert.equal(response.status, 302);
  assert.match(response.headers.get("Set-Cookie"), new RegExp(`${ctx.site.cookieName}=;.*Max-Age=0`));
});

test("registering a URL makes a site work at once, and removing it stops it at once", async () => {
  const ctx = await setup();
  const staging = "https://staging.example";
  assert.equal((await ctx.site.guard(makeRequest(`${staging}/`))).reason, "origin_not_allowed");

  await ctx.registry.addOrigin("acme", staging);
  const result = await signIn(ctx, staging, ALICE);
  assert.equal(result.status, "confirmed");
  assert.equal((await ctx.site.guard(makeRequest(`${staging}/`, { cookie: result.cookie }))).ok, true);

  await ctx.registry.removeOrigin("acme", staging);
  assert.equal((await ctx.site.guard(makeRequest(`${staging}/`, { cookie: result.cookie }))).reason, "origin_not_allowed");
});

test("a URL claimed by two sites is refused rather than guessed", async () => {
  const ctx = await setup();
  ctx.registry.namespaces.get("forum").origins.push(ACME); // as two admins racing could leave it
  assert.deepEqual(await ctx.registry.namespacesForOrigin(ACME), ["acme", "forum"]);

  const guard = await ctx.site.guard(makeRequest(`${ACME}/`));
  assert.deepEqual([guard.ok, guard.reason, guard.response.status], [false, "origin_ambiguous", 403]);
  assert.match(await guard.response.text(), /more than one site/);
  assert.equal(await ctx.site.namespaceFor(makeRequest(`${ACME}/`)), null);
});

test("if the registry cannot be asked, the answer is 'try again', not 'you are signed out'", async () => {
  const ctx = await setup();
  const { cookie } = await signIn(ctx, ACME, ALICE);
  const errors = [];
  const site = makeDynamicSite(ctx, { onError: (err) => errors.push(err) });

  ctx.registry.namespacesForOrigin = async () => {
    throw new Error("D1 is down");
  };
  const guard = await site.guard(makeRequest(`${ACME}/`, { cookie }));
  assert.equal(guard.ok, false);
  assert.equal(guard.response.status, 503);
  assert.equal(guard.response.headers.get("Retry-After"), "5");
  assert.equal(guard.response.headers.get("Set-Cookie"), null, "the cookie is not torn up");
  const poll = await site.poll(makeRequest(`${ACME}/auth/poll?token=${"a".repeat(32)}`));
  assert.equal(poll.status, 503);
  const auth = await site.authorize({ id: ALICE.id }, { request: makeRequest(`${ACME}/`) });
  assert.equal(auth.transient, true);
  assert.equal(errors.length, 3);
});

test("a site can still be told its namespace, which pins it and skips the lookup", async () => {
  const ctx = await setup();
  let lookups = 0;
  const real = ctx.registry.namespacesForOrigin.bind(ctx.registry);
  ctx.registry.namespacesForOrigin = (...args) => (lookups++, real(...args));

  const pinned = createSiteAuth({ namespace: "acme", botUsername: "hub_bot", store: ctx.store, registry: ctx.registry, session: { secret: "pinned-secret-pinned-secret-0000" } });
  assert.equal(pinned.namespace, "acme");
  assert.equal(pinned.cookieName, "acme_session", "a pinned site keeps its familiar cookie name");
  assert.equal((await pinned.guard(makeRequest(`${ACME}/`))).reason, "unauthenticated");
  assert.equal(lookups, 0);
});

test("the cookie name is fixed, and configurable, for a site that resolves its namespace", async () => {
  const ctx = await setup();
  assert.equal(ctx.site.cookieName, "site_session");
  assert.equal(makeDynamicSite(ctx, { session: { secret: "x".repeat(32), cookieName: "mine" } }).cookieName, "mine");
});

test("it is validated exactly like a pinned site", async () => {
  const ctx = makeHub();
  assert.throws(() => createSiteAuth({ botUsername: "b", store: ctx.store, session: { secret: "x" } }), /registry/);
  assert.throws(() => createSiteAuth({ botUsername: "b", store: ctx.store, registry: ctx.registry }), /session\.secret/);
  assert.throws(() => createSiteAuth({ botUsername: "b", store: ctx.store, registry: ctx.registry, session: { secret: "x" }, captureClient: false }), /captureClient/);
  assert.throws(() => createSiteAuth(undefined), /registry/);
  assert.throws(() => createSiteAuth({ namespace: "hub-admin", botUsername: "b", store: ctx.store, registry: ctx.registry, session: { secret: "x" } }), /reserved/);
});

test("its own extra gate is ANDed with the hub's, at whichever site the request is for", async () => {
  const ctx = await setup();
  const gate = async (user) => (user.id === ALICE.id ? true : { ok: false, reason: "extra" });
  const site = makeDynamicSite(ctx, { authorize: gate });
  await ctx.registry.addGrant({ namespace: "acme", id: BOB.id });
  const request = makeRequest(`${ACME}/`);
  assert.equal(await site.authorize({ id: ALICE.id }, { request, stage: "session" }), true);
  assert.deepEqual(await site.authorize({ id: BOB.id }, { request, stage: "session" }), { ok: false, reason: "extra" });
});

test("console end to end: a site added there needs no namespace in its code", async () => {
  const ctx = makeHub();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  await post(ctx.hub, "/admin/ns", { namespace: "docs", name: "Docs", url: "https://docs.example" }, { cookie });
  await ctx.registry.addGrant({ namespace: "docs", id: ALICE.id });
  const site = makeDynamicSite(ctx);

  assert.equal((await signIn(ctx, "https://docs.example", ALICE, site)).status, "confirmed");
  assert.equal((await signIn(ctx, "https://not-docs.example", ALICE, site).catch((e) => ({ error: e.message }))).error?.includes("not a registered site"), true);
});

// --- one origin, one site ----------------------------------------------------------------------

const STORES = {
  memory: () => new MemoryHubStore(),
  d1: () => new D1HubStore(makeFakeD1({ sql: "hub-d1.sql" })),
};

for (const [kind, make] of Object.entries(STORES)) {
  test(`[${kind}] a URL can belong to only one site`, async () => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme", origins: [ACME] });

    await assert.rejects(store.createNamespace({ namespace: "other", name: "Other", origins: ["https://x.example", ACME] }), (err) => err instanceof OriginInUseError && err.code === "origin_in_use" && err.owner === "acme" && err.origin === ACME);
    assert.equal(await store.getNamespace("other"), null, "nothing is created when one of its URLs is taken");

    await store.createNamespace({ namespace: "other", name: "Other", origins: ["https://other.example"] });
    await assert.rejects(store.addOrigin("other", "https://ACME.example/path"), OriginInUseError, "however the URL is written");
    assert.deepEqual((await store.getNamespace("other")).origins, ["https://other.example"]);

    assert.equal(await store.addOrigin("acme", ACME), false, "a site re-adding its own URL is not a conflict");
    assert.equal((await store.createNamespace({ namespace: "acme", name: "Again", origins: [ACME] })), false, "re-creating a site is not a conflict either");
  });

  test(`[${kind}] a URL is free again once its site drops it or is deleted`, async () => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme", origins: [ACME, "https://acme.workers.dev"] });
    await store.removeOrigin("acme", "https://acme.workers.dev");
    await store.createNamespace({ namespace: "other", name: "Other", origins: ["https://acme.workers.dev"] });
    assert.deepEqual(await store.namespacesForOrigin("https://acme.workers.dev"), ["other"]);

    await store.deleteNamespace("acme");
    await store.createNamespace({ namespace: "acme2", name: "Acme 2", origins: [ACME] });
    assert.deepEqual(await store.namespacesForOrigin(ACME), ["acme2"]);
  });

  test(`[${kind}] namespacesForOrigin normalises its argument and answers for junk with nothing`, async () => {
    const store = make();
    await store.createNamespace({ namespace: "acme", name: "Acme", origins: [ACME] });
    assert.deepEqual(await store.namespacesForOrigin("HTTPS://Acme.Example:443/path?x"), ["acme"]);
    for (const junk of ["", "nope", null, undefined, "http://acme.example", "https://evil.example"]) {
      assert.deepEqual(await store.namespacesForOrigin(junk), [], String(junk));
    }
  });
}

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
