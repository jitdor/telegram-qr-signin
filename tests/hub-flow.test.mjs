import test from "node:test";
import assert from "node:assert/strict";

import { createHub } from "../src/hub/hub.js";
import { createSiteAuth } from "../src/hub/site.js";
import { hubGate, superAdminGate, parseRootAdmins } from "../src/hub/gates.js";
import { MemoryHubStore } from "../src/hub/store.js";
import { MemoryLoginStore } from "../src/stores/memory.js";
import { chatMember } from "../src/gates.js";
import { makeFakeTelegram, makeRequest, cookieFrom } from "./helpers.mjs";
import { ROOT, ALICE, BOB, MALLORY, ORIGIN, makeHub, makeSite, login, startUpdate, webhookRequest, lastReply, signInToConsole } from "./hub-helpers.mjs";

/** Mints a QR on a site, scans it through the hub's webhook, polls the site. */
async function signInToSite(ctx, site, user) {
  const { token } = await login(site);
  const response = await ctx.hub.webhook(webhookRequest(startUpdate(`/start ${site.namespace}_${token}`, user)));
  assert.equal(response.status, 200);
  const polled = await site.poll(makeRequest(`https://${site.namespace}.example/auth/poll?token=${token}`));
  const body = await polled.json();
  const value = cookieFrom(polled, site.cookieName);
  return { token, status: body.status, reason: body.reason, cookie: value ? `${site.cookieName}=${value}` : null };
}

async function setup() {
  const ctx = makeHub();
  await ctx.registry.createNamespace({ namespace: "acme", origins: ["https://acme.example"], name: "Acme dashboard" });
  await ctx.registry.createNamespace({ namespace: "wiki", origins: ["https://wiki.example"], name: "Team wiki" });
  await ctx.registry.addGrant({ namespace: "acme", id: ALICE.id });
  ctx.acme = makeSite(ctx, "acme");
  ctx.wiki = makeSite(ctx, "wiki");
  return ctx;
}

test("a granted person scans a site's QR, the hub confirms it, and the site signs them in", async () => {
  const ctx = await setup();
  const result = await signInToSite(ctx, ctx.acme, ALICE);
  assert.equal(result.status, "confirmed");

  const guarded = await ctx.acme.guard(makeRequest("https://acme.example/", { cookie: result.cookie }));
  assert.equal(guarded.ok, true);
  assert.equal(guarded.session.id, ALICE.id);

  assert.match(lastReply(ctx.telegram), /signed in to Acme dashboard/i);
});

