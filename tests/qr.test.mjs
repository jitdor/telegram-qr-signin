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

test("touch devices get an Open Telegram button and their own subtitle; both are customisable", () => {
  const html = renderLoginPage({
    token: "0".repeat(32),
    deepLink: "https://t.me/b?start=a_1",
    qrSvg: "<svg></svg>",
    pollPath: "/auth/poll",
    branding: { mobileLinkText: "Ouvrir Telegram", mobileSubtitle: "Touchez le bouton", qrHintText: "Cliquez sur le code" },
  });
  assert.match(html, /<a class="tqa-open tqa-touch-only"[^>]*href="tg:\/\/resolve\?domain=b&amp;start=a_1"[^>]*><svg[^]*?<span>Ouvrir Telegram<\/span><\/a>/);
  assert.match(html, /tqa-touch-only" id="tqa-how">Touchez le bouton/);
  assert.match(html, /tqa-pointer-only" id="tqa-hint">Cliquez sur le code/);
  assert.match(html, /@media \(hover: none\) and \(pointer: coarse\)/);
});

test("the default copy does not claim Start must be pressed: only first-time chats show the button", () => {
  const html = renderLoginPage({ token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", qrSvg: "", pollPath: "/p" });
  // Mobile and desktop copy both say "if you see / if Telegram shows" a Start button.
  assert.match(html, /tqa-touch-only" id="tqa-how">Telegram opens\. If you see a Start button, tap it, then come back to this tab\./);
  assert.match(html, /tqa-pointer-only">[^<]*If Telegram shows a Start button, tap it\./);
  // The step list no longer tells everyone to "Press Start" (returning users are signed in automatically).
  assert.match(html, /<li>Approve in the chat<\/li>/);
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
  const html = renderLoginPage({ ...PAGE, site: { name: "Internal docs", host: "docs.example.com" } });
  assert.match(html, /<h1>Sign in to Internal docs<\/h1>/);
  assert.match(html, /<title>Sign in to Internal docs<\/title>/);
  assert.match(html, /<p class="tqa-site">docs\.example\.com<\/p>/);
  assert.match(visibleText(html), /Sign in to Internal docs docs\.example\.com/);
});

test("a site's host is shown even without a name, and a name without a host changes only the heading", () => {
  const hostOnly = renderLoginPage({ ...PAGE, site: { host: "docs.example.com:8443" } });
  assert.match(hostOnly, /<h1>Sign in with Telegram<\/h1>/);
  assert.match(hostOnly, /class="tqa-site">docs\.example\.com:8443</);

  const nameOnly = renderLoginPage({ ...PAGE, site: { name: "Docs" } });
  assert.match(nameOnly, /<h1>Sign in to Docs<\/h1>/);
  assert.doesNotMatch(nameOnly, /tqa-site">/);
});

test("a page that sets its own heading or title keeps them", () => {
  const html = renderLoginPage({ ...PAGE, branding: { heading: "📈 Dashboard", title: "Acme" }, site: { name: "Internal docs", host: "docs.example.com" } });
  assert.match(html, /<h1>📈 Dashboard<\/h1>/);
  assert.match(html, /<title>Acme<\/title>/);
  assert.match(html, /class="tqa-site">docs\.example\.com</, "but the host is still shown");
});

test("without a site the page is exactly as it was", () => {
  const html = renderLoginPage(PAGE);
  assert.doesNotMatch(html, /<p class="tqa-site">/);
  assert.match(html, /<h1>Sign in with Telegram<\/h1>/);
  assert.match(html, /<title>Sign in<\/title>/);
});

test("a site's name and host are escaped", () => {
  const evil = `<img src=x onerror=alert(1)>"`;
  const html = renderLoginPage({ ...PAGE, site: { name: evil, host: evil } });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;/);
});

// --- The look of the sign-in page --------------------------------------------------------------------

import { renderScanEndedPage, DEFAULT_BRANDING } from "../src/login-page.js";

const BASE = { token: "0".repeat(32), deepLink: "https://t.me/b?start=a_1", qrSvg: "<svg></svg>", pollPath: "/auth/poll" };

test("the page shows how it works as a labelled list of three steps, in the app's own words if it has them", () => {
  const html = renderLoginPage(BASE);
  assert.match(html, /<ol class="tqa-steps" aria-label="How it works">\s*<li>Open Telegram<\/li>\s*<li>Approve in the chat<\/li>\s*<li>You&#39;re in<\/li>\s*<\/ol>/);

  const french = renderLoginPage({ ...BASE, branding: { stepsLabel: "Comment ça marche", stepOneText: "Ouvrez Telegram", stepTwoText: "Appuyez sur Démarrer", stepThreeText: "C'est fait" } });
  assert.match(french, /aria-label="Comment ça marche"/);
  assert.match(french, /<li>Ouvrez Telegram<\/li>\s*<li>Appuyez sur Démarrer<\/li>\s*<li>C&#39;est fait<\/li>/);
});

test("the steps follow the sign-in state through the attribute the poll script already sets", () => {
  const html = renderLoginPage(BASE);
  for (const state of ["waiting", "signed-in", "expired", "denied"]) assert.match(html, new RegExp(`\\[data-tqa-state="${state}"\\]`), state);
  assert.match(html, /\.tqa-steps li::before\s*\{\s*content: "✓"|content: "✓"/);
});

test("the page has a tab icon in its own brand colours, as a data: URI so no /favicon.ico request is made", () => {
  const html = renderLoginPage({ ...BASE, branding: { gradientFrom: "#ff0000", gradientTo: "#00ff00" } });
  const href = html.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)">/)?.[1];
  assert.ok(href, "an icon link");
  const svg = decodeURIComponent(href.split(",")[1]);
  assert.match(svg, /stop-color="#ff0000"/);
  assert.match(svg, /stop-color="#00ff00"/);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test("an app that supplies its own icon keeps it, whichever way it writes the link", () => {
  for (const headHtml of [`<link rel="icon" href="/mine.png">`, `<link rel='shortcut icon' href='/mine.ico'>`, `<link REL=icon href=/mine.svg>`]) {
    const html = renderLoginPage({ ...BASE, branding: { headHtml } });
    assert.equal((html.match(/<link rel="icon" href="data:/g) ?? []).length, 0, headHtml);
    assert.ok(html.includes(headHtml));
  }
  assert.equal((renderLoginPage({ ...BASE, branding: { headHtml: `<link rel="stylesheet" href="/x.css">` } }).match(/<link rel="icon"/g) ?? []).length, 1, "an unrelated link does not count");
});

test("by default the page follows the visitor's light or dark setting; an app with its own background keeps a light card on it", () => {
  const themed = renderLoginPage(BASE);
  assert.match(themed, /<meta name="color-scheme" content="light dark">/);
  assert.match(themed, /@media \(prefers-color-scheme: dark\)/);

  const custom = renderLoginPage({ ...BASE, branding: { background: "#fff7ed" } });
  assert.match(custom, /<meta name="color-scheme" content="light">/);
  assert.doesNotMatch(custom, /@media \(prefers-color-scheme: dark\)/);
  assert.match(custom, /--tqa-bg: #fff7ed;/);
});

test("text sits on a darkened brand gradient so it stays readable, whatever colours the app picks", () => {
  const html = renderLoginPage({ ...BASE, branding: { gradientFrom: "#ffff00", gradientTo: "#00ffff" } });
  assert.match(html, /--tqa-grad-ink: linear-gradient\(135deg, color-mix\(in srgb, var\(--tqa-a\) 72%, #000\), color-mix\(in srgb, var\(--tqa-b\) 82%, #000\)\)/);
  assert.match(html, /\.tqa-open, \.tqa-retry \{[^}]*background: var\(--tqa-grad-ink\)/);
  assert.match(html, /\.tqa-mark \{[^}]*background: var\(--tqa-grad-ink\)/);
});

test("the card is marked with the site's initials, the app's own logo, or Telegram's plane, in that order", () => {
  assert.match(renderLoginPage({ ...BASE, site: { name: "Internal docs" } }), /<span class="tqa-mark" aria-hidden="true">ID<\/span>/);
  assert.match(renderLoginPage({ ...BASE, site: { name: "Acme" } }), /aria-hidden="true">A<\/span>/);
  assert.match(renderLoginPage({ ...BASE, site: { name: "!!!" } }), /<span class="tqa-mark" aria-hidden="true"><svg/, "no usable letters: the plane");
  assert.match(renderLoginPage(BASE), /<span class="tqa-mark" aria-hidden="true"><svg/);
  const logo = renderLoginPage({ ...BASE, site: { name: "Acme" }, branding: { logoHtml: '<img src="/logo.png" alt="">' } });
  assert.match(logo, /<img src="\/logo.png" alt="">/);
  assert.doesNotMatch(logo, /class="tqa-mark"/);
});

test("the page and the code-ended page make no request of their own: nothing external, and the only data: URIs are decoration", () => {
  for (const html of [renderLoginPage({ ...BASE, site: { name: "Docs", host: "docs.example.com" } }), renderScanEndedPage({})]) {
    const withoutDataUris = html.replace(/url\("data:[^"]*"\)/g, "").replace(/<link rel="icon" href="data:[^"]*">/, "");
    assert.doesNotMatch(withoutDataUris, /https?:\/\//, "no absolute URL anywhere");
    assert.doesNotMatch(html, /@import|@font-face|<img|<iframe|<link rel="stylesheet"/i);
    assert.doesNotMatch(html, /<script src=/i);
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
  assert.match(html, /<h1>Code expiré<\/h1>/);
  assert.match(html, /<p>Retournez sur votre ordinateur\.<\/p>/);
  assert.match(html, /class="tqa-ended"/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(renderScanEndedPage({ branding: { background: "#123456" } }), /<meta name="color-scheme" content="light">/);
});

test("every default string the new page uses can be overridden, and none is left out of DEFAULT_BRANDING", () => {
  for (const key of ["stepsLabel", "stepOneText", "stepTwoText", "stepThreeText"]) assert.equal(typeof DEFAULT_BRANDING[key], "string", key);
  const html = renderLoginPage({ ...BASE, branding: { subtitle: "S1", mobileSubtitle: "S2", orScanText: "S3", qrHintText: "S4", waitingText: "S5" } });
  for (const text of ["S1", "S2", "S3", "S4", "S5"]) assert.ok(html.includes(`>${text}<`), text);
});
