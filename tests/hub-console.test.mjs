import test from "node:test";
import assert from "node:assert/strict";

import { makeRequest } from "./helpers.mjs";
import {
  ROOT,
  ADMIN2,
  ALICE,
  BOB,
  MALLORY,
  ORIGIN,
  makeHub,
  signInToConsole,
  csrfFor,
  get,
  post,
  redirectTarget,
} from "./hub-helpers.mjs";

async function setup() {
  const ctx = makeHub();
  ctx.cookie = await signInToConsole(ctx.hub, ROOT);
  return ctx;
}

/** Follows a 303 to its target page and returns its HTML. */
async function follow(ctx, response, cookie = ctx.cookie) {
  const target = redirectTarget(response);
  const page = await get(ctx.hub, target.pathname + target.search, cookie);
  return { target, html: await page.text(), status: page.status };
}

// --- Access to the console ---------------------------------------------------------------------

test("signed out, the console shows the QR sign-in and nothing else", async () => {
  const ctx = makeHub();
  await ctx.registry.createNamespace({ namespace: "acme", name: "Acme", origins: ["https://acme.example"] });
  const page = await get(ctx.hub, "/admin");
  const html = await page.text();
  assert.match(html, /Hub admin/);
  assert.match(html, /<svg/, "a QR code");
  assert.doesNotMatch(html, /Acme/, "no site data to anyone who is not signed in");
  assert.doesNotMatch(html, /name="csrf"/);
});

test("a valid cookie for someone who is not a super admin is refused", async () => {
  const ctx = makeHub();
  // Correctly signed, as if a site and the console shared a secret — the gate still has to say no.
  const value = await ctx.hub.adminAuth.session.sign({ id: MALLORY.id, name: "Mallory", iat: Math.floor(Date.now() / 1000) });
  const cookie = `hub_admin_session=${value}`;
  const response = await get(ctx.hub, "/admin", cookie);
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /Super admins<\/h2>/);
});

test("a site's session cookie, even signed with the same secret, is not a console session", async () => {
  const ctx = makeHub({ config: { sessionSecret: "shared-secret-shared-secret-0000" } });
  const { createSessionCodec } = await import("../src/session.js");
  // A site that (wrongly) reused the console's secret and the default key label.
  const siteCodec = createSessionCodec({ secret: "shared-secret-shared-secret-0000", cookieName: "hub_admin_session" });
  const forged = await siteCodec.sign({ id: ROOT.id, name: "Rhea", iat: Math.floor(Date.now() / 1000) });
  const response = await get(ctx.hub, "/admin", `hub_admin_session=${forged}`);
  const html = await response.text();
  assert.match(html, /<svg/, "different key label, so the signature does not verify: it is the sign-in page");
  assert.doesNotMatch(html, /name="csrf"/);
});

test("a bootstrap admin gets the dashboard, with security headers and no caching", async () => {
  const ctx = await setup();
  const response = await get(ctx.hub, "/admin", ctx.cookie);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/html/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const csp = response.headers.get("Content-Security-Policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src/, "the console ships no JavaScript, so none is allowed");
  assert.doesNotMatch(await response.text(), /<script/i);
});

test("pages do not use Referrer-Policy: no-referrer, which makes browsers send `Origin: null` on their own forms", async () => {
  // Found in a real browser: with no-referrer, Chrome and Firefox send `Origin: null` on a
  // same-origin form POST, and the console's Origin check then refuses every form it served.
  const ctx = await setup();
  for (const path of ["/admin", "/admin/ns/ghost"]) {
    const policy = (await get(ctx.hub, path, ctx.cookie)).headers.get("Referrer-Policy");
    assert.equal(policy, "same-origin", path);
  }
  const redirected = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  assert.equal(redirected.headers.get("Referrer-Policy"), "same-origin");
});

test("the sign-in page cannot be framed either", async () => {
  const ctx = makeHub();
  const response = await get(ctx.hub, "/admin");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
});

test("the console cookie is scoped to the console path", async () => {
  const ctx = makeHub();
  const { token } = await ctx.hub.adminAuth.beginLogin();
  await ctx.hub.handleUpdate({ message: { message_id: 1, chat: { id: 1 }, from: ROOT, text: `/start hub-admin_${token}` } });
  const polled = await ctx.hub.fetch(makeRequest(`${ORIGIN}/admin/auth/poll?token=${token}`));
  const header = polled.headers.get("Set-Cookie");
  assert.match(header, /^hub_admin_session=/);
  assert.match(header, /Path=\/admin(;|$)/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /Max-Age=28800/);
});

test("removing a super admin ends their console access on the next request", async () => {
  const ctx = await setup();
  await ctx.registry.addAdmin({ id: ADMIN2.id });
  const cookie = await signInToConsole(ctx.hub, ADMIN2);
  assert.equal((await get(ctx.hub, "/admin", cookie)).status, 200);

  await ctx.registry.removeAdmin(ADMIN2.id);
  assert.equal((await get(ctx.hub, "/admin", cookie)).status, 403);
});

test("a registry outage on a console request is a retry, not a sign-out", async () => {
  const ctx = makeHub();
  await ctx.registry.addAdmin({ id: ADMIN2.id });
  const cookie = await signInToConsole(ctx.hub, ADMIN2);
  ctx.registry.isAdmin = async () => {
    throw new Error("D1 is down");
  };
  const response = await get(ctx.hub, "/admin", cookie);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(ctx.errors.length > 0, true);
});

// --- CSRF and origin ---------------------------------------------------------------------------

test("a POST without a valid CSRF token changes nothing", async () => {
  const ctx = await setup();
  for (const csrf of ["", "nope", "0".repeat(64)]) {
    const response = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example", name: "Acme" }, { cookie: ctx.cookie, csrf });
    assert.equal(redirectTarget(response).searchParams.get("err"), "bad_request");
  }
  assert.equal(await ctx.registry.getNamespace("acme"), null);
});

test("a POST with no csrf field at all is refused", async () => {
  const ctx = await setup();
  const response = await ctx.hub.fetch(
    new Request(`${ORIGIN}/admin/ns`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: ctx.cookie, Origin: ORIGIN },
      body: new URLSearchParams({ namespace: "acme" }),
    })
  );
  assert.equal(redirectTarget(response).searchParams.get("err"), "bad_request");
  assert.equal(await ctx.registry.getNamespace("acme"), null);
});

test("one admin's CSRF token is worthless on another admin's session", async () => {
  const ctx = await setup();
  await ctx.registry.addAdmin({ id: ADMIN2.id });
  const other = await signInToConsole(ctx.hub, ADMIN2);
  const stolen = await csrfFor(ctx.hub, other);

  const response = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie, csrf: stolen });
  assert.equal(redirectTarget(response).searchParams.get("err"), "bad_request");
  assert.equal(await ctx.registry.getNamespace("acme"), null);
});