test("one bot, many sites: a grant on one site opens nothing on another", async () => {
  const ctx = await setup();
  assert.equal((await signInToSite(ctx, ctx.wiki, ALICE)).status, "pending", "scan refused, so the browser keeps waiting");
  assert.match(lastReply(ctx.telegram), /don't have access to Team wiki/i);

  await ctx.registry.addGrant({ namespace: "wiki", id: BOB.id });
  assert.equal((await signInToSite(ctx, ctx.wiki, BOB)).status, "confirmed");
  assert.equal((await signInToSite(ctx, ctx.acme, BOB)).status, "pending", "Bob has the wiki, not Acme");
});

test("a QR minted for one site cannot be redeemed as another", async () => {
  const ctx = await setup();
  await ctx.registry.addGrant({ namespace: "wiki", id: ALICE.id });
  const { token } = await login(ctx.acme);

  await ctx.hub.webhook(webhookRequest(startUpdate(`/start wiki_${token}`, ALICE)));
  assert.match(lastReply(ctx.telegram), /expired or was already used/i);
  assert.equal((await ctx.store.get(token, "acme")).status, "pending", "the Acme token is untouched");
});

test("revoking in the registry locks the person out of the site on their next request", async () => {
  const ctx = await setup();
  const { cookie } = await signInToSite(ctx, ctx.acme, ALICE);
  assert.equal((await ctx.acme.guard(makeRequest("https://acme.example/", { cookie }))).ok, true);

  await ctx.registry.removeGrant("acme", ALICE.id);
  const after = await ctx.acme.guard(makeRequest("https://acme.example/", { cookie }));
  assert.equal(after.ok, false);
  assert.equal(after.reason, "not_granted");
  assert.equal(after.response.status, 403);
});

test("switching a site off, or deleting it, shuts it immediately and says why", async () => {
  const ctx = await setup();
  const { cookie } = await signInToSite(ctx, ctx.acme, ALICE);

  await ctx.registry.updateNamespace("acme", { enabled: false });
  assert.equal((await ctx.acme.guard(makeRequest("https://acme.example/", { cookie }))).reason, "namespace_disabled");
  assert.equal((await signInToSite(ctx, ctx.acme, ALICE)).status, "pending");
  assert.match(lastReply(ctx.telegram), /switched off/i);

  await ctx.registry.updateNamespace("acme", { enabled: true });
  assert.equal((await ctx.acme.guard(makeRequest("https://acme.example/", { cookie }))).ok, true, "access was kept, not erased");

  await ctx.registry.deleteNamespace("acme");
  assert.equal((await ctx.acme.guard(makeRequest("https://acme.example/", { cookie }))).reason, "unknown_namespace");
});

test("a refused scan leaves a request an admin can approve — but only for a QR that was really minted", async () => {
  const ctx = await setup();
  await signInToSite(ctx, ctx.acme, MALLORY);
  const requests = await ctx.registry.listRequests("acme");
  assert.deepEqual(requests.map((r) => [r.id, r.username, r.attempts]), [[MALLORY.id, "mal", 1]]);
  assert.match(lastReply(ctx.telegram), new RegExp(`Your Telegram ID is ${MALLORY.id}`));

  // A made-up payload, from someone who never saw a QR, is refused but not remembered.
  const fake = "0123456789abcdef0123456789abcdef";
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${fake}`, BOB)));
  assert.deepEqual((await ctx.registry.listRequests("acme")).map((r) => r.id), [MALLORY.id]);
});

test("a request is not recorded for a granted person, nor when a cookie is merely re-checked", async () => {
  const ctx = await setup();
  const { cookie } = await signInToSite(ctx, ctx.acme, ALICE);
  await ctx.registry.removeGrant("acme", ALICE.id);
  await ctx.acme.guard(makeRequest("https://acme.example/", { cookie })); // stage "session"
  assert.deepEqual(await ctx.registry.listRequests("acme"), []);
});

test("an unregistered namespace gets a polite reply instead of silence", async () => {
  const ctx = await setup();
  const fake = "0123456789abcdef0123456789abcdef";
  const response = await ctx.hub.webhook(webhookRequest(startUpdate(`/start ghost_${fake}`, ALICE)));
  assert.equal(response.status, 200);
  assert.match(lastReply(ctx.telegram), /isn't recognised/i);
});

test("the webhook ignores what is not a sign-in, and reports it as unhandled", async () => {
  const unhandled = [];
  const ctx = makeHub({ config: { onUnhandled: (update) => unhandled.push(update) } });
  for (const text of ["hello", "/start", "/start nonsense", "/start acme_short", "/start bad_ns_0123456789abcdef0123456789abcdef"]) {
    assert.equal((await ctx.hub.webhook(webhookRequest(startUpdate(text, ALICE)))).status, 200);
  }
  assert.equal(ctx.telegram.calls.length, 0, "no Telegram call for anything that is not a sign-in");
  assert.equal(unhandled.length, 5);
});

test("the webhook enforces its secret token and its method", async () => {
  const ctx = await setup();
  const update = startUpdate("/start hello", ALICE);
  assert.equal((await ctx.hub.fetch(webhookRequest(update, "wrong"))).status, 403);
  assert.equal((await ctx.hub.fetch(webhookRequest(update, null))).status, 403);
  assert.equal((await ctx.hub.fetch(webhookRequest(update))).status, 200);
  assert.equal((await ctx.hub.fetch(makeRequest(`${ORIGIN}/telegram/webhook`))).status, 405);
});

test("the console's own scans go to the super-admin gate, not the registry", async () => {
  const ctx = await setup();
  const { token } = await ctx.hub.adminAuth.beginLogin();

  await ctx.hub.handleUpdate(startUpdate(`/start hub-admin_${token}`, ALICE)); // granted on a site, but not an admin
  assert.match(lastReply(ctx.telegram), /not a super admin/i);
  assert.equal((await ctx.store.get(token, "hub-admin")).status, "pending");

  await ctx.hub.handleUpdate(startUpdate(`/start hub-admin_${token}`, ROOT));
  assert.equal((await ctx.store.get(token, "hub-admin")).status, "confirmed");
});

test("a registry outage is retryable: the visitor is asked to try again, nobody is signed out", async () => {
  const ctx = await setup();
  const { cookie } = await signInToSite(ctx, ctx.acme, ALICE);

  const real = ctx.registry.access.bind(ctx.registry);
  ctx.registry.access = async () => {
    throw new Error("D1 is down");
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    const down = await ctx.acme.guard(makeRequest("https://acme.example/", { cookie }));
    assert.equal(down.ok, false);
    assert.equal(down.response.status, 503, "retry, not 'access revoked'");
    assert.equal(down.response.headers.get("Set-Cookie"), null, "the cookie is not torn up");
  } finally {
    console.error = quiet;
  }
  ctx.registry.access = real;
  assert.equal((await ctx.acme.guard(makeRequest("https://acme.example/", { cookie }))).ok, true);
});

test("a registry outage while the hub looks up a scan gets a retry message, and the webhook still acks", async () => {
  const ctx = await setup();
  ctx.registry.getNamespace = async () => {
    throw new Error("D1 is down");
  };
  const { token } = await login(ctx.acme);
  const response = await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${token}`, ALICE)));
  assert.equal(response.status, 200);
  assert.match(lastReply(ctx.telegram), /try again|scan the same/i);
  assert.equal(ctx.errors.length, 1);
});

