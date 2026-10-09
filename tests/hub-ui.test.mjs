// The console's visual layer: its helpers, its page shell, and the promises that matter beyond looks —
// landmarks and labels for assistive technology, escaping, and no request ever leaving the page.

import test from "node:test";
import assert from "node:assert/strict";

import { icon, avatar, initialsOf, activityIcon, renderShell, STYLES } from "../src/hub/console-ui.js";
import { makeRequest } from "./helpers.mjs";
import { ROOT, makeHub, signInToConsole, get, post, ORIGIN } from "./hub-helpers.mjs";

const site = (n, extra = {}) => ({ namespace: `site-${n}`, name: `Site ${n}`, enabled: true, access: "granted", origins: [`https://s${n}.example`], users: n, requests: 0, ...extra });
const shell = (over = {}) => renderShell({ title: "T", body: "<p>body</p>", adminPath: "/admin", session: { name: "Rhea", id: 1000 }, sites: [], ...over });

test("icons are decorative inline SVG, and an unknown name is empty rather than an error", () => {
  const svg = icon("check");
  assert.match(svg, /^<svg class="i" [^>]*aria-hidden="true"[^>]*>.+<\/svg>$/);
  assert.match(icon("plus", "big"), /class="big"/);
  assert.doesNotThrow(() => icon("no-such-icon"));
  assert.match(icon("no-such-icon"), /<svg[^>]*><\/svg>/);
});

test("initials: two words give two letters, one gives one, and nothing usable gives a hash sign", () => {
  assert.equal(initialsOf("Internal docs"), "ID");
  assert.equal(initialsOf("  acme  "), "A");
  assert.equal(initialsOf("The quick brown fox"), "TQ");
  assert.equal(initialsOf("Édouard Müller"), "ÉM");
  assert.equal(initialsOf("日本語 サイト"), "日サ");
  assert.equal(initialsOf("42 apples"), "4A");
  for (const nothing of ["", "   ", "!!! ???", null, undefined]) assert.equal(initialsOf(nothing), "#", JSON.stringify(nothing));
});

test("an avatar is escaped, hidden from screen readers, sized, and the same seed is always the same colour", () => {
  const evil = avatar(`<img src=x onerror=alert(1)>`, "seed");
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /aria-hidden="true"/);
  assert.match(avatar("A", "s", "lg"), /class="av lg"/);
  assert.equal(avatar("A", "same"), avatar("A", "same"));
  const hue = (html) => Number(html.match(/--h:(\d+)/)[1]);
  assert.ok(hue(avatar("A", "x")) >= 0 && hue(avatar("A", "x")) < 360);
  const hues = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((seed) => hue(avatar("A", seed))));
  assert.ok(hues.size >= 6, "different seeds give a spread of colours");
});

test("activity entries get the icon of what they were about", () => {
  assert.equal(activityIcon("site.create"), "grid");
  assert.equal(activityIcon("origin.add"), "globe");
  assert.equal(activityIcon("grant.remove"), "users");
  assert.equal(activityIcon("block.add"), "ban");
  assert.equal(activityIcon("request.dismiss"), "bell");
  assert.equal(activityIcon("admin.add"), "shield");
  assert.equal(activityIcon("something.else"), "activity");
});

test("the shell has landmarks, a skip link and a labelled main navigation", () => {
  const html = shell();
  assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /<nav class="nav" aria-label="Main">/);
  assert.match(html, /<aside class="side">/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<title>T · Hub admin<\/title>/);
});

test("the current page is marked for assistive technology, on the overview and on a site", () => {
  const sites = [site(1), site(2)];
  const overview = shell({ sites });
  assert.match(overview, /<a href="\/admin" class="on" aria-current="page">/);
  const sitesNav = overview.match(/<nav class="nav sites-nav"[^]*?<\/nav>/)[0];
  assert.doesNotMatch(sitesNav, /aria-current/, "no site is current on the overview");
  assert.equal((sitesNav.match(/<a /g) ?? []).length, 2);
  const onSite = shell({ sites, active: "site-2" });
  assert.match(onSite, /<a href="\/admin\/ns\/site-2" class="on" aria-current="page">/);
  assert.doesNotMatch(onSite, /<a href="\/admin" class="on"/);
});