test("a token from before a fresh sign-in stops working", async () => {
  const ctx = await setup();
  const old = await csrfFor(ctx.hub, ctx.cookie);
  await new Promise((resolve) => setTimeout(resolve, 1100)); // `iat` has one-second resolution
  const fresh = await signInToConsole(ctx.hub, ROOT);
  const response = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: fresh, csrf: old });
  assert.equal(redirectTarget(response).searchParams.get("err"), "bad_request");
});

test("a POST from another origin is refused even with a correct token", async () => {
  const ctx = await setup();
  const response = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie, origin: "https://evil.example" });
  assert.equal(redirectTarget(response).searchParams.get("err"), "bad_request");
  const nullOrigin = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie, origin: "null" });
  assert.equal(redirectTarget(nullOrigin).searchParams.get("err"), "bad_request");
  assert.equal(await ctx.registry.getNamespace("acme"), null);
});

test("a POST that is not a form is refused, and so are methods the console does not use", async () => {
  const ctx = await setup();
  const json = await ctx.hub.fetch(
    new Request(`${ORIGIN}/admin/ns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: ctx.cookie, Origin: ORIGIN }, body: JSON.stringify({ namespace: "acme" }) })
  );
  assert.equal(redirectTarget(json).searchParams.get("err"), "bad_request");
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const response = await ctx.hub.fetch(new Request(`${ORIGIN}/admin/ns`, { method, headers: { Cookie: ctx.cookie } }));
    assert.equal(response.status, 405, method);
  }
});

test("a signed-out POST changes nothing and just shows the sign-in page", async () => {
  const ctx = makeHub();
  const response = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" });
  assert.equal(await ctx.registry.getNamespace("acme"), null);
  assert.notEqual(response.status, 303);
});

// --- Sites -------------------------------------------------------------------------------------

test("adding a site registers it, audits it, and lands on its page", async () => {
  const ctx = await setup();
  const response = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example", name: "Acme dashboard" }, { cookie: ctx.cookie });
  const { target, html, status } = await follow(ctx, response);

  assert.equal(target.pathname, "/admin/ns/acme");
  assert.equal(status, 200);
  assert.match(html, /Acme dashboard/);
  assert.match(html, /Site added/);
  const site = await ctx.registry.getNamespace("acme");
  assert.deepEqual([site.name, site.enabled, site.createdBy], ["Acme dashboard", true, ROOT.id]);
  const [entry] = await ctx.registry.listAudit();
  assert.deepEqual([entry.actor, entry.action, entry.target], [ROOT.id, "site.create", "acme"]);
});

test("site ids are validated: shape, the reserved console id, and duplicates", async () => {
  const ctx = await setup();
  const err = async (namespace) => redirectTarget(await post(ctx.hub, "/admin/ns", { namespace, url: "https://x.example" }, { cookie: ctx.cookie })).searchParams.get("err");

  for (const bad of ["", "has_underscore", "x".repeat(25), "sp ace", "a/b", "../x", "<script>"]) {
    assert.equal(await err(bad), "bad_namespace", JSON.stringify(bad));
  }
  assert.equal(await err("hub-admin"), "reserved_namespace");
  assert.equal(await err("acme"), null);
  assert.equal(await err("acme"), "site_exists");
  assert.deepEqual((await ctx.registry.listNamespaces()).map((s) => s.namespace), ["acme"]);
});

test("a blank display name falls back to the id; saving changes name and state and logs both", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example", name: "" }, { cookie: ctx.cookie });
  assert.equal((await ctx.registry.getNamespace("acme")).name, "acme");

  const saved = await post(ctx.hub, "/admin/ns/acme/update", { name: "Acme" }, { cookie: ctx.cookie }); // checkbox absent = off
  assert.equal(redirectTarget(saved).searchParams.get("ok"), "site_saved");
  const site = await ctx.registry.getNamespace("acme");
  assert.deepEqual([site.name, site.enabled], ["Acme", false]);

  await post(ctx.hub, "/admin/ns/acme/update", { name: "Acme", enabled: "1" }, { cookie: ctx.cookie });
  assert.equal((await ctx.registry.getNamespace("acme")).enabled, true);

  const detail = (await ctx.registry.listAudit()).filter((e) => e.action === "site.update").map((e) => e.detail);
  assert.ok(detail.some((d) => /disabled/.test(d) && /Acme/.test(d)));
  assert.ok(detail.some((d) => /enabled/.test(d)));
});

test("saving without changing anything writes no audit entry", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example", name: "Acme" }, { cookie: ctx.cookie });
  const before = (await ctx.registry.listAudit()).length;
  await post(ctx.hub, "/admin/ns/acme/update", { name: "Acme", enabled: "1" }, { cookie: ctx.cookie });
  assert.equal((await ctx.registry.listAudit()).length, before);
});

test("deleting a site needs the id typed back, and takes its people with it", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example", name: "Acme" }, { cookie: ctx.cookie });
  await ctx.registry.addGrant({ namespace: "acme", id: ALICE.id });

  const wrong = await post(ctx.hub, "/admin/ns/acme/delete", { confirm: "ACME" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(wrong).searchParams.get("err"), "confirm_mismatch");
  assert.ok(await ctx.registry.getNamespace("acme"));

  const done = await post(ctx.hub, "/admin/ns/acme/delete", { confirm: "acme" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(done).searchParams.get("ok"), "site_deleted");
  assert.equal(await ctx.registry.getNamespace("acme"), null);
  assert.equal((await ctx.registry.access("acme", ALICE.id)).exists, false);
  const entry = (await ctx.registry.listAudit())[0];
  assert.deepEqual([entry.action, entry.target], ["site.delete", "acme"]);
  assert.match(entry.detail, /1 people/);
});

test("actions on a site that does not exist say so instead of failing", async () => {
  const ctx = await setup();
  for (const path of ["/admin/ns/ghost/update", "/admin/ns/ghost/delete", "/admin/ns/ghost/grants"]) {
    const response = await post(ctx.hub, path, { name: "x", confirm: "ghost", ids: "1" }, { cookie: ctx.cookie });
    assert.equal(redirectTarget(response).searchParams.get("err"), "site_missing", path);
  }
  assert.equal((await get(ctx.hub, "/admin/ns/ghost", ctx.cookie)).status, 404);
});

// --- User access -------------------------------------------------------------------------------

test("granting access takes ids separated by commas, spaces and lines, and ignores repeats", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example", name: "Acme" }, { cookie: ctx.cookie });

  const response = await post(ctx.hub, "/admin/ns/acme/grants", { ids: "111, 222\n333  111;444", label: "Finance" }, { cookie: ctx.cookie });
  const { target, html } = await follow(ctx, response);
  assert.deepEqual([target.searchParams.get("ok"), target.searchParams.get("n")], ["grants_added", "4"]);
  assert.match(html, /Granted access to 4 people/);

  const grants = await ctx.registry.listGrants("acme");
  assert.deepEqual(grants.map((g) => g.id).sort((a, b) => a - b), [111, 222, 333, 444]);
  assert.ok(grants.every((g) => g.label === "Finance" && g.addedBy === ROOT.id));
  const entry = (await ctx.registry.listAudit())[0];
  assert.deepEqual([entry.action, entry.target], ["grant.add", "acme"]);
  assert.match(entry.detail, /^4: /);

  const again = await post(ctx.hub, "/admin/ns/acme/grants", { ids: "111, 222" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(again).searchParams.get("ok"), "grants_none");
});

test("a list with any bad entry adds nobody, so a typo is never half-applied", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  for (const ids of ["111, abc", "111, -5", "111, 0", "111, 1.5", "111, 99999999999999999999", "@alice"]) {
    const response = await post(ctx.hub, "/admin/ns/acme/grants", { ids }, { cookie: ctx.cookie });
    assert.equal(redirectTarget(response).searchParams.get("err"), "bad_ids", ids);
  }
  assert.equal((await post(ctx.hub, "/admin/ns/acme/grants", { ids: "  ,, " }, { cookie: ctx.cookie })).headers.get("Location").includes("no_ids"), true);
  assert.deepEqual(await ctx.registry.listGrants("acme"), []);
});

test("one submission is capped", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  const ids = Array.from({ length: 201 }, (_, n) => n + 1).join(",");
  const response = await post(ctx.hub, "/admin/ns/acme/grants", { ids }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(response).searchParams.get("err"), "too_many_ids");
  assert.deepEqual(await ctx.registry.listGrants("acme"), []);
});

test("revoking removes access at once and is audited", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  await ctx.registry.addGrant({ namespace: "acme", id: ALICE.id });

  const response = await post(ctx.hub, `/admin/ns/acme/grants/${ALICE.id}/remove`, {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(response).searchParams.get("ok"), "grant_removed");
  assert.equal((await ctx.registry.access("acme", ALICE.id)).granted, false);
  assert.deepEqual((await ctx.registry.listAudit())[0].action, "grant.remove");

  const bad = await post(ctx.hub, "/admin/ns/acme/grants/not-an-id/remove", {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(bad).searchParams.get("err"), "bad_id", "a non-numeric id never reaches the registry");
});

test("pending requests can be approved or dismissed; approval copies the person's name into the note", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  await ctx.registry.recordRequest({ namespace: "acme", user: { ...MALLORY, last_name: "Doe" } });
  await ctx.registry.recordRequest({ namespace: "acme", user: BOB });

  const page = await (await get(ctx.hub, "/admin/ns/acme", ctx.cookie)).text();
  assert.match(page, /Waiting for approval/);
  assert.match(page, /Mallory Doe \(@mal\)/);

  const approved = await post(ctx.hub, `/admin/ns/acme/requests/${MALLORY.id}/approve`, {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(approved).searchParams.get("ok"), "request_approved");
  const [grant] = await ctx.registry.listGrants("acme");
  assert.deepEqual([grant.id, grant.label, grant.addedBy], [MALLORY.id, "Mallory Doe (@mal)", ROOT.id]);
  assert.equal(await ctx.registry.getRequest("acme", MALLORY.id), null);

  const dismissed = await post(ctx.hub, `/admin/ns/acme/requests/${BOB.id}/dismiss`, {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(dismissed).searchParams.get("ok"), "request_dismissed");
  assert.equal((await ctx.registry.access("acme", BOB.id)).granted, false, "dismissing grants nothing");
  assert.deepEqual((await ctx.registry.listRequests("acme")), []);

  const gone = await post(ctx.hub, `/admin/ns/acme/requests/${BOB.id}/approve`, {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(gone).searchParams.get("err"), "request_gone");
  assert.equal((await ctx.registry.access("acme", BOB.id)).granted, false, "a request that is gone cannot be approved");
});

// --- Super admins ------------------------------------------------------------------------------

test("adding a super admin lets them in; removing them shuts the door again", async () => {
  const ctx = await setup();
  const added = await post(ctx.hub, "/admin/admins", { id: String(ADMIN2.id), label: "Ada" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(added).searchParams.get("ok"), "admin_added");
  assert.deepEqual((await ctx.registry.listAdmins()).map((a) => [a.id, a.label, a.addedBy]), [[ADMIN2.id, "Ada", ROOT.id]]);

  const adaCookie = await signInToConsole(ctx.hub, ADMIN2);
  const dashboard = await (await get(ctx.hub, "/admin", adaCookie)).text();
  assert.match(dashboard, /Ada/);

  const removed = await post(ctx.hub, `/admin/admins/${ADMIN2.id}/remove`, {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(removed).searchParams.get("ok"), "admin_removed");
  assert.equal((await get(ctx.hub, "/admin", adaCookie)).status, 403);
  assert.deepEqual((await ctx.registry.listAudit()).map((e) => e.action).slice(0, 2), ["admin.remove", "admin.add"]);
});

test("a super admin does not get into any site just by being one", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  assert.equal((await ctx.registry.access("acme", ROOT.id)).granted, false);
});

test("bootstrap admins cannot be removed or re-added; you cannot remove yourself", async () => {
  const ctx = await setup();
  await ctx.registry.addAdmin({ id: ADMIN2.id });
  const adaCookie = await signInToConsole(ctx.hub, ADMIN2);

  const root = await post(ctx.hub, `/admin/admins/${ROOT.id}/remove`, {}, { cookie: adaCookie });
  assert.equal(redirectTarget(root).searchParams.get("err"), "admin_root");
  const self = await post(ctx.hub, `/admin/admins/${ADMIN2.id}/remove`, {}, { cookie: adaCookie });
  assert.equal(redirectTarget(self).searchParams.get("err"), "admin_self");
  const again = await post(ctx.hub, "/admin/admins", { id: String(ROOT.id) }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(again).searchParams.get("err"), "admin_exists");
  assert.equal(await ctx.registry.isAdmin(ADMIN2.id), true);
  assert.equal(await ctx.registry.isAdmin(ROOT.id), false, "bootstrap admins never become registry rows");

  // A bootstrap admin can still sign in with the registry completely empty.
  assert.equal((await get(ctx.hub, "/admin", ctx.cookie)).status, 200);
});

test("admin ids are validated, and unknown admins report as missing", async () => {
  const ctx = await setup();
  for (const id of ["", "abc", "-1", "0", "1.5", "12345678901234567"]) {
    const response = await post(ctx.hub, "/admin/admins", { id }, { cookie: ctx.cookie });
    assert.equal(redirectTarget(response).searchParams.get("err"), "bad_id", JSON.stringify(id));
  }
  const missing = await post(ctx.hub, "/admin/admins/4242/remove", {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(missing).searchParams.get("err"), "admin_missing");
  const dup = await post(ctx.hub, "/admin/admins", { id: "4242" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(dup).searchParams.get("ok"), "admin_added");
  assert.equal(redirectTarget(await post(ctx.hub, "/admin/admins", { id: "4242" }, { cookie: ctx.cookie })).searchParams.get("err"), "admin_exists");
});

// --- Rendering ---------------------------------------------------------------------------------

test("everything an admin or a stranger can type is escaped where it is shown", async () => {
  const ctx = await setup();
  const evil = `"><img src=x onerror=alert(1)>`;
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example", name: evil }, { cookie: ctx.cookie });
  await post(ctx.hub, "/admin/ns/acme/grants", { ids: "5", label: evil }, { cookie: ctx.cookie });
  await post(ctx.hub, "/admin/admins", { id: "6", label: evil }, { cookie: ctx.cookie });
  await ctx.registry.recordRequest({ namespace: "acme", user: { id: 7, first_name: evil, last_name: "<b>x</b>", username: evil } });

  for (const path of ["/admin", "/admin/ns/acme"]) {
    const html = await (await get(ctx.hub, path, ctx.cookie)).text();
    assert.doesNotMatch(html, /<img src=x/, path);
    assert.doesNotMatch(html, /<b>x<\/b>/, path);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, path);
  }
});

test("a signed-in name is escaped in the header too", async () => {
  const ctx = makeHub();
  const cookie = await signInToConsole(ctx.hub, { ...ROOT, first_name: "<script>alert(1)</script>" });
  const html = await (await get(ctx.hub, "/admin", cookie)).text();
  assert.doesNotMatch(html, /<script>alert/);
});

test("notices come from a fixed set of codes, so a crafted link cannot put words in the console's mouth", async () => {
  const ctx = await setup();
  for (const query of ["ok=%3Cscript%3Ealert(1)%3C/script%3E", "err=Your%20session%20expired.%20Rescan%20at%20evil.example", "ok=__proto__", "err=constructor", "ok=toString"]) {
    const html = await (await get(ctx.hub, `/admin?${query}`, ctx.cookie)).text();
    assert.doesNotMatch(html, /evil\.example|<script>alert|class="flash/, query);
  }
  const html = await (await get(ctx.hub, "/admin?ok=grants_added&n=3", ctx.cookie)).text();
  assert.match(html, /Granted access to 3 people/);
});

test("the dashboard lists sites with their counts, and flags the bootstrap admin", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example", name: "Acme dashboard" }, { cookie: ctx.cookie });
  await post(ctx.hub, "/admin/ns", { namespace: "wiki", url: "https://wiki.example", name: "Team wiki" }, { cookie: ctx.cookie });
  await ctx.registry.addGrant({ namespace: "acme", id: 1 });
  await ctx.registry.addGrant({ namespace: "acme", id: 2 });
  await ctx.registry.recordRequest({ namespace: "wiki", user: { id: 3 } });
  await ctx.registry.updateNamespace("wiki", { enabled: false });

  const html = await (await get(ctx.hub, "/admin", ctx.cookie)).text();
  assert.match(html, /Acme dashboard/);
  assert.match(html, /Team wiki/);
  assert.match(html, /Hub configuration/);
  assert.match(html, />Off</);
  assert.match(html, /site\.create/, "recent activity is shown");
  assert.match(html, new RegExp(`<code>${ROOT.id}</code> <span class="pill">you</span>`));
});

test("a failing registry on a page load is a 500, not a redirect loop; on a POST it returns to the dashboard", async () => {
  const ctx = await setup();
  const real = ctx.registry.listNamespaces.bind(ctx.registry);
  ctx.registry.listNamespaces = async () => {
    throw new Error("D1 is down");
  };
  const page = await get(ctx.hub, "/admin", ctx.cookie);
  assert.equal(page.status, 500);
  assert.doesNotMatch(await page.text(), /D1 is down/, "internal errors are not shown to the browser");

  const csrf = await (async () => {
    ctx.registry.listNamespaces = real;
    const token = await csrfFor(ctx.hub, ctx.cookie);
    ctx.registry.createNamespace = async () => {
      throw new Error("D1 is down");
    };
    return token;
  })();
  const response = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie, csrf });
  assert.equal(redirectTarget(response).searchParams.get("err"), "failed");
  assert.ok(ctx.errors.length >= 2);
});