test("site names are plain text in bot messages: no markup mode, and no line breaks to forge a second paragraph", async () => {
  const ctx = await setup();
  await ctx.registry.updateNamespace("acme", { name: "<b>Acme</b>\n\nYour account is locked" });
  await signInToSite(ctx, ctx.acme, ALICE);
  const sent = ctx.telegram.calls.filter((c) => c.method === "sendMessage").at(-1);
  assert.equal(sent.payload.parse_mode, undefined);
  assert.ok(sent.payload.text.split("\n\n")[0].includes("Acme"), "the name stays inside the first line of the message");
  assert.ok(!/Acme[^\n]*\n/.test(sent.payload.text.split("\n\n")[0]), "the name itself contributes no line break");
});

// --- Open sites and block lists ----------------------------------------------------------------

test("a site open to anyone signs in a stranger with no grant, and records nothing about them", async () => {
  const ctx = await setup();
  await ctx.registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "The forum", access: "anyone" });
  const forum = makeSite(ctx, "forum");

  const result = await signInToSite(ctx, forum, MALLORY); // no grant anywhere
  assert.equal(result.status, "confirmed");
  assert.match(lastReply(ctx.telegram), /signed in to The forum/i);
  assert.deepEqual(await ctx.registry.listRequests("forum"), [], "an open site has nobody to approve");
  assert.equal((await forum.guard(makeRequest("https://forum.example/", { cookie: result.cookie }))).session.id, MALLORY.id);
});

test("open means open to that site only: the same stranger is still refused elsewhere", async () => {
  const ctx = await setup();
  await ctx.registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "The forum", access: "anyone" });
  assert.equal((await signInToSite(ctx, makeSite(ctx, "forum"), MALLORY)).status, "confirmed");
  assert.equal((await signInToSite(ctx, ctx.acme, MALLORY)).status, "pending");
});

