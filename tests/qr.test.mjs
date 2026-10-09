import test from "node:test";
import assert from "node:assert/strict";

import { qrSvg, qrDataUri } from "../src/qr.js";
import vm from "node:vm";
import { renderLoginPage, pollScript, appLinkFromDeepLink } from "../src/login-page.js";
import { randomToken, tokenPattern, timingSafeEqualHex } from "../src/crypto.js";

const DEEP_LINK = "https://t.me/example_bot?start=cockpit_0123456789abcdef0123456789abcdef";

test("qrSvg produces a self-contained SVG with no external references", () => {
  const svg = qrSvg(DEEP_LINK);
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
  // The whole point: nothing is fetched to render this.
  assert.equal(/https?:\/\//.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")), false);
  assert.equal(/<image|<script|xlink:href/.test(svg), false);
});

test("qrSvg picks a version that fits, however long the link", () => {
  const short = qrSvg("https://t.me/b?start=a_1");
  const long = qrSvg(`https://auth.example.com/very/long/path?start=${"x".repeat(400)}`);
  const sizeOf = (svg) => Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
  assert.ok(sizeOf(long) > sizeOf(short));
});

test("qrSvg is styleable without breaking scannability", () => {
  const svg = qrSvg(DEEP_LINK, { cellSize: 8, margin: 6, dark: "#111827", light: "#f9fafb" });
  assert.match(svg, /fill="#111827"/);
  assert.match(svg, /fill="#f9fafb"/);
  // Quiet zone included in the canvas.
  const modules = qrSvg(DEEP_LINK, { cellSize: 1, margin: 0 }).match(/viewBox="0 0 (\d+)/)[1];
  const withMargin = qrSvg(DEEP_LINK, { cellSize: 1, margin: 6 }).match(/viewBox="0 0 (\d+)/)[1];
  assert.equal(Number(withMargin), Number(modules) + 12);
});

test("qrSvg escapes anything interpolated into attributes", () => {
  const svg = qrSvg(DEEP_LINK, { label: '"><script>alert(1)</script>' });
  assert.equal(/<script>/.test(svg), false);
  assert.match(svg, /&quot;&gt;&lt;script&gt;/);
});

test("qrDataUri returns a decodable image/svg+xml URI", () => {
  const uri = qrDataUri(DEEP_LINK);
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
  assert.match(decoded, /^<svg /);
});

test("the login page escapes the deep link and the branding it is given", () => {
  const html = renderLoginPage({
    token: "0".repeat(32),
    deepLink: 'https://t.me/bot?start=a"onload="alert(1)',
    qrSvg: "<svg></svg>",
    pollPath: "/auth/poll",
    error: "<img src=x onerror=alert(1)>",
    branding: { heading: "</h1><script>alert(1)</script>" },
  });
  assert.equal(/onload="alert/.test(html), false);
  assert.equal(/<img src=x/.test(html), false);
  assert.equal(/<script>alert\(1\)<\/script>/.test(html), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("the login page keeps search engines out and asks for no input", () => {
  const html = renderLoginPage({ token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", qrSvg: "<svg></svg>", pollPath: "/auth/poll" });
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.equal(/<input|<form|<textarea/i.test(html), false);
});

test("tokens are 128 bits of hex and match their own pattern", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const token = randomToken();
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(seen.has(token), false, "randomToken must not repeat");
    seen.add(token);
    assert.equal(tokenPattern().test(token), true);
  }
  assert.match(randomToken(32), /^[0-9a-f]{64}$/);
  assert.equal(tokenPattern(32).test(randomToken(32)), true);
  assert.equal(tokenPattern(16).test(randomToken(32)), false);
});

test("timingSafeEqualHex compares by value", () => {
  assert.equal(timingSafeEqualHex("abc123", "abc123"), true);
  assert.equal(timingSafeEqualHex("abc123", "abc124"), false);
  assert.equal(timingSafeEqualHex("abc123", "abc12"), false);
  assert.equal(timingSafeEqualHex("", ""), true);
});

const APP_LINK_HTML = "tg://resolve?domain=b&amp;start=a_1";

test("the QR encodes the https link but, like the button, opens the tg:// app link in place", () => {
  const html = renderLoginPage({ token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", qrSvg: "<svg></svg>", pollPath: "/auth/poll" });
  const qr = html.match(/<div class="tqa-qr" id="tqa-qr">(.*?)<\/div>/s)[1];
  assert.match(qr, new RegExp(`<a [^>]*href="${APP_LINK_HTML.replace(/[?.]/g, "\\$&")}"`));
  // A new tab would be left behind as a blank page; an app link never navigates this one away.
  assert.doesNotMatch(qr, /target=/);
  assert.match(qr, /<svg><\/svg>/, "the QR image must sit inside the link");
});

test("an explicit appLink wins over the derived one", () => {
  const html = renderLoginPage({ token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", appLink: "tg://x", qrSvg: "", pollPath: "/p" });
  assert.match(html, /id="tqa-open" href="tg:\/\/x"/);
});

test("appLinkFromDeepLink maps t.me links and leaves anything else alone", () => {
  assert.equal(appLinkFromDeepLink("https://t.me/example_bot?start=cockpit_abc"), "tg://resolve?domain=example_bot&start=cockpit_abc");
  assert.equal(appLinkFromDeepLink("https://t.me/example_bot"), "tg://resolve?domain=example_bot");
  assert.equal(appLinkFromDeepLink("https://example.com/x?start=1"), "https://example.com/x?start=1");
  assert.equal(appLinkFromDeepLink("not a url"), "not a url");
});

test("touch devices get an Open Telegram button, a hint and a way to show the QR; all of it is customisable", () => {
  const html = renderLoginPage({
    token: "0".repeat(32),
    deepLink: "https://t.me/b?start=a_1",
    qrSvg: "<svg></svg>",
    pollPath: "/auth/poll",
    branding: { mobileLinkText: "Ouvrir Telegram", tabletLinkText: "Ouvrir Telegram sur cette tablette", mobileSubtitle: "Touchez le bouton", qrHintText: "Cliquez sur le code", showQrText: "Un autre appareil ?", showAppText: "Telegram est ici ?", scanText: "Scannez" },
  });
  assert.match(html, /<a class="tqa-open" id="tqa-open" href="tg:\/\/resolve\?domain=b&amp;start=a_1"><span class="tqa-lbl-short">Ouvrir Telegram<\/span><span class="tqa-lbl-long">Ouvrir Telegram sur cette tablette<\/span><svg/);
  assert.match(html, /class="tqa-how" id="tqa-how">Touchez le bouton</);
  assert.match(html, /class="tqa-here" id="tqa-here" href="tg:\/\/resolve\?domain=b&amp;start=a_1">Cliquez sur le code</);
  assert.match(html, /id="tqa-show-qr">Un autre appareil \?<\/button>/);
  assert.match(html, /id="tqa-show-app">Telegram est ici \?<\/button>/);
  assert.match(html, /<span class="tqa-cap-main">Scannez<\/span>/);
  assert.match(html, /@media \(hover: none\) and \(pointer: coarse\)/);
});

test("on a phone the button leads and the QR is one tap away; the page remembers which view it is in", () => {
  const html = renderLoginPage({ token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", qrSvg: "", pollPath: "/p" });
  assert.match(html, /<html lang="en" data-tqa-state="waiting" data-tqa-view="app">/);
  assert.match(html, /html\[data-tqa-view="app"\] \.tqa-qr \{ display: none; \}/, "the QR is tucked away until it is asked for");
  assert.match(html, /html\[data-tqa-view="qr"\] \.tqa-app \{ display: none; \}/);
  assert.match(html, /setAttribute\("data-tqa-view", name\)[^]*?getElementById\("tqa-show-qr"\)[^]*?addEventListener\("click", view\("qr"\)\)/);
});

test("the default copy does not claim Start must be pressed: only first-time chats show the button", () => {
  const html = renderLoginPage({ token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", qrSvg: "", pollPath: "/p" });
  // "Tap Start, then Approve" is what the pass says it will take; the status moves on by itself when
  // a returning user has no Start button to press, and the page never tells anyone to type anything.
  assert.match(html, /class="tqa-how" id="tqa-how">Tap Start, then Approve\. Come back here when you&#39;re done\./);
  assert.match(html, /<dt>Phone number<\/dt><dd>Not needed<\/dd>/);
  assert.match(html, /<dt>Code to type<\/dt><dd>None<\/dd>/);
  assert.doesNotMatch(html, /Press Start|Tap Start at the bottom/);
});

test("branding text cannot close the script element it is embedded in", () => {
  const html = renderLoginPage({
    token: "0".repeat(32),
    deepLink: "https://t.me/b?start=a_1",
    qrSvg: "",
    pollPath: "/p",
    branding: { successText: "</script><script>alert(1)</script>" },
  });
  assert.equal(html.match(/<\/script>/g).length, 1);
});

/**
 * Runs pollScript against a minimal fake DOM, with fetch and timers under the test's control.
 * `respond(status)` settles the oldest outstanding poll.
 */
function runPollScript(options = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, { id, hidden: false, textContent: "", children: [], appendChild(child) { this.children.push(child); } });
    }
    return elements.get(id);
  };
  for (const id of ["tqa-status", "tqa-qr", "tqa-open", "tqa-hint"]) element(id);

  const listeners = {};
  const rootAttributes = {};
  const timers = new Map();
  let nextTimer = 1;
  const pending = [];
  const document = {
    visibilityState: "visible",
    documentElement: { setAttribute: (name, value) => (rootAttributes[name] = value) },
    getElementById: (id) => elements.get(id) ?? null,
    createElement: () => ({ addEventListener() {} }),
    addEventListener: (type, fn) => (listeners[type] = fn),
  };
  const windowListeners = {};
  const window = { location: { href: "/auth/login", reload() {} }, addEventListener: (type, fn) => (windowListeners[type] = fn) };
  const context = {
    document,
    window,
    fetch: (url) => new Promise((resolve) => pending.push({ url, resolve })),
    setTimeout: (fn, delay) => {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    encodeURIComponent,
  };
  vm.runInNewContext(pollScript({ token: "t0k", pollPath: "/auth/poll", redirectTo: "/next", pollIntervalMs: 2000, ...options }), context);

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    elements,
    rootAttributes,
    timers,
    pending,
    window,
    document,
    fireTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const { fn } of due) fn();
    },
    showTab() {
      document.visibilityState = "visible";
      listeners.visibilitychange();
    },
    fireWindow(type, event) {
      windowListeners[type](event);
    },
    async respond(status) {
      pending.shift().resolve({ json: async () => ({ status }) });
      await flush();
    },
  };
}

test("pollScript: polls on a timer and follows the redirect when confirmed", async () => {
  const page = runPollScript();
  assert.equal(page.rootAttributes["data-tqa-state"], "waiting");
  assert.equal(page.timers.size, 1);
  page.fireTimers();
  assert.equal(page.pending.length, 1);
  assert.equal(page.pending[0].url, "/auth/poll?token=t0k");

  await page.respond("pending");
  assert.equal(page.timers.size, 1, "exactly one next poll is scheduled");
  page.fireTimers();
  await page.respond("confirmed");
  assert.equal(page.window.location.href, "/next");
  assert.equal(page.rootAttributes["data-tqa-state"], "signed-in");
  assert.equal(page.timers.size, 0);
});

test("pollScript: returning to the tab polls at once, without starting a second loop", async () => {
  const page = runPollScript();
  page.showTab();
  assert.equal(page.pending.length, 1, "polled immediately");
  assert.equal(page.timers.size, 0, "the pending timer was replaced, not doubled");

  page.showTab();
  assert.equal(page.pending.length, 1, "no second request while one is in flight");

  await page.respond("pending");
  assert.equal(page.timers.size, 1);
});

test("pollScript: expired and denied stop the loop and hide the dead links", async () => {
  const expired = runPollScript();
  expired.fireTimers();
  await expired.respond("expired");
  assert.equal(expired.elements.get("tqa-open").hidden, true);
  assert.equal(expired.elements.get("tqa-hint").hidden, true);
  assert.equal(expired.elements.get("tqa-qr").children.length, 1, "the QR was replaced by a retry button");
  assert.equal(expired.rootAttributes["data-tqa-state"], "expired");
  expired.showTab();
  assert.equal(expired.pending.length, 0, "nothing polls after the sign-in is over");

  const denied = runPollScript({ texts: { denied: "Nope" } });
  denied.fireTimers();
  await denied.respond("denied");
  assert.equal(denied.elements.get("tqa-status").textContent, "Nope");
  assert.equal(denied.elements.get("tqa-open").hidden, true);
  assert.equal(denied.rootAttributes["data-tqa-state"], "denied");
  assert.equal(denied.timers.size, 0);
});

test("pollScript: invalid is treated as expired, and custom ids are honoured", async () => {
  const page = runPollScript({ ids: { status: "tqa-status", qr: null, hide: ["tqa-hint"] } });
  page.fireTimers();
  await page.respond("invalid");
  assert.equal(page.rootAttributes["data-tqa-state"], "expired");
  assert.equal(page.elements.get("tqa-hint").hidden, true);
  assert.equal(page.elements.get("tqa-open").hidden, false, "only the listed ids are hidden");
  assert.equal(page.elements.get("tqa-qr").children.length, 0, "no QR container, no retry button");
});

test("pollScript: a page restored from the back/forward cache polls at once; an ordinary pageshow does not", async () => {
  const page = runPollScript();
  page.fireWindow("pageshow", { persisted: false });
  assert.equal(page.pending.length, 0, "a normal load is not a return");
  page.fireWindow("pageshow", { persisted: true });
  assert.equal(page.pending.length, 1, "restored from the cache: ask now");
  page.fireWindow("pageshow", { persisted: true });
  assert.equal(page.pending.length, 1, "never a second request while one is in flight");
  await page.respond("pending");
  assert.equal(page.timers.size, 1);
});

test("pollScript: refocusing the window polls at once, and a finished page stays finished", async () => {
  const page = runPollScript();
  page.fireWindow("focus");
  assert.equal(page.pending.length, 1);
  await page.respond("expired");
  page.fireWindow("focus");
  page.fireWindow("pageshow", { persisted: true });
  assert.equal(page.pending.length, 0, "an expired code is not polled again");
});

test("pollScript: still runs where the window cannot take listeners", () => {
  // A minimal environment (an old webview, a test double) must not stop the page working.
  const context = { document: { visibilityState: "visible", documentElement: { setAttribute() {} }, getElementById: () => null, createElement: () => ({ addEventListener() {} }), addEventListener() {} }, window: { location: { href: "/" } }, fetch: () => new Promise(() => {}), setTimeout: () => 1, clearTimeout() {}, encodeURIComponent };
  assert.doesNotThrow(() => vm.runInNewContext(pollScript({ token: "t0k", pollPath: "/auth/poll" }), context));
});

// --- The page can say which site it is --------------------------------------------------------------

const PAGE = { token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", qrSvg: "<svg></svg>", pollPath: "/auth/poll" };
const visibleText = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the sign-in page names the site and shows where it is served from, when it is told them", () => {
  const html = renderLoginPage({ ...PAGE, site: { name: "Courier", host: "courier.jitdor.com" } });
  assert.match(html, /<title>Sign in to Courier<\/title>/);
  assert.match(html, /<div class="tqa-brand"><span class="tqa-mark" aria-hidden="true">C<\/span><span class="tqa-brand-name">Courier<\/span><\/div>/);
  assert.match(html, /<span class="tqa-host">courier\.jitdor\.com<\/span>/);
  assert.match(html, /<p class="tqa-name"[^>]*>Courier<\/p>/);
  assert.match(html, /<dt>Destination<\/dt><dd>courier\.jitdor\.com<\/dd>/);
  assert.match(visibleText(html), /Courier courier\.jitdor\.com/);
});

test("the pass is named from what the page knows: the site's name, branding.siteName, or the address it is served from", () => {
  const hostOnly = renderLoginPage({ ...PAGE, site: { host: "docs.example.com:8443" } });
  assert.match(hostOnly, /<span class="tqa-host">docs\.example\.com:8443</);
  assert.match(hostOnly, /<span class="tqa-brand-name">Docs<\/span>/, "named after the first label of the host");

  const nameOnly = renderLoginPage({ ...PAGE, site: { name: "Docs" } });
  assert.match(nameOnly, /<title>Sign in to Docs<\/title>/);
  assert.doesNotMatch(nameOnly, /<span class="tqa-host">/);

  const fromOrigin = renderLoginPage({ ...PAGE, origin: "https://courier.jitdor.com" });
  assert.match(fromOrigin, /<span class="tqa-host">courier\.jitdor\.com</, "a standalone app shows where it is served from");
  assert.match(fromOrigin, /<span class="tqa-brand-name">Courier<\/span>/);

  const named = renderLoginPage({ ...PAGE, origin: "https://courier.jitdor.com", branding: { siteName: "Courier Ops" } });
  assert.match(named, /<span class="tqa-brand-name">Courier Ops<\/span>/);
  assert.match(named, /<span class="tqa-mark" aria-hidden="true">C<\/span>/, "the mark is the first letter only");

  const bare = renderLoginPage({ ...PAGE, origin: "http://localhost:3000" });
  assert.doesNotMatch(bare, /<span class="tqa-brand-name">/, "no usable name: just the mark");
  assert.match(bare, /<span class="tqa-mark" aria-hidden="true"><svg/);
});

test("a page that sets its own headline or title keeps them", () => {
  const html = renderLoginPage({ ...PAGE, branding: { heading: "📈 Dashboard", scanHeading: "Scan me.", title: "Acme" }, site: { name: "Internal docs", host: "docs.example.com" } });
  assert.match(html, /<span class="tqa-v tqa-v-wait">📈 Dashboard<\/span>/);
  assert.match(html, /<span class="tqa-h-scan">Scan me\.<\/span>/);
  assert.match(html, /<title>Acme<\/title>/);
  assert.match(html, /<span class="tqa-host">docs\.example\.com</, "but the host is still shown");
});

test("without a site the page still reads as a pass, with the headline and no address", () => {
  const html = renderLoginPage(PAGE);
  assert.doesNotMatch(html, /<p class="tqa-site"/);
  assert.match(html, /<h1 class="tqa-headline">/);
  assert.match(visibleText(html), /Your pass is ready\. [^]*Scan it to sign in\. Tap to sign in\./);
  assert.match(html, /<title>Sign in<\/title>/);
});

test("a site's name and host are escaped", () => {
  const evil = `<img src=x onerror=alert(1)>"`;
  const html = renderLoginPage({ ...PAGE, site: { name: evil, host: evil } });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;/);
});

test("a long name shrinks to fit the ticket instead of overflowing it", () => {
  const short = renderLoginPage({ ...PAGE, site: { name: "Courier" } });
  assert.match(short, /--tqa-name-scale: 1"/);
  const long = renderLoginPage({ ...PAGE, site: { name: "The internal documentation portal" } });
  assert.match(long, /--tqa-name-scale: 0\.40"/);
});

// --- The look of the sign-in page --------------------------------------------------------------------

import { renderScanEndedPage, DEFAULT_BRANDING } from "../src/login-page.js";

const BASE = { token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", qrSvg: "<svg></svg>", pollPath: "/auth/poll" };

test("the headline, the status and the stamp each have words for every way the sign-in can go", () => {
  const html = renderLoginPage(BASE);
  for (const text of ["Approved.", "You&#39;re through.", "Pass expired.", "Get a new one.", "No entry.", "Not on the list.", "Awaiting scan", "Ready", "Admitted", "This sign-in code expired.", "Your Telegram account isn&#39;t allowed to sign in here."]) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /<span class="tqa-v tqa-v-wait tqa-v-expired tqa-v-denied">1 of 3<\/span><span class="tqa-v tqa-v-ok">3 of 3<\/span>/);
  assert.match(html, /<p class="tqa-stamp-note">Opening …<\/p>/, "no name to open: the placeholder is simply dropped");
  const named = renderLoginPage({ ...BASE, site: { name: "Docs" } });
  assert.match(named, /<p class="tqa-stamp-note">Opening Docs…<\/p>/);

  const french = renderLoginPage({ ...BASE, branding: { heading: "Votre pass est prêt.", stampText: "Admis", stepText: "{n} sur 3" } });
  assert.match(french, /Votre pass est prêt\./);
  assert.match(french, />Admis</);
  assert.match(french, />1 sur 3</);
});

test("the pass follows the sign-in state through the attribute the poll script already sets", () => {
  const html = renderLoginPage(BASE);
  assert.match(html, /<html lang="en" data-tqa-state="waiting"/, "waiting from the first byte, before any script has run");
  for (const state of ["waiting", "signed-in", "expired", "denied"]) assert.match(html, new RegExp(`\\[data-tqa-state="${state}"\\]`), state);
  // The status field is the element the poll script writes to, with its own short words for each ending.
  assert.match(html, /id="tqa-status" role="status"/);
  assert.match(html, /"success":"Signed in","expired":"Expired","denied":"Not allowed","retry":"Get a new code"/);
  assert.match(html, /html\[data-tqa-state="signed-in"\] \.tqa-stamp \{ display: grid; \}/);
});

test("the page has a tab icon in the site's letter and colour, as a data: URI so no /favicon.ico request is made", () => {
  const html = renderLoginPage({ ...BASE, site: { name: "Courier" }, branding: { accent: "#ff0000" } });
  const href = html.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)">/)?.[1];
  assert.ok(href, "an icon link");
  const svg = decodeURIComponent(href.split(",")[1]);
  assert.match(svg, /fill="#ff0000"[^>]*>C<\/text>/);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(decodeURIComponent(renderLoginPage(BASE).match(/<link rel="icon" href="(data:[^"]+)"/)[1]), /<path fill="#ee5a1c"/, "no name, no letter: the plane");
});

test("an app that supplies its own icon keeps it, whichever way it writes the link", () => {
  for (const headHtml of [`<link rel="icon" href="/mine.png">`, `<link rel='shortcut icon' href='/mine.ico'>`, `<link REL=icon href=/mine.svg>`]) {
    const html = renderLoginPage({ ...BASE, branding: { headHtml } });
    assert.equal((html.match(/<link rel="icon" href="data:/g) ?? []).length, 0, headHtml);
    assert.ok(html.includes(headHtml));
  }
  assert.equal((renderLoginPage({ ...BASE, branding: { headHtml: `<link rel="stylesheet" href="/x.css">` } }).match(/<link rel="icon"/g) ?? []).length, 1, "an unrelated link does not count");
});

test("the page is the accent colour, and the colour of its text follows from it", () => {
  const html = renderLoginPage(BASE);
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.match(html, /<meta name="theme-color" content="#ee5a1c">/);
  assert.match(html, /--tqa-accent: #ee5a1c;/);
  assert.match(html, /--tqa-on: #17130f;/, "dark text on the default orange");
  assert.doesNotMatch(html, /prefers-color-scheme/);

  const navy = renderLoginPage({ ...BASE, branding: { accent: "#0e1a2f" } });
  assert.match(navy, /--tqa-accent: #0e1a2f;/);
  assert.match(navy, /--tqa-on: #ffffff;/, "white text on a dark page");
  assert.match(renderLoginPage({ ...BASE, branding: { accent: "#fc0" } }), /--tqa-on: #17130f;/, "three-digit colours work too");
  assert.match(renderLoginPage({ ...BASE, branding: { accent: "rebeccapurple" } }), /--tqa-on: #17130f;/, "anything else falls back to dark");
});

test("the QR keeps its colours scannable: dark modules on paper, finder squares in the page colour", () => {
  const html = renderLoginPage(BASE);
  assert.match(html, /\.tqa-qr svg > path \{ fill: var\(--tqa-ink\); \}/);
  assert.match(html, /\.tqa-qr svg \.qr-eye \{ fill: color-mix\(in srgb, var\(--tqa-accent\) 88%, #000\); \}/);
  const svg = qrSvg(DEEP_LINK);
  assert.equal(svg.match(/class="qr-eye"/g).length, 3, "one per finder square");
});

test("the mark is the first letter of the site's name, the app's own logo, or Telegram's plane, in that order", () => {
  assert.match(renderLoginPage({ ...BASE, site: { name: "Internal docs" } }), /<span class="tqa-mark" aria-hidden="true">I<\/span>/);
  assert.match(renderLoginPage({ ...BASE, site: { name: "courier" } }), /aria-hidden="true">C<\/span>/);
  assert.match(renderLoginPage({ ...BASE, site: { name: "!!!" } }), /<span class="tqa-mark" aria-hidden="true"><svg/, "no usable letters: the plane");
  assert.match(renderLoginPage(BASE), /<span class="tqa-mark" aria-hidden="true"><svg/);
  const logo = renderLoginPage({ ...BASE, site: { name: "Acme" }, branding: { logoHtml: '<img src="/logo.png" alt="">' } });
  assert.match(logo, /<img src="\/logo.png" alt="">/);
  assert.doesNotMatch(logo, /class="tqa-mark"/);
  assert.match(logo, /<span class="tqa-brand-name">Acme<\/span>/, "the name stays beside a custom logo");
});

test("the page and the code-ended page make no request of their own: nothing external, and the only data: URIs are decoration", () => {
  for (const html of [renderLoginPage({ ...BASE, site: { name: "Docs", host: "docs.example.com" } }), renderScanEndedPage({})]) {
    const withoutDataUris = html.replace(/url\("data:[^"]*"\)/g, "").replace(/<link rel="icon" href="data:[^"]*">/, "");
    assert.doesNotMatch(withoutDataUris, /https?:\/\//, "no absolute URL anywhere");
    assert.doesNotMatch(html, /@import|@font-face|<img|<iframe|<link rel="stylesheet"/i, "without fontsPath there is nothing to fetch fonts from");
    assert.doesNotMatch(html, /<script src=/i);
  }
});

test("given a fontsPath the page uses the bundled fonts from that same origin, and still nothing external", () => {
  for (const html of [renderLoginPage({ ...BASE, fontsPath: "/auth/fonts" }), renderScanEndedPage({ fontsPath: "/auth/fonts" })]) {
    const urls = [...html.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]).filter((u) => !u.startsWith("data:"));
    assert.equal(urls.length, 3, "one file per face");
    for (const url of urls) assert.match(url, /^\/auth\/fonts\/(archivo-display|inter|google-sans-code)-[0-9a-f]{8}\.woff2$/);
    assert.equal(html.match(/<link rel="preload" href="\/auth\/fonts\/[^"]+" as="font" type="font\/woff2" crossorigin>/g).length, 3);
    for (const family of ["TQA Display", "TQA Sans", "TQA Mono"]) assert.match(html, new RegExp(`font-family: "${family}"`));
    assert.match(html, /font-display: swap/);
    assert.doesNotMatch(html.replace(/url\("data:[^"]*"\)/g, "").replace(/<link rel="icon" href="data:[^"]*">/, ""), /https?:\/\//);
  }
  // A path that could break out of the CSS or markup is not used at all.
  for (const bad of ['/x"); }<script>', "fonts", "/a/../b", "//evil.example"]) {
    const html = renderLoginPage({ ...BASE, fontsPath: bad });
    assert.doesNotMatch(html, /@font-face|rel="preload"/, bad);
  }
});
test("motion is switched off for people who ask for less of it, and keyboard focus is always visible", () => {
  const html = renderLoginPage(BASE);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /a:focus-visible, button:focus-visible \{ outline: 3px solid/);
  const reduced = html.match(/@media \(prefers-reduced-motion: reduce\) \{[^]*?\n  \}/)[0];
  assert.match(reduced, /animation: none/);
  assert.match(reduced, /transition: none/);
});

test("the code-ended page looks like the sign-in page it came from, in the app's words", () => {
  const html = renderScanEndedPage({ branding: { scanEndedHeading: "Code expiré", scanEndedText: "Retournez sur votre ordinateur." } });
  assert.match(html, /<h1 class="tqa-ended-title">Code expiré<\/h1>/);
  assert.match(html, /<p class="tqa-ended-text">Retournez sur votre ordinateur\.<\/p>/);
  assert.match(html, /class="tqa-ticket tqa-ticket-ended"/);
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(renderScanEndedPage({ branding: { accent: "#123456" } }), /--tqa-accent: #123456;/);
});

test("every default string the page uses can be overridden, and none is left out of DEFAULT_BRANDING", () => {
  const keys = ["heading", "scanHeading", "tapHeading", "approvedHeading", "approvedSubheading", "expiredHeading", "expiredSubheading", "deniedHeading", "deniedSubheading", "kickerText", "viaText", "destinationLabel", "phoneLabel", "phoneText", "codeLabel", "codeText", "statusLabel", "stepLabel", "nextLabel", "nextText", "nextExpiredText", "nextDeniedText", "readyText", "waitingText", "scanText", "scanOtherText", "qrHintText", "orScanText", "tabletTitleText", "mobileSubtitle", "showQrText", "showAppText", "footText", "mobileFootText", "scanFootText", "stampText"];
  for (const key of keys) assert.equal(typeof DEFAULT_BRANDING[key], "string", key);
  const html = renderLoginPage({ ...BASE, branding: Object.fromEntries(keys.map((key, i) => [key, `X${i}X`])) });
  keys.forEach((key, i) => assert.ok(html.includes(`X${i}X`), key));
});

test("branding.siteName wins over the name a hub supplies", () => {
  const html = renderLoginPage({ ...PAGE, site: { name: "Hub's name", host: "docs.example.com" }, branding: { siteName: "Mine" } });
  assert.match(html, /<span class="tqa-brand-name">Mine<\/span>/);
  assert.match(html, /<title>Sign in to Mine<\/title>/);
});

test("the address sits in a browser-style pill: a lock of its own, then the host, and it says so to a screen reader", () => {
  const html = renderLoginPage({ ...PAGE, site: { name: "Courier", host: "courier.jitdor.com" }, origin: "https://courier.jitdor.com" });
  assert.match(
    html,
    /<p class="tqa-site" title="Secure connection to courier\.jitdor\.com"><span class="tqa-lock" role="img" aria-label="Secure connection"><\/span><span class="tqa-host">courier\.jitdor\.com<\/span><\/p>/
  );
  assert.match(html, /\.tqa-site \{[^}]*background: var\(--tqa-ink\); color: #fff;/, "dark pill, white text");
  assert.match(html, /\.tqa-lock \{[^}]*border-right: 1px solid/, "the lock is its own segment");
});

test("the lock only claims a secure connection unless the page is known to be served over plain http", () => {
  const open = renderLoginPage({ ...PAGE, origin: "http://localhost:3000", site: { host: "localhost:3000" } });
  assert.match(open, /<p class="tqa-site tqa-site-open" title="Not a secure connection to localhost:3000">/);
  assert.match(open, /aria-label="Not secure"/);
  assert.match(open, /\.tqa-site-open \.tqa-lock::before \{[^}]*mask-image/, "an open padlock");
  assert.doesNotMatch(renderLoginPage({ ...PAGE, origin: "https://x.example" }), /tqa-site-open"/);
  assert.doesNotMatch(renderLoginPage({ ...PAGE, site: { host: "x.example" } }), /tqa-site-open"/, "no origin: not accused of being insecure");
});

test("the consent and error pages carry the same pill", async () => {
  const { renderConsentPage, renderErrorPage } = await import("../src/oidc/consent-page.js");
  const consent = renderConsentPage({ client: { client_name: "A", redirect_uris: ["https://a.example/cb"] }, scopes: ["openid"], session: { name: "N" }, requestId: "r", csrfToken: "c", actionPath: "/consent", origin: "https://auth.example.com" });
  assert.match(consent, /<span class="tqa-lock" role="img" aria-label="Secure connection"><\/span><span class="tqa-host">auth\.example\.com<\/span>/);
  assert.match(renderErrorPage("x", "y", { origin: "http://auth.example.com" }), /tqa-site tqa-site-open/);
});
