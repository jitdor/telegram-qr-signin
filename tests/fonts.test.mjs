import test from "node:test";
import assert from "node:assert/strict";

import { fontResponse, fontFaceCss } from "../src/fonts/index.js";
import { FONT_DATA } from "../src/fonts/data.js";
import { createTelegramQrAuth, MemoryLoginStore } from "../src/index.js";

const makeAuth = (extra = {}) =>
  createTelegramQrAuth({ botToken: "123:abc", botUsername: "b", store: new MemoryLoginStore(), telegram: { call: async () => ({}) }, ...extra });
const get = (path, init) => new Request(`https://app.example${path}`, init);
const fontUrls = (html) => [...html.matchAll(/url\("(\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);

test("the bundled fonts are real woff2 files", () => {
  assert.deepEqual(Object.keys(FONT_DATA).sort(), ["archivo-display", "inter", "jetbrains-mono"]);
  for (const [name, base64] of Object.entries(FONT_DATA)) {
    const bytes = Buffer.from(base64, "base64");
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", name);
    assert.ok(bytes.length > 5_000 && bytes.length < 60_000, `${name} is ${bytes.length} bytes`);
  }
});

test("auth.handle serves each font the page links to, cached for a year", async () => {
  const auth = makeAuth();
  const urls = fontUrls(await auth.loginPage());
  assert.equal(urls.length, 3);
  for (const url of urls) {
    assert.ok(url.startsWith(`${auth.paths.fonts}/`));
    const response = await auth.handle(get(url));
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get("content-type"), "font/woff2");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2");
    assert.equal(Number(response.headers.get("content-length")), bytes.length);
  }
});

test("fonts follow basePath, and the code-ended page links to them too", async () => {
  const auth = makeAuth({ basePath: "/login-api" });
  assert.equal(auth.paths.fonts, "/login-api/fonts");
  const urls = fontUrls(await auth.loginPage());
  assert.ok(urls.every((u) => u.startsWith("/login-api/fonts/")));
  assert.equal((await auth.handle(get(urls[0]))).status, 200);
  assert.equal(await auth.handle(get(`/auth/fonts/${urls[0].split("/").pop()}`)), null, "not under this base path: not ours");

  const ended = await auth.handle(get(`${auth.paths.scan}/${"0".repeat(32)}`));
  assert.equal(ended.status, 410);
  assert.deepEqual(fontUrls(await ended.text()), urls);
});

test("an unknown font name is a 404, other methods are refused, and HEAD has no body", async () => {
  const auth = makeAuth();
  const [url] = fontUrls(await auth.loginPage());
  assert.equal((await auth.handle(get("/auth/fonts/nope.woff2"))).status, 404);
  assert.equal((await auth.handle(get("/auth/fonts/%2e%2e%2fpoll"))).status, 404);
  assert.equal((await auth.handle(get(url, { method: "POST" }))).status, 405);
  const head = await auth.handle(get(url, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("a font's file name carries a fingerprint of its bytes, so a new font means a new URL", () => {
  const first = fontFaceCss("/auth/fonts");
  assert.equal(first, fontFaceCss("/auth/fonts"), "stable between calls");
  assert.match(first, /archivo-display-[0-9a-f]{8}\.woff2/);
  assert.equal(fontResponse(get("/auth/fonts/x.woff2"), "/auth/fonts").status, 404);
});