test("an audit-log failure does not undo or hide the change that was made", async () => {
  const ctx = await setup();
  ctx.registry.appendAudit = async () => {
    throw new Error("audit table gone");
  };
  const response = await post(ctx.hub, "/admin/ns", { namespace: "acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(response).searchParams.get("ok"), "site_created");
  assert.ok(await ctx.registry.getNamespace("acme"));
});

test("unknown console paths are 404s, and a trailing slash is the dashboard", async () => {
  const ctx = await setup();
  for (const path of ["/admin/nope", "/admin/ns", "/admin/ns/acme/extra/deep", "/admin/admins/1", "/admin/auth/nope"]) {
    assert.equal((await get(ctx.hub, path, ctx.cookie)).status, 404, path);
  }
  assert.equal((await get(ctx.hub, "/admin/", ctx.cookie)).status, 200);
  const head = await ctx.hub.fetch(makeRequest(`${ORIGIN}/admin`, { method: "HEAD", cookie: ctx.cookie }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("signing out clears the console cookie", async () => {
  const ctx = await setup();
  const response = await get(ctx.hub, "/admin/auth/logout", ctx.cookie);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("Set-Cookie"), /hub_admin_session=;.*Max-Age=0/);
});

// --- Open access and blocks --------------------------------------------------------------------

async function withSite(ctx = null) {
  ctx ??= await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "forum", url: "https://forum.example", name: "The forum" }, { cookie: ctx.cookie });
  return ctx;
}
const sitePageHtml = async (ctx, ns = "forum") => (await get(ctx.hub, `/admin/ns/${ns}`, ctx.cookie)).text();

test("a new site needs approval, and nothing at creation can make it open", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "forum", url: "https://forum.example", name: "The forum", access: "anyone" }, { cookie: ctx.cookie });
  assert.equal((await ctx.registry.getNamespace("forum")).access, "granted");

  const html = await sitePageHtml(ctx);
  assert.match(html, /Approved people only/);
  assert.match(html, /Open this site to anyone with a Telegram account/);
  assert.match(html, /keep its own accounts/i, "the responsibility shift is stated before the button");
});

