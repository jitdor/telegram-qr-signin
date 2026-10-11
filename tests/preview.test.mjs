import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramQrAuth, MemoryLoginStore, renderLoginPage } from "../src/index.js";
import { PREVIEW_PNG } from "../src/preview/data.js";

const makeAuth = (extra = {}) =>
  createTelegramQrAuth({ botToken: "123:abc", botUsername: "b", store: new MemoryLoginStore(), telegram: { call: async () => ({}) }, ...extra });
const get = (path, init) => new Request(`https://app.example${path}`, init);
const meta = (html, key) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html)?.[1];

test("the bundled card is a 1200x630 PNG", () => {
  const bytes = Buffer.from(PREVIEW_PNG, "base64");
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
  assert.ok(bytes.length < 200_000, `${bytes.length} bytes`);
});

test("the sign-in page carries the tags link previews are built from", async () => {
  const auth = makeAuth();
  const html = await auth.loginPage({ request: get("/auth/login") });
  assert.equal(meta(html, "og:title"), "Telegram QR Sign-in Provider");
  assert.equal(meta(html, "twitter:title"), "Telegram QR Sign-in Provider");
  assert.match(html, /<title>Sign in to App<\/title>/, "the tab keeps its own title");
  assert.equal(meta(html, "og:type"), "website");
  assert.match(meta(html, "og:description"), /^App authentication: sign in by scanning a QR code with Telegram\./);
  assert.equal(meta(html, "description"), meta(html, "og:description"));
  assert.equal(meta(html, "og:site_name"), "App");
  assert.equal(meta(html, "og:image"), `https://app.example${auth.paths.preview}`);
  assert.equal(meta(html, "og:image:width"), "1200");
  assert.equal(meta(html, "og:image:height"), "630");
  assert.equal(meta(html, "twitter:card"), "summary_large_image");
  assert.equal(meta(html, "twitter:image"), meta(html, "og:image"));
});

test("auth.handle serves the card, cached for a year", async () => {
  const auth = makeAuth();
  assert.match(auth.paths.preview, /^\/auth\/preview-[0-9a-f]{8}\.png$/);
  const response = await auth.handle(get(auth.paths.preview));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from(PREVIEW_PNG, "base64"));
  assert.equal(Number(response.headers.get("content-length")), bytes.length);

  const head = await auth.handle(get(auth.paths.preview, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await auth.handle(get(auth.paths.preview, { method: "POST" }))).status, 405);
});

test("the card follows basePath", async () => {
  const auth = makeAuth({ basePath: "/login-api" });
  assert.ok(auth.paths.preview.startsWith("/login-api/preview-"));
  assert.equal((await auth.handle(get(auth.paths.preview))).status, 200);
  assert.equal(await auth.handle(get(auth.paths.preview.replace("/login-api", "/auth"))), null);
});

test("branding sets the description and replaces the card, and everything is escaped", async () => {
  const auth = makeAuth({ branding: { siteName: "Acme", previewTitle: "{name} ID", description: 'Acme "ID" <b>&', previewImage: "/static/card.png" } });
  const html = await auth.loginPage({ request: get("/auth/login") });
  assert.equal(meta(html, "og:description"), "Acme &quot;ID&quot; &lt;b&gt;&amp;");
  assert.equal(meta(html, "og:image"), "https://app.example/static/card.png");
  assert.equal(meta(html, "og:image:width"), undefined, "the size of an image of your own is not known");
  assert.equal(meta(html, "og:site_name"), "Acme");
  assert.equal(meta(html, "og:title"), "Acme ID");

  const absolute = renderLoginPage({ ...PAGE, origin: "https://app.example", branding: { previewImage: "https://cdn.example/c.png" } });
  assert.equal(meta(absolute, "og:image"), "https://cdn.example/c.png");
});

test("the app's own preview tags win, so the library's card never overrides the app's", () => {
  const count = (html, key) => (html.match(new RegExp(`<meta[^>]*(?:property|name)=["']?${key}["' >]`, "gi")) ?? []).length;
  const base = { ...PAGE, origin: "https://app.example", previewPath: "/auth/preview-x.png" };

  // An image of its own replaces the card and the facts about the card; its other tags are untouched.
  const withImage = renderLoginPage({ ...base, branding: { headHtml: `<meta property="og:image" content="https://app.example/mine.png">\n<meta name='twitter:card' content='summary_large_image'>` } });
  assert.equal(count(withImage, "og:image"), 1);
  assert.equal(count(withImage, "twitter:image"), 0);
  assert.equal(count(withImage, "twitter:card"), 1);
  for (const key of ["og:image:width", "og:image:height", "og:image:type", "og:image:alt"]) assert.equal(count(withImage, key), 0, key);
  assert.ok(!withImage.includes("/auth/preview-x.png"));
  assert.ok(meta(withImage, "og:title"), "tags the app did not write are still the library's");

  // A twitter:image alone counts as an image of its own too.
  const twitterOnly = renderLoginPage({ ...base, branding: { headHtml: `<meta name="twitter:image" content="https://app.example/t.png">` } });
  assert.equal(count(twitterOnly, "twitter:image"), 1);
  assert.equal(count(twitterOnly, "og:image"), 0);

  // Any single tag the app writes replaces the library's, however it is written.
  const titled = renderLoginPage({ ...base, branding: { headHtml: `<META PROPERTY=og:title content="Mine"><meta name="description" content="Mine too">` } });
  assert.equal(count(titled, "og:title"), 1);
  assert.equal(count(titled, "description"), 1);
  assert.ok(meta(titled, "og:image"), "the card stays when the app wrote no image");

  // Nothing from the app: unchanged.
  assert.equal(count(renderLoginPage(base), "og:image"), 1);
  assert.equal(meta(renderLoginPage(base), "twitter:card"), "summary_large_image");
});

test("without an address the preview is text only, and a hostile image is dropped", () => {
  const html = renderLoginPage({ ...PAGE, previewPath: "/auth/preview-x.png" });
  assert.equal(meta(html, "og:image"), undefined);
  assert.equal(meta(html, "twitter:card"), "summary");
  assert.ok(meta(html, "og:description"));
  const evil = renderLoginPage({ ...PAGE, origin: "https://app.example", branding: { previewImage: "javascript:alert(1)" } });
  assert.equal(meta(evil, "og:image"), undefined);
});

const PAGE = { token: "t", deepLink: "https://t.me/b?start=x", qrSvg: "<svg></svg>", pollPath: "/auth/poll" };