test("a blocked person is refused on an open site, told plainly, and the QR stays usable", async () => {
  const ctx = await setup();
  await ctx.registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "The forum", access: "anyone" });
  await ctx.registry.addBlock({ namespace: "forum", id: MALLORY.id });
  const forum = makeSite(ctx, "forum");

  const result = await signInToSite(ctx, forum, MALLORY);
  assert.equal(result.status, "pending");
  assert.match(lastReply(ctx.telegram), /can't sign in to The forum/i);
  assert.doesNotMatch(lastReply(ctx.telegram), /Telegram ID|administrator/, "no invitation to ask for access");
  assert.equal((await ctx.store.get(result.token, "forum")).status, "pending", "the real owner of the QR can still use it");
  assert.deepEqual(await ctx.registry.listRequests("forum"), []);

  assert.equal((await signInToSite(ctx, forum, BOB)).status, "confirmed", "everyone else is unaffected");
});

test("a block beats a grant, with its own reason, and does not clog the approval queue", async () => {
  const ctx = await setup();
  await ctx.registry.addBlock({ namespace: "acme", id: ALICE.id }); // Alice holds a grant on Acme
  const result = await signInToSite(ctx, ctx.acme, ALICE);
  assert.equal(result.status, "pending");
  assert.match(lastReply(ctx.telegram), /can't sign in to Acme dashboard/i);
  assert.deepEqual(await ctx.registry.listRequests("acme"), []);

  const gate = ctx.acme.authorize;
  assert.deepEqual(await gate({ id: ALICE.id }, { stage: "session" }), { ok: false, reason: "blocked" });
  assert.deepEqual(await gate({ id: MALLORY.id }, { stage: "session" }), { ok: false, reason: "not_granted" });
});

test("blocking someone ends their open session on their next request, in either mode", async () => {
  const ctx = await setup();
  await ctx.registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "The forum", access: "anyone" });
  const forum = makeSite(ctx, "forum");

  for (const [site, user, host] of [[ctx.acme, ALICE, "acme"], [forum, MALLORY, "forum"]]) {
    const { cookie } = await signInToSite(ctx, site, user);
    const url = `https://${host}.example/`;
    assert.equal((await site.guard(makeRequest(url, { cookie }))).ok, true);

    await ctx.registry.addBlock({ namespace: host, id: user.id });
    const after = await site.guard(makeRequest(url, { cookie }));
    assert.deepEqual([after.ok, after.reason, after.response.status], [false, "blocked", 403], host);

    await ctx.registry.removeBlock(host, user.id);
    assert.equal((await site.guard(makeRequest(url, { cookie }))).ok, true, `${host}: unblocking restores access`);
  }
});

test("switching a site between modes takes effect on the next request and keeps every grant", async () => {
  const ctx = await setup();
  await ctx.registry.updateNamespace("acme", { access: "anyone" });
  const stranger = await signInToSite(ctx, ctx.acme, MALLORY);
  assert.equal(stranger.status, "confirmed");
  const alice = await signInToSite(ctx, ctx.acme, ALICE);

  await ctx.registry.updateNamespace("acme", { access: "granted" });
  const url = "https://acme.example/";
  const out = await ctx.acme.guard(makeRequest(url, { cookie: stranger.cookie }));
  assert.deepEqual([out.ok, out.reason], [false, "not_granted"], "the stranger is locked out");
  assert.equal((await ctx.acme.guard(makeRequest(url, { cookie: alice.cookie }))).ok, true, "the grant held through the open period");
});