test("the ordinary save form cannot change the access mode", async () => {
  const ctx = await withSite();
  await post(ctx.hub, "/admin/ns/forum/update", { name: "The forum", enabled: "1", access: "anyone" }, { cookie: ctx.cookie });
  assert.equal((await ctx.registry.getNamespace("forum")).access, "granted");
});

test("opening a site to everyone needs the id typed back; nothing changes without it", async () => {
  const ctx = await withSite();
  for (const confirm of [undefined, "", "FORUM", "other", "forum-2"]) {
    const response = await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", ...(confirm === undefined ? {} : { confirm }) }, { cookie: ctx.cookie });
    assert.equal(redirectTarget(response).searchParams.get("err"), "confirm_open", JSON.stringify(confirm));
  }
  assert.equal((await ctx.registry.getNamespace("forum")).access, "granted");
  assert.deepEqual((await ctx.registry.listAudit()).filter((e) => e.action === "site.access"), [], "refused attempts are not logged as changes");

  const done = await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", confirm: "forum" }, { cookie: ctx.cookie });
  const { html } = await follow(ctx, done);
  assert.match(html, /now open to anyone with a Telegram account/);
  assert.equal((await ctx.registry.getNamespace("forum")).access, "anyone");
  const entry = (await ctx.registry.listAudit())[0];
  assert.deepEqual([entry.actor, entry.action, entry.target, entry.detail], [ROOT.id, "site.access", "forum", "granted -> anyone"]);
});

