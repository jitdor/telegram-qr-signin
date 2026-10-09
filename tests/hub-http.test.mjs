// The hub and a site over a real network connection, with the site using nothing but the global
// `fetch`: the point of the API is that a site can be anywhere, not only on Cloudflare.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createSiteAuth } from "../src/hub/site.js";
import { generateSiteKey, hashSiteKey } from "../src/hub/validate.js";
import { makeRequest, cookieFrom } from "./helpers.mjs";
import { ALICE, BOB, makeHub, startUpdate, webhookRequest } from "./hub-helpers.mjs";

const SITE_ORIGIN = "http://localhost:3999"; // where the site's own page is served; the hub is on another port

/** Serves `hub.fetch` on a real socket, the way a Node deployment of the hub would. */
async function serve(hub) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const response = await hub.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls, url: `http://127.0.0.1:${server.address().port}` };
}

test("a site on another machine signs a person in, using only fetch and its key", async (t) => {
  const ctx = makeHub();
  await ctx.registry.createNamespace({ namespace: "docs", name: "Docs", origins: [SITE_ORIGIN] });
  await ctx.registry.addGrant({ namespace: "docs", id: ALICE.id });
  const key = generateSiteKey("docs");
  await ctx.registry.setSiteKey("docs", await hashSiteKey(key));
  const { server, calls, url } = await serve(ctx.hub);
  t.after(() => server.close());

  const site = createSiteAuth({ hub: { url: `${url}/hub-api`, key }, botUsername: "hub_bot", session: { secret: "docs-secret-docs-secret-docs-0000" } });

  const login = await site.handle(makeRequest(`${SITE_ORIGIN}/auth/login`));
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.match(html, /Sign in to Docs/);
  const token = html.match(/docs_([0-9a-f]{32})/)[1];

  await ctx.hub.webhook(webhookRequest(startUpdate(`/start docs_${token}`, ALICE))); // Telegram calls the hub
  const polled = await site.poll(makeRequest(`${SITE_ORIGIN}/auth/poll?token=${token}`));
  assert.deepEqual(await polled.json(), { status: "confirmed" });
  const cookie = `${site.cookieName}=${cookieFrom(polled, site.cookieName)}`;

  const gate = await site.guard(makeRequest(`${SITE_ORIGIN}/`, { cookie }));
  assert.equal(gate.ok, true);
  assert.equal(gate.session.id, ALICE.id);

  await ctx.registry.removeGrant("docs", ALICE.id);
  assert.equal((await site.guard(makeRequest(`${SITE_ORIGIN}/`, { cookie }))).ok, false, "revocation reaches the site on its next request");

  assert.ok(calls.length >= 6);
  assert.ok(calls.every((c) => c.url.startsWith("/hub-api/v1/") && c.auth === `Bearer ${key}`), "every call was to the API, with the key");
});

test("a site whose hub has gone away asks visitors to try again instead of failing", async (t) => {
  const ctx = makeHub();
  const { server, url } = await serve(ctx.hub);
  await new Promise((resolve) => server.close(resolve)); // nothing is listening now
  const key = generateSiteKey("docs");
  const errors = [];
  const site = createSiteAuth({ hub: { url: `${url}/hub-api`, key, timeoutMs: 500 }, botUsername: "hub_bot", session: { secret: "docs-secret-docs-secret-docs-0000" }, onError: (e) => errors.push(e) });

  const login = await site.handle(makeRequest(`${SITE_ORIGIN}/auth/login`));
  assert.equal(login.status, 503);
  assert.equal(errors[0].code, "hub_unreachable");
  void t;
});

// What the Workers runtime does with fetch's `redirect` option: it accepts "follow" and "manual" and
// throws on anything else, "error" included. A hub client that sends "error" never gets a call out.
function workersLikeFetch(respond) {
  const seen = [];
  const fn = async (url, init = {}) => {
    seen.push(init.redirect);
    if (init.redirect !== undefined && !["follow", "manual"].includes(init.redirect)) {
      throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual" (got "${init.redirect}").`);
    }
    return respond(url, init);
  };
  fn.seen = seen;
  return fn;
}

test("the hub client only sends a redirect mode the Workers runtime accepts", async () => {
  const ctx = makeHub();
  const key = generateSiteKey("docs");
  await ctx.registry.createNamespace({ namespace: "docs", name: "Docs", origins: [SITE_ORIGIN] });
  await ctx.registry.setSiteKey("docs", await hashSiteKey(key));
  const fetch = workersLikeFetch((url, init) => ctx.hub.fetch(new Request(url, init)));
  const site = createSiteAuth({ hub: { url: "https://hub.example/hub-api", key, fetch }, botUsername: "hub_bot", session: { secret: "docs-secret-docs-secret-docs-0000" }, onError: (e) => { throw e; } });
  const login = await site.handle(makeRequest(`${SITE_ORIGIN}/auth/login`));
  assert.equal(login.status, 200, "the call got through to the hub");
  assert.deepEqual([...new Set(fetch.seen)], ["manual"]);
});

test("a hub address that answers with a redirect is treated as unreachable, not followed", async () => {
  const key = generateSiteKey("docs");
  const errors = [];
  const fetch = workersLikeFetch(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
  const site = createSiteAuth({ hub: { url: "https://hub.example/hub-api", key, fetch }, botUsername: "hub_bot", session: { secret: "docs-secret-docs-secret-docs-0000" }, onError: (e) => errors.push(e) });
  const login = await site.handle(makeRequest(`${SITE_ORIGIN}/auth/login`));
  assert.equal(login.status, 503);
  assert.equal(errors[0].code, "hub_unreachable");
  assert.equal(fetch.seen.length, 1, "and it was not retried at the redirect's address");
});

test("the key is never sent anywhere a redirect could take it", async () => {
  let followed = false;
  const target = http.createServer((req, res) => {
    followed = true;
    res.end("{}");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/` });
    res.end();
  });
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  try {
    const site = createSiteAuth({
      hub: { url: `http://127.0.0.1:${redirector.address().port}/hub-api`, key: generateSiteKey("docs") },
      botUsername: "hub_bot", session: { secret: "docs-secret-docs-secret-docs-0000" }, onError: () => {},
    });
    assert.equal((await site.handle(makeRequest(`${SITE_ORIGIN}/auth/login`))).status, 503);
    assert.equal(followed, false);
  } finally {
    target.close();
    redirector.close();
  }
});