test("a site that is switched off stays off, whatever its mode", async () => {
  const ctx = await setup();
  await ctx.registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "The forum", access: "anyone" });
  await ctx.registry.updateNamespace("forum", { enabled: false });
  const forum = makeSite(ctx, "forum");
  assert.equal((await signInToSite(ctx, forum, BOB)).status, "pending");
  assert.match(lastReply(ctx.telegram), /switched off/i);
  assert.equal((await forum.authorize({ id: BOB.id }, { stage: "session" })).reason, "namespace_disabled");
});

test("the refusal text follows the gate's verdict, even if the site changes between lookup and scan", async () => {
  const ctx = await setup();
  // The hub reads the site, then the gate reads it again. If the site is switched off in between,
  // the person must be told what the gate decided, not what the first read said.
  const real = ctx.registry.access.bind(ctx.registry);
  ctx.registry.access = async (...args) => {
    await ctx.registry.updateNamespace("acme", { enabled: false });
    return real(...args);
  };
  const { token } = await login(ctx.acme);
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${token}`, MALLORY)));
  assert.match(lastReply(ctx.telegram), /switched off/i);
});

test("a hostile site name cannot reach the refusal text as anything but plain words", async () => {
  const ctx = await setup();
  await ctx.registry.updateNamespace("acme", { name: "Acme\n\nSend your password to me" });
  await signInToSite(ctx, ctx.acme, MALLORY);
  const text = lastReply(ctx.telegram);
  assert.ok(!text.split("\n")[0].includes("\n"));
  assert.match(text.split("\n")[0], /^🔒 You don't have access to Acme Send your password to me yet\.$/, "collapsed onto one line, like every other name");
});

// --- Binding a namespace to its URL ------------------------------------------------------------

const STAGING = "https://staging.example";

test("a QR shown at a URL the namespace is not registered for is refused at the scan, and says why", async () => {
  const ctx = await setup();
  // Staging copied production's config, namespace included, but is not a registered URL.
  const { token } = await login(ctx.acme, STAGING);

  await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${token}`, ALICE))); // Alice IS granted
  assert.match(lastReply(ctx.telegram), /isn't registered for Acme dashboard/i);
  assert.equal((await ctx.store.get(token, "acme")).status, "pending", "nothing was spent or confirmed");
  assert.deepEqual(await ctx.registry.listRequests("acme"), [], "and nothing is remembered about it");
});

test("a QR that records no origin cannot be matched to the site, so it is refused too", async () => {
  const ctx = await setup();
  const { token } = await ctx.acme.beginLogin(); // no request: nothing recorded about where it was shown
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${token}`, ALICE)));
  assert.match(lastReply(ctx.telegram), /isn't registered for/i);
  assert.equal((await ctx.store.get(token, "acme")).status, "pending");
});

test("a granted person's session is worthless at any other URL, even with the same cookie secret", async () => {
  const ctx = await setup();
  const { cookie } = await signInToSite(ctx, ctx.acme, ALICE);

  const home = await ctx.acme.guard(makeRequest("https://acme.example/", { cookie }));
  assert.equal(home.ok, true);

  // The very same cookie, presented to a copy of the site served from somewhere else.
  const elsewhere = await ctx.acme.guard(makeRequest(`${STAGING}/`, { cookie }));
  assert.deepEqual([elsewhere.ok, elsewhere.reason, elsewhere.response.status], [false, "origin_not_allowed", 403]);
});

test("origin is the whole of scheme, host and port: near misses are refused", async () => {
  const ctx = await setup();
  const { cookie } = await signInToSite(ctx, ctx.acme, ALICE);
  for (const url of ["http://acme.example/", "https://acme.example:8443/", "https://www.acme.example/", "https://acme.example.evil.example/", "https://evilacme.example/"]) {
    const result = await ctx.acme.guard(makeRequest(url, { cookie }));
    assert.equal(result.reason, "origin_not_allowed", url);
  }
  // …while a different path, query or the default port is the same origin.
  for (const url of ["https://acme.example/admin?x=1", "https://acme.example:443/", "https://ACME.example/"]) {
    assert.equal((await ctx.acme.guard(makeRequest(url, { cookie }))).ok, true, url);
  }
});

test("the browser's poll is refused from an unregistered URL as well", async () => {
  const ctx = await setup();
  const { token } = await login(ctx.acme); // minted at the right place and scanned legitimately
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${token}`, ALICE)));
  assert.equal((await ctx.store.get(token, "acme")).status, "confirmed");

  const polled = await (await ctx.acme.poll(makeRequest(`${STAGING}/auth/poll?token=${token}`))).json();
  assert.deepEqual([polled.status, polled.reason], ["denied", "origin_not_allowed"]);
});