test("stray whitespace around the typed id is forgiven, as it is when deleting a site", async () => {
  const ctx = await withSite();
  const response = await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", confirm: "  forum " }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(response).searchParams.get("ok"), "access_open");
});

test("an open site says so, hides the approval queue, and keeps the grant list for later", async () => {
  const ctx = await withSite();
  await ctx.registry.addGrant({ namespace: "forum", id: ALICE.id, label: "Alice" });
  await ctx.registry.recordRequest({ namespace: "forum", user: MALLORY });
  assert.match(await sitePageHtml(ctx), /Waiting for approval/);

  await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", confirm: "forum" }, { cookie: ctx.cookie });
  const html = await sitePageHtml(ctx);
  assert.match(html, /Anyone with Telegram/);
  assert.match(html, /responsible for its own accounts/);
  assert.doesNotMatch(html, /Waiting for approval/, "nobody to approve on an open site");
  assert.match(html, /Not used while this site is open to anyone/);
  assert.match(html, /Alice/, "the grants are still listed");
  assert.match(html, /Require approval again/);
  assert.doesNotMatch(html, /Open to anyone<\/button>/, "no second open button");
  assert.match(html, /never sees who is signed up/, "the hint about finding ids to block");
});

test("the dashboard shows an open site as open instead of as a head count", async () => {
  const ctx = await withSite();
  await ctx.registry.addGrant({ namespace: "forum", id: 1 });
  await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", confirm: "forum" }, { cookie: ctx.cookie });
  const html = await (await get(ctx.hub, "/admin", ctx.cookie)).text();
  assert.match(html, /<span class="pill warn">Anyone<\/span>/);
});