test("the sidebar lists at most ten sites, says how many more, and counts people waiting on approved sites only", () => {
  const many = Array.from({ length: 13 }, (_, n) => site(n + 1));
  const html = shell({ sites: many });
  assert.equal((html.match(/href="\/admin\/ns\/site-/g) ?? []).length, 10);
  assert.match(html, /\+3 more/);

  const withRequests = shell({ sites: [site(1, { requests: 4, access: "approval" }), site(2, { requests: 9, access: "anyone" }), site(3, { requests: 7 })] });
  assert.match(withRequests, /<span class="n warn">4<\/span>/);
  assert.doesNotMatch(withRequests, />9</, "an open site has nobody to approve");
  assert.doesNotMatch(withRequests, />7</, "an invite-only site has no queue, whatever is left in storage");
});

test("a switched-off site shows an off dot, and everything user-supplied in the shell is escaped", () => {
  const evil = `<script>alert(1)</script>`;
  const html = shell({ session: { name: evil, id: `"><b>` }, sites: [site(1, { name: evil, enabled: false })] });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /"><b>/);
  assert.match(html, /class="dot off"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("the shell has a sign-out link that says what it is, since it is only an icon", () => {
  assert.match(shell(), /<a class="icon-btn" href="\/admin\/auth\/logout" title="Sign out" aria-label="Sign out">/);
});

test("the stylesheet respects reduced motion and the system's dark setting, and asks for nothing from the network", () => {
  assert.match(STYLES, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(STYLES, /@media \(prefers-color-scheme:dark\)/);
  assert.match(STYLES, /a:focus-visible,button:focus-visible\{outline:/, "keyboard focus is always visible");
  assert.doesNotMatch(STYLES, /@import|url\(\s*["']?https?:|@font-face/i);
});

test("every console page is self-contained: one local-time script, no external requests, and the only image is its own icon", async () => {
  const ctx = makeHub();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  await post(ctx.hub, "/admin/ns", { namespace: "docs", name: "Docs", url: "https://docs.example" }, { cookie });
  const pages = [
    await get(ctx.hub, "/admin", cookie),
    await get(ctx.hub, "/admin/ns/docs", cookie),
    await post(ctx.hub, "/admin/ns/new", { name: "Other", url: "https://other.example" }, { cookie }),
    await get(ctx.hub, "/admin/ns/ghost", cookie),
  ];
  for (const response of pages) {
    const html = await response.text();
    assert.equal(html.match(/<script/gi).length, 1);
    assert.doesNotMatch(html, /\s(?:src|href|action|poster|srcset)=["']https?:/i, "nothing points off this origin");
    assert.doesNotMatch(html, /url\(\s*["']?https?:|@import/i);
    assert.doesNotMatch(html.replace(/<link rel="icon" href="data:[^"]*">/, ""), /data:/, "the tab icon is the one data: URI");
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
    const csp = response.headers.get("Content-Security-Policy");
    assert.match(csp, /img-src data:;/);
    assert.doesNotMatch(csp, /unsafe-eval|https?:/);
  }
});

test("the overview adds up the sites, people, requests and admins it shows", async () => {
  const ctx = makeHub();
  const cookie = await signInToConsole(ctx.hub, ROOT);
  for (const [ns, url] of [["a", "https://a.example"], ["b", "https://b.example"], ["c", "https://c.example"]]) {
    await post(ctx.hub, "/admin/ns", { namespace: ns, name: ns.toUpperCase(), url }, { cookie });
  }
  await ctx.registry.addGrant({ namespace: "a", id: 1 });
  await ctx.registry.addGrant({ namespace: "a", id: 2 });
  await ctx.registry.addGrant({ namespace: "b", id: 3 });
  await ctx.registry.updateNamespace("a", { access: "approval" });
  await ctx.registry.recordRequest({ namespace: "a", user: { id: 9 } });
  await ctx.registry.recordRequest({ namespace: "b", user: { id: 7 } }); // left over from before b was invite only: not shown
  await ctx.registry.recordRequest({ namespace: "c", user: { id: 8 } });
  await post(ctx.hub, "/admin/ns/c/access", { mode: "anyone", confirm: "c" }, { cookie });
  await ctx.registry.addGrant({ namespace: "c", id: 4 }); // kept but not used: c is open
  await ctx.registry.addAdmin({ id: 2000 });

  const html = await (await get(ctx.hub, "/admin", cookie)).text();
  const stats = [...html.matchAll(/<div class="stat[^"]*"><span class="ic">.*?<\/span><b>(\d+)<\/b><span class="l">([^<]*)/g)].map((m) => [m[2].trim(), Number(m[1])]);
  assert.deepEqual(stats, [["Sites", 3], ["People with access", 3], ["Waiting for approval", 1], ["Super admins", 2]]);
  assert.match(html, /1 open to anyone/);
});