test("registering a second URL makes both work; removing one stops it on the next request", async () => {
  const ctx = await setup();
  await ctx.registry.addOrigin("acme", STAGING);
  const both = [["https://acme.example", ALICE], [STAGING, ALICE]];
  const cookies = [];
  for (const [host, user] of both) {
    const { token } = await login(ctx.acme, host);
    await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${token}`, user)));
    const polled = await ctx.acme.poll(makeRequest(`${host}/auth/poll?token=${token}`));
    assert.equal((await polled.json()).status, "confirmed", host);
    cookies.push(`${ctx.acme.cookieName}=${cookieFrom(polled, ctx.acme.cookieName)}`);
  }
  assert.equal((await ctx.acme.guard(makeRequest(`${STAGING}/`, { cookie: cookies[1] }))).ok, true);

  await ctx.registry.removeOrigin("acme", STAGING);
  assert.equal((await ctx.acme.guard(makeRequest(`${STAGING}/`, { cookie: cookies[1] }))).reason, "origin_not_allowed");
  assert.equal((await ctx.acme.guard(makeRequest("https://acme.example/", { cookie: cookies[0] }))).ok, true);
});

test("binding applies to an open site too: the whole world still cannot use it from an unregistered URL", async () => {
  const ctx = await setup();
  await ctx.registry.createNamespace({ namespace: "forum", origins: ["https://forum.example"], name: "The forum", access: "anyone" });
  const forum = makeSite(ctx, "forum");
  assert.equal((await signInToSite(ctx, forum, MALLORY)).status, "confirmed");

  const { token } = await login(forum, STAGING);
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start forum_${token}`, BOB)));
  assert.match(lastReply(ctx.telegram), /isn't registered/i);
  assert.equal((await forum.authorize({ id: BOB.id }, { request: makeRequest(`${STAGING}/`), stage: "session" })).reason, "origin_not_allowed");
});

test("a legacy site with no origins keeps working from anywhere until it is bound, then stops", async () => {
  const ctx = await setup();
  ctx.registry.namespaces.get("acme").origins = []; // as left by the upgrade script
  const { token } = await login(ctx.acme, STAGING);
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${token}`, ALICE)));
  assert.equal((await ctx.store.get(token, "acme")).status, "confirmed", "unbound: nothing is checked");
  assert.equal((await ctx.acme.guard(makeRequest("https://anywhere.example/", { cookie: (await signInToSite(ctx, ctx.acme, ALICE)).cookie }))).ok, true);

  await ctx.registry.addOrigin("acme", "https://acme.example");
  const again = await login(ctx.acme, STAGING);
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start acme_${again.token}`, ALICE)));
  assert.equal((await ctx.store.get(again.token, "acme")).status, "pending", "bound now: the same scan is refused");
});

test("the origin check needs a request: the gate at the scan itself defers to the hub's check", async () => {
  const ctx = await setup();
  assert.equal(await ctx.acme.authorize({ id: ALICE.id }, { stage: "confirm" }), true);
  assert.equal((await ctx.acme.authorize({ id: ALICE.id }, { stage: "session", request: makeRequest(`${STAGING}/`) })).reason, "origin_not_allowed");
});

test("the console's own sign-in is not bound to a site's URL", async () => {
  const ctx = await setup();
  assert.match(await signInToConsole(ctx.hub, ROOT), /^hub_admin_session=/);
});