test("requiring approval again needs no confirmation, is audited, and locks out people without a grant", async () => {
  const ctx = await withSite();
  await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", confirm: "forum" }, { cookie: ctx.cookie });
  assert.equal((await ctx.registry.access("forum", MALLORY.id)).mode, "anyone");

  const back = await post(ctx.hub, "/admin/ns/forum/access", { mode: "granted" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(back).searchParams.get("ok"), "access_granted");
  assert.equal((await ctx.registry.getNamespace("forum")).access, "granted");
  assert.deepEqual((await ctx.registry.listAudit()).slice(0, 2).map((e) => e.detail), ["anyone -> granted", "granted -> anyone"]);
});

test("setting the mode a site already has changes and logs nothing; junk modes and missing sites are refused", async () => {
  const ctx = await withSite();
  const before = (await ctx.registry.listAudit()).length;
  const same = await post(ctx.hub, "/admin/ns/forum/access", { mode: "granted" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(same).search, "");
  assert.equal((await ctx.registry.listAudit()).length, before);

  for (const mode of ["open", "ANYONE", "", "true"]) {
    const response = await post(ctx.hub, "/admin/ns/forum/access", { mode, confirm: "forum" }, { cookie: ctx.cookie });
    assert.equal(redirectTarget(response).searchParams.get("err"), "bad_mode", JSON.stringify(mode));
  }
  const noMode = await post(ctx.hub, "/admin/ns/forum/access", { confirm: "forum" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(noMode).searchParams.get("err"), "bad_mode");
  const ghost = await post(ctx.hub, "/admin/ns/ghost/access", { mode: "anyone", confirm: "ghost" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(ghost).searchParams.get("err"), "site_missing");
  assert.equal((await ctx.registry.getNamespace("forum")).access, "granted");
});

test("changing the access mode is protected by the same CSRF and origin checks as everything else", async () => {
  const ctx = await withSite();
  const noToken = await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", confirm: "forum" }, { cookie: ctx.cookie, csrf: "nope" });
  assert.equal(redirectTarget(noToken).searchParams.get("err"), "bad_request");
  const crossOrigin = await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", confirm: "forum" }, { cookie: ctx.cookie, origin: "https://evil.example" });
  assert.equal(redirectTarget(crossOrigin).searchParams.get("err"), "bad_request");
  assert.equal((await ctx.registry.getNamespace("forum")).access, "granted");
});

test("blocking takes a list, is all-or-nothing, is capped, and is audited", async () => {
  const ctx = await withSite();
  const ok = await post(ctx.hub, "/admin/ns/forum/blocks", { ids: "9, 8\n9", label: "spam" }, { cookie: ctx.cookie });
  const { target, html } = await follow(ctx, ok);
  assert.deepEqual([target.searchParams.get("ok"), target.searchParams.get("n")], ["blocks_added", "2"]);
  assert.match(html, /Blocked 2 people/);
  const blocks = await ctx.registry.listBlocks("forum");
  assert.ok(blocks.every((b) => b.label === "spam" && b.addedBy === ROOT.id));
  assert.deepEqual(blocks.map((b) => b.id).sort(), [8, 9]);
  const entry = (await ctx.registry.listAudit())[0];
  assert.deepEqual([entry.action, entry.target], ["block.add", "forum"]);
  assert.match(entry.detail, /^2: /);

  assert.equal(redirectTarget(await post(ctx.hub, "/admin/ns/forum/blocks", { ids: "8, 9" }, { cookie: ctx.cookie })).searchParams.get("ok"), "blocks_none");
  for (const [ids, err] of [["7, abc", "bad_ids"], ["", "no_ids"], [Array.from({ length: 201 }, (_, n) => n + 1).join(","), "too_many_ids"]]) {
    assert.equal(redirectTarget(await post(ctx.hub, "/admin/ns/forum/blocks", { ids }, { cookie: ctx.cookie })).searchParams.get("err"), err);
  }
  assert.equal((await ctx.registry.listBlocks("forum")).length, 2, "a bad list blocks nobody");
});

test("blocking someone clears their pending request but leaves their grant alone", async () => {
  const ctx = await withSite();
  await ctx.registry.addGrant({ namespace: "forum", id: ALICE.id });
  await ctx.registry.recordRequest({ namespace: "forum", user: ALICE });
  await ctx.registry.recordRequest({ namespace: "forum", user: BOB });

  await post(ctx.hub, "/admin/ns/forum/blocks", { ids: String(ALICE.id) }, { cookie: ctx.cookie });
  assert.deepEqual((await ctx.registry.listRequests("forum")).map((r) => r.id), [BOB.id]);
  const state = await ctx.registry.access("forum", ALICE.id);
  assert.deepEqual([state.granted, state.blocked], [true, true]);

  await post(ctx.hub, `/admin/ns/forum/blocks/${ALICE.id}/remove`, {}, { cookie: ctx.cookie });
  assert.equal((await ctx.registry.access("forum", ALICE.id)).granted, true, "unblocking does not erase an earlier grant");
});

test("unblocking is audited, and a bad id never reaches the registry", async () => {
  const ctx = await withSite();
  await ctx.registry.addBlock({ namespace: "forum", id: 9 });
  const response = await post(ctx.hub, "/admin/ns/forum/blocks/9/remove", {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(response).searchParams.get("ok"), "block_removed");
  assert.equal((await ctx.registry.access("forum", 9)).blocked, false);
  assert.deepEqual((await ctx.registry.listAudit())[0].action, "block.remove");

  const bad = await post(ctx.hub, "/admin/ns/forum/blocks/not-an-id/remove", {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(bad).searchParams.get("err"), "bad_id");
  const again = await post(ctx.hub, "/admin/ns/forum/blocks/9/remove", {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(again).searchParams.get("ok"), "block_removed", "removing what is not there is not an error");
  assert.equal((await ctx.registry.listAudit()).filter((e) => e.action === "block.remove").length, 1, "and is not logged twice");
});

test("a queued request can be blocked straight from the queue", async () => {
  const ctx = await withSite();
  await ctx.registry.recordRequest({ namespace: "forum", user: { ...MALLORY, last_name: "Doe" } });
  assert.match(await sitePageHtml(ctx), />Block<\/button>/);

  const response = await post(ctx.hub, `/admin/ns/forum/requests/${MALLORY.id}/block`, {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(response).searchParams.get("ok"), "request_blocked");
  assert.equal(await ctx.registry.getRequest("forum", MALLORY.id), null);
  const [block] = await ctx.registry.listBlocks("forum");
  assert.deepEqual([block.id, block.label, block.addedBy], [MALLORY.id, "Mallory Doe (@mal)", ROOT.id]);
  assert.equal((await ctx.registry.access("forum", MALLORY.id)).granted, false, "blocking grants nothing");

  const gone = await post(ctx.hub, `/admin/ns/forum/requests/${MALLORY.id}/block`, {}, { cookie: ctx.cookie });
  assert.equal(redirectTarget(gone).searchParams.get("err"), "request_gone");
});

test("the blocked list is shown, escaped, and applies on open sites too", async () => {
  const ctx = await withSite();
  await post(ctx.hub, "/admin/ns/forum/access", { mode: "anyone", confirm: "forum" }, { cookie: ctx.cookie });
  const evil = `"><img src=x onerror=alert(1)>`;
  await post(ctx.hub, "/admin/ns/forum/blocks", { ids: "9", label: evil }, { cookie: ctx.cookie });
  const html = await sitePageHtml(ctx);
  assert.match(html, /Blocked people <span class="count">1<\/span>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, />Unblock<\/button>/);
});

test("deleting a site removes its block list, so a new site of the same name starts clean", async () => {
  const ctx = await withSite();
  await ctx.registry.addBlock({ namespace: "forum", id: 9 });
  await post(ctx.hub, "/admin/ns/forum/delete", { confirm: "forum" }, { cookie: ctx.cookie });
  await post(ctx.hub, "/admin/ns", { namespace: "forum", url: "https://forum.example", name: "Forum 2" }, { cookie: ctx.cookie });
  assert.deepEqual(await ctx.registry.listBlocks("forum"), []);
});

// --- Site URLs ---------------------------------------------------------------------------------

test("a site cannot be added without a URL, and a bad one creates nothing", async () => {
  const ctx = await setup();
  const err = async (url) =>
    redirectTarget(await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", ...(url === undefined ? {} : { url }) }, { cookie: ctx.cookie })).searchParams.get("err");

  for (const url of [undefined, "", "acme.example.com", "http://acme.example.com", "ftp://acme.example.com", "javascript:alert(1)", "https://user:pw@acme.example.com", "//acme.example.com", "https://" + "a".repeat(200) + ".example"]) {
    assert.equal(await err(url), "bad_url", JSON.stringify(url));
  }
  assert.equal(await ctx.registry.getNamespace("acme"), null);
});

test("the URL is stored as an origin: path, case and default port are dropped; localhost may use http", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", url: "https://Acme.Example.com:443/login?next=/x" }, { cookie: ctx.cookie });
  await post(ctx.hub, "/admin/ns", { namespace: "dev", name: "Dev", url: "http://localhost:8787/" }, { cookie: ctx.cookie });
  assert.deepEqual((await ctx.registry.getNamespace("acme")).origins, ["https://acme.example.com"]);
  assert.deepEqual((await ctx.registry.getNamespace("dev")).origins, ["http://localhost:8787"]);
  const entry = (await ctx.registry.listAudit()).find((e) => e.target === "acme");
  assert.match(entry.detail, /https:\/\/acme\.example\.com/, "the audit log records the bound URL");
});

test("the site page lists its URLs and the dashboard shows the first", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", url: "https://acme.example.com" }, { cookie: ctx.cookie });
  await ctx.registry.addOrigin("acme", "https://acme.workers.dev");

  const page = await (await get(ctx.hub, "/admin/ns/acme", ctx.cookie)).text();
  assert.match(page, /Site URLs <span class="count">2<\/span>/);
  assert.match(page, /<code>https:\/\/acme\.example\.com<\/code>/);
  assert.match(page, /<code>https:\/\/acme\.workers\.dev<\/code>/);
  assert.doesNotMatch(page, /Not bound to a URL/);

  const dash = await (await get(ctx.hub, "/admin", ctx.cookie)).text();
  assert.match(dash, /https:\/\/acme\.example\.com \+1/);
});

test("adding a URL is validated, de-duplicated, capped, and audited", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  const add = async (url) => redirectTarget(await post(ctx.hub, "/admin/ns/acme/origins", { url }, { cookie: ctx.cookie })).searchParams;

  const ok = await add("https://acme.workers.dev/anything");
  assert.equal(ok.get("ok"), "origin_added");
  assert.deepEqual((await ctx.registry.getNamespace("acme")).origins, ["https://acme.example", "https://acme.workers.dev"]);
  const entry = (await ctx.registry.listAudit())[0];
  assert.deepEqual([entry.action, entry.target, entry.detail], ["origin.add", "acme", "https://acme.workers.dev"]);

  assert.equal((await add("HTTPS://ACME.workers.dev")).get("err"), "origin_exists");
  for (const bad of ["", "nope", "http://acme.example", "ftp://x.example"]) assert.equal((await add(bad)).get("err"), "bad_url", JSON.stringify(bad));

  for (let n = 2; n < 10; n++) await ctx.registry.addOrigin("acme", `https://s${n}.example`);
  assert.equal((await add("https://eleventh.example")).get("err"), "too_many_origins");
  assert.equal((await ctx.registry.getNamespace("acme")).origins.length, 10);

  const ghost = await post(ctx.hub, "/admin/ns/ghost/origins", { url: "https://x.example" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(ghost).searchParams.get("err"), "site_missing");
});

test("removing a URL works until it is the last one, and is audited", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  await ctx.registry.addOrigin("acme", "https://acme.workers.dev");
  const remove = async (origin) => redirectTarget(await post(ctx.hub, "/admin/ns/acme/origins/remove", { origin }, { cookie: ctx.cookie })).searchParams;

  assert.equal((await remove("https://acme.workers.dev")).get("ok"), "origin_removed");
  assert.deepEqual((await ctx.registry.getNamespace("acme")).origins, ["https://acme.example"]);
  assert.deepEqual((await ctx.registry.listAudit())[0].action, "origin.remove");

  assert.equal((await remove("https://acme.example")).get("err"), "origin_last");
  assert.equal((await remove("https://never-added.example")).get("err"), "origin_missing");
  assert.equal((await remove("not a url")).get("err"), "origin_missing");
  assert.deepEqual((await ctx.registry.getNamespace("acme")).origins, ["https://acme.example"]);

  const page = await (await get(ctx.hub, "/admin/ns/acme", ctx.cookie)).text();
  assert.match(page, /only URL/, "the last URL has no Remove button");
  assert.doesNotMatch(page, /name="origin" value="https:\/\/acme\.example"/);
});

test("a legacy site with no URL is flagged everywhere until it is bound", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "old", name: "Old site", url: "https://old.example" }, { cookie: ctx.cookie });
  ctx.registry.namespaces.get("old").origins = []; // as left by the upgrade script

  const dash = await (await get(ctx.hub, "/admin", ctx.cookie)).text();
  assert.match(dash, /Not bound to a URL/);
  const page = await (await get(ctx.hub, "/admin/ns/old", ctx.cookie)).text();
  assert.match(page, /<h2>Not bound to a URL<\/h2>/);
  assert.match(page, /any Worker with the hub's shared bindings/);

  await post(ctx.hub, "/admin/ns/old/origins", { url: "https://old.example" }, { cookie: ctx.cookie });
  assert.doesNotMatch(await (await get(ctx.hub, "/admin/ns/old", ctx.cookie)).text(), /<h2>Not bound to a URL<\/h2>/);
  assert.doesNotMatch(await (await get(ctx.hub, "/admin", ctx.cookie)).text(), /Not bound to a URL/);
});

test("URL changes are protected by the same CSRF and origin checks as everything else", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  const bad = await post(ctx.hub, "/admin/ns/acme/origins", { url: "https://evil.example" }, { cookie: ctx.cookie, csrf: "nope" });
  assert.equal(redirectTarget(bad).searchParams.get("err"), "bad_request");
  const cross = await post(ctx.hub, "/admin/ns/acme/origins", { url: "https://evil.example" }, { cookie: ctx.cookie, origin: "https://evil.example" });
  assert.equal(redirectTarget(cross).searchParams.get("err"), "bad_request");
  const rm = await post(ctx.hub, "/admin/ns/acme/origins/remove", { origin: "https://acme.example" }, { cookie: ctx.cookie, csrf: "nope" });
  assert.equal(redirectTarget(rm).searchParams.get("err"), "bad_request");
  assert.deepEqual((await ctx.registry.getNamespace("acme")).origins, ["https://acme.example"]);
});

test("end to end: a site added in the console works from its URL and from nowhere else", async () => {
  const { makeSite, startUpdate, webhookRequest, lastReply, login } = await import("./hub-helpers.mjs");
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "docs", name: "Docs", url: "https://docs.example" }, { cookie: ctx.cookie });
  await ctx.registry.addGrant({ namespace: "docs", id: ALICE.id });
  const docs = makeSite(ctx, "docs");

  const real = await login(docs);
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start docs_${real.token}`, ALICE)));
  assert.equal((await ctx.store.get(real.token, "docs")).status, "confirmed");

  const fake = await login(docs, "https://not-docs.example");
  await ctx.hub.webhook(webhookRequest(startUpdate(`/start docs_${fake.token}`, ALICE)));
  assert.match(lastReply(ctx.telegram), /isn't registered for Docs/);
  assert.equal((await ctx.store.get(fake.token, "docs")).status, "pending");
});

// --- Adding a site in two steps, with a suggested id the admin can change -----------------------

const inputValue = (html, name) => html.match(new RegExp(`<input name="${name}" value="([^"]*)"`))?.[1];

test("adding a site starts with a name and a URL only, and the id is not asked for yet", async () => {
  const ctx = await setup();
  const html = await (await get(ctx.hub, "/admin", ctx.cookie)).text();
  assert.match(html, new RegExp(`action="/admin/ns/new"`));
  assert.doesNotMatch(html, /<input name="namespace"/, "no id box on the first step");
  assert.match(html, />Continue<\/button>/);
});

test("step one shows a confirmation page with a suggested, editable id, and saves nothing", async () => {
  const ctx = await setup();
  const before = (await ctx.registry.listAudit()).length;
  const response = await post(ctx.hub, "/admin/ns/new", { name: "Internal docs", url: "https://Docs.Example.com/login" }, { cookie: ctx.cookie });
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.equal(inputValue(html, "namespace"), "internal-docs", "suggested from the display name");
  assert.equal(inputValue(html, "name"), "Internal docs");
  assert.equal(inputValue(html, "url"), "https://docs.example.com", "shown as the origin that will be bound");
  assert.match(html, /action="\/admin\/ns"/, "the final save is the ordinary create");
  assert.match(html, /name="csrf" value="[0-9a-f]+"/);
  assert.match(html, /cannot be changed afterwards/);

  assert.deepEqual(await ctx.registry.listNamespaces(), [], "nothing is created until the admin confirms");
  assert.equal((await ctx.registry.listAudit()).length, before);
});

test("with no display name the id is suggested from the URL; a taken id gets a suffix", async () => {
  const ctx = await setup();
  const first = await (await post(ctx.hub, "/admin/ns/new", { name: "", url: "https://docs.example.com" }, { cookie: ctx.cookie })).text();
  assert.equal(inputValue(first, "namespace"), "docs");
  assert.match(first, /Suggested from the URL/);

  await post(ctx.hub, "/admin/ns", { namespace: "docs", name: "Docs", url: "https://docs.example.com" }, { cookie: ctx.cookie });
  const second = await (await post(ctx.hub, "/admin/ns/new", { name: "Docs", url: "https://other.example.com" }, { cookie: ctx.cookie })).text();
  assert.equal(inputValue(second, "namespace"), "docs-2");
});

test("the admin can rename the suggestion before saving, and the id they chose is the one that is saved", async () => {
  const ctx = await setup();
  const preview = await (await post(ctx.hub, "/admin/ns/new", { name: "Internal docs", url: "https://docs.example.com" }, { cookie: ctx.cookie })).text();
  assert.equal(inputValue(preview, "namespace"), "internal-docs");

  // What the browser submits after the admin changes the id box.
  const saved = await post(ctx.hub, "/admin/ns", { namespace: "docs", name: inputValue(preview, "name"), url: inputValue(preview, "url") }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(saved).pathname, "/admin/ns/docs");
  assert.ok(await ctx.registry.getNamespace("docs"));
  assert.equal(await ctx.registry.getNamespace("internal-docs"), null);
  assert.deepEqual((await ctx.registry.getNamespace("docs")).origins, ["https://docs.example.com"]);
});

test("step one refuses a missing or bad URL before showing anything", async () => {
  const ctx = await setup();
  for (const url of [undefined, "", "docs.example.com", "http://docs.example.com", "javascript:alert(1)"]) {
    const response = await post(ctx.hub, "/admin/ns/new", { name: "Docs", ...(url === undefined ? {} : { url }) }, { cookie: ctx.cookie });
    assert.equal(redirectTarget(response).searchParams.get("err"), "bad_url", JSON.stringify(url));
  }
});

test("step one is a POST only, with the same CSRF and origin checks, so a link cannot pre-fill it", async () => {
  const ctx = await setup();
  assert.equal((await get(ctx.hub, "/admin/ns/new?name=Evil&url=https://evil.example", ctx.cookie)).status, 404, "GET is just the page of a site called 'new', which does not exist");
  assert.match(await (await get(ctx.hub, "/admin/ns/new?name=Evil&url=https://evil.example", ctx.cookie)).text(), /does not exist/);
  assert.doesNotMatch(await (await get(ctx.hub, "/admin/ns/new?name=Evil&url=https://evil.example", ctx.cookie)).text(), /evil\.example/);

  const noToken = await post(ctx.hub, "/admin/ns/new", { name: "Docs", url: "https://docs.example.com" }, { cookie: ctx.cookie, csrf: "nope" });
  assert.equal(redirectTarget(noToken).searchParams.get("err"), "bad_request");
  const cross = await post(ctx.hub, "/admin/ns/new", { name: "Docs", url: "https://docs.example.com" }, { cookie: ctx.cookie, origin: "https://evil.example" });
  assert.equal(redirectTarget(cross).searchParams.get("err"), "bad_request");
  const signedOut = await post(ctx.hub, "/admin/ns/new", { name: "Docs", url: "https://docs.example.com" });
  assert.doesNotMatch(await signedOut.text(), /Add a site/);
});

test("what the admin typed is escaped when it is shown back to them", async () => {
  const ctx = await setup();
  const evil = `"><img src=x onerror=alert(1)>`;
  const html = await (await post(ctx.hub, "/admin/ns/new", { name: evil, url: "https://docs.example.com" }, { cookie: ctx.cookie })).text();
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(inputValue(html, "namespace").match(/^[a-z0-9-]+$/) !== null, true, "the suggestion is always a plain id");
});

test("a site named 'new' does not collide with the first step", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "new", name: "New", url: "https://new.example" }, { cookie: ctx.cookie });
  assert.match(await (await get(ctx.hub, "/admin/ns/new", ctx.cookie)).text(), /Site URLs/, "its own page");
  const update = await post(ctx.hub, "/admin/ns/new/update", { name: "Renamed", enabled: "1" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(update).searchParams.get("ok"), "site_saved");
  const step = await post(ctx.hub, "/admin/ns/new", { name: "Other", url: "https://other.example" }, { cookie: ctx.cookie });
  assert.equal(step.status, 200);
  assert.equal(inputValue(await step.text(), "namespace"), "other");
});

// --- One URL, one site ---------------------------------------------------------------------------

test("a URL that already belongs to another site is refused at every way in, and nothing is changed", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  await post(ctx.hub, "/admin/ns", { namespace: "docs", name: "Docs", url: "https://docs.example" }, { cookie: ctx.cookie });
  const audit = (await ctx.registry.listAudit()).length;

  // Step one: caught before the confirmation page is even shown.
  const step = await post(ctx.hub, "/admin/ns/new", { name: "Copy", url: "https://Acme.Example/other/path" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(step).searchParams.get("err"), "origin_in_use");

  // The final save, posted directly (a stale page, or a race after step one).
  const create = await post(ctx.hub, "/admin/ns", { namespace: "copy", name: "Copy", url: "https://acme.example" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(create).searchParams.get("err"), "origin_in_use");
  assert.equal(await ctx.registry.getNamespace("copy"), null);

  // Giving another site's URL to this one.
  const add = await post(ctx.hub, "/admin/ns/docs/origins", { url: "https://acme.example" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(add).searchParams.get("err"), "origin_in_use");
  assert.deepEqual((await ctx.registry.getNamespace("docs")).origins, ["https://docs.example"]);
  assert.deepEqual((await ctx.registry.getNamespace("acme")).origins, ["https://acme.example"]);

  assert.equal((await ctx.registry.listAudit()).length, audit, "refusals are not logged as changes");
  const html = await (await get(ctx.hub, "/admin?err=origin_in_use", ctx.cookie)).text();
  assert.match(html, /already belongs to another site/);
});

test("a URL becomes available the moment its site lets go of it", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  await ctx.registry.addOrigin("acme", "https://acme.workers.dev");
  await post(ctx.hub, "/admin/ns/acme/origins/remove", { origin: "https://acme.workers.dev" }, { cookie: ctx.cookie });

  const moved = await post(ctx.hub, "/admin/ns", { namespace: "next", name: "Next", url: "https://acme.workers.dev" }, { cookie: ctx.cookie });
  assert.equal(redirectTarget(moved).pathname, "/admin/ns/next");
});

test("the pages tell the operator the site's code needs no id", async () => {
  const ctx = await setup();
  await post(ctx.hub, "/admin/ns", { namespace: "acme", name: "Acme", url: "https://acme.example" }, { cookie: ctx.cookie });
  const page = await (await get(ctx.hub, "/admin/ns/acme", ctx.cookie)).text();
  assert.match(page, /does not need it/);
  assert.doesNotMatch(page, /namespace: &quot;acme&quot;|namespace: "acme"/, "no instruction to hard-code the id");
  const step = await (await post(ctx.hub, "/admin/ns/new", { name: "Docs", url: "https://docs.example" }, { cookie: ctx.cookie })).text();
  assert.match(step, /does not need to know it/);
});