test("a site cannot turn off the recording the hub's binding relies on", () => {
  const ctx = makeHub();
  assert.throws(() => makeSite(ctx, "acme", { captureClient: false }), /captureClient/);
  assert.ok(makeSite(ctx, "acme", { captureClient: true }));
});

// --- createSiteAuth ----------------------------------------------------------------------------

test("a site needs no bot token, and refuses to start without its own session secret", () => {
  const ctx = makeHub();
  assert.ok(makeSite(ctx, "acme").paths);
  assert.throws(() => createSiteAuth({ namespace: "acme", botUsername: "b", store: ctx.store, registry: ctx.registry }), /session\.secret/);
  assert.throws(() => createSiteAuth({ namespace: "hub-admin", botUsername: "b", store: ctx.store, registry: ctx.registry, session: { secret: "x" } }), /reserved/);
  assert.throws(() => createSiteAuth({ namespace: "a_b", botUsername: "b", store: ctx.store, registry: ctx.registry, session: { secret: "x" } }), /namespace/);
  assert.throws(() => createSiteAuth({ namespace: "acme", botUsername: "b", store: ctx.store, session: { secret: "x" } }), /registry/);
});

test("a site's own gate is ANDed with the hub's", async () => {
  const ctx = await setup();
  const telegram = makeFakeTelegram({ members: [BOB.id] }); // only Bob is in the required chat
  const strict = makeSite(ctx, "acme", { telegram, authorize: chatMember({ chatId: "-100" }) });
  await ctx.registry.addGrant({ namespace: "acme", id: BOB.id });

  // Alice holds a grant but is not in the chat; Bob holds both.
  assert.equal((await strict.authorize({ id: ALICE.id }, { telegram, stage: "session" })).ok, false);
  assert.equal(await strict.authorize({ id: BOB.id }, { telegram, stage: "session" }), true);
});

test("a site that composes a Telegram gate without a bot token fails closed and says why", async () => {
  const ctx = await setup();
  const reported = [];
  const site = makeSite(ctx, "acme", { authorize: chatMember({ chatId: "-100", onError: (err) => reported.push(err.message) }) });
  await ctx.registry.addGrant({ namespace: "acme", id: BOB.id });

  const result = await site.authorize({ id: BOB.id }, { telegram: site.telegram, stage: "session" });
  assert.equal(result.ok, false, "granted by the hub but unverifiable by the extra gate is a refusal, not a pass");
  assert.equal(result.transient, true);
  assert.match(reported.join(), /no Telegram client/);
});

// --- Gates and configuration -------------------------------------------------------------------

test("superAdminGate: bootstrap admins never touch the registry; others are checked live", async () => {
  const registry = new MemoryHubStore();
  let reads = 0;
  const real = registry.isAdmin.bind(registry);
  registry.isAdmin = (id) => (reads++, real(id));
  const gate = superAdminGate({ registry, rootAdmins: [ROOT.id] });

  assert.equal(await gate({ id: ROOT.id }), true);
  assert.equal(reads, 0, "a broken database cannot lock the operator out");

  assert.deepEqual(await gate({ id: BOB.id }), { ok: false, reason: "not_admin" });
  await registry.addAdmin({ id: BOB.id });
  assert.equal(await gate({ id: BOB.id }), true);
  await registry.removeAdmin(BOB.id);
  assert.equal((await gate({ id: BOB.id })).ok, false, "removal applies on the very next check");
});

test("hubGate validates its arguments and treats registry errors as transient", async () => {
  assert.throws(() => hubGate({ namespace: "acme" }), /registry/);
  assert.throws(() => hubGate({ registry: new MemoryHubStore() }), /namespace/);
  const gate = hubGate({
    registry: { access: async () => { throw new Error("boom"); } },
    namespace: "acme",
    onError: () => {},
  });
  assert.deepEqual(await gate({ id: 1 }, { stage: "session" }), { ok: false, reason: "hub_unavailable", transient: true });
});

test("parseRootAdmins takes a string, a number or an array, and drops junk", () => {
  assert.deepEqual(parseRootAdmins("1000, 2000"), [1000, 2000]);
  assert.deepEqual(parseRootAdmins(1000), [1000]);
  assert.deepEqual(parseRootAdmins([1000, "2000", "x", 0, -5]), [1000, 2000]);
  assert.deepEqual(parseRootAdmins(""), []);
  assert.deepEqual(parseRootAdmins(undefined), []);
});

test("createHub refuses a configuration that would be unusable or unsafe", () => {
  const base = {
    botUsername: "b",
    botToken: "1:T",
    store: new MemoryLoginStore(),
    registry: new MemoryHubStore(),
    superAdmins: [1],
    sessionSecret: "s",
  };
  assert.ok(createHub(base));
  assert.throws(() => createHub({ ...base, superAdmins: "" }), /superAdmins/);
  assert.throws(() => createHub({ ...base, superAdmins: undefined }), /superAdmins/);
  assert.throws(() => createHub({ ...base, sessionSecret: "" }), /sessionSecret/);
  assert.throws(() => createHub({ ...base, registry: undefined }), /registry/);
  assert.throws(() => createHub({ ...base, store: undefined }), /store/);
  assert.throws(() => createHub({ ...base, botUsername: undefined }), /botUsername/);
  assert.throws(() => createHub({ ...base, botToken: undefined }), /botToken|telegram/);
  assert.throws(() => createHub({ ...base, adminPath: "/admin/" }), /adminPath/);
  assert.throws(() => createHub({ ...base, adminPath: "admin" }), /adminPath/);
  assert.throws(() => createHub({ ...base, adminPath: "/a b" }), /adminPath/);
  assert.throws(() => createHub({ ...base, webhookPath: "/admin/hook" }), /overlap/);
  assert.throws(() => createHub({ ...base, adminPath: "/x", webhookPath: "/x" }), /overlap/);
  assert.throws(() => createHub(undefined), /store/);
});

test("the hub 404s paths it does not own, and `handle` returns null so it composes", async () => {
  const ctx = makeHub();
  assert.equal((await ctx.hub.fetch(makeRequest(`${ORIGIN}/elsewhere`))).status, 404);
  assert.equal(await ctx.hub.handle(makeRequest(`${ORIGIN}/elsewhere`)), null);
  assert.equal(await ctx.hub.handle(makeRequest(`${ORIGIN}/administrator`)), null, "/admin must not match /administrator");
});

test("custom paths are honoured end to end", async () => {
  const ctx = makeHub({ config: { adminPath: "/ops/console", webhookPath: "/tg" } });
  const cookie = await (async () => {
    const { token } = await ctx.hub.adminAuth.beginLogin();
    await ctx.hub.handleUpdate(startUpdate(`/start hub-admin_${token}`, ROOT));
    const polled = await ctx.hub.fetch(makeRequest(`${ORIGIN}/ops/console/auth/poll?token=${token}`));
    return `hub_admin_session=${cookieFrom(polled, "hub_admin_session")}`;
  })();
  const page = await ctx.hub.fetch(makeRequest(`${ORIGIN}/ops/console`, { cookie }));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /action="\/ops\/console\/ns\/new"/);
  assert.equal((await ctx.hub.fetch(makeRequest(`${ORIGIN}/telegram/webhook`))).status, 404);
  assert.equal((await ctx.hub.fetch(new Request(`${ORIGIN}/tg`, { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "whsec" }, body: "{}" }))).status, 200);
});

test("signInToConsole works end to end (guards the helper the console tests rely on)", async () => {
  const ctx = makeHub();
  assert.match(await signInToConsole(ctx.hub, ROOT), /^hub_admin_session=.+/);
});
