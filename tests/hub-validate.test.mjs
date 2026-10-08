import test from "node:test";
import assert from "node:assert/strict";

import { NAMESPACE_RE, assertSiteNamespace, normalizeOrigin, originOfRequest, assertOrigins, suggestNamespace, parseTelegramIds } from "../src/hub/validate.js";

test("normalizeOrigin keeps scheme, host and port, and nothing else", () => {
  const cases = {
    "https://Docs.Example.com:443/login?x=1#frag": "https://docs.example.com",
    "https://docs.example.com:8443/": "https://docs.example.com:8443",
    " https://a.example ": "https://a.example",
    "http://localhost:8787/app": "http://localhost:8787",
    "http://127.0.0.1:3000": "http://127.0.0.1:3000",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(normalizeOrigin(input), expected, input);
});

test("normalizeOrigin refuses anything that is not a plain https (or localhost http) site", () => {
  for (const bad of [
    "", "docs.example.com", "//docs.example.com", "http://docs.example.com", "http://localhost.evil.example", "http://127.0.0.1.evil.example",
    "ftp://docs.example.com", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "https://user:pw@docs.example.com", "https://:pw@docs.example.com",
    "https://" + "a".repeat(200) + ".example", null, undefined, 42, {}, [],
  ]) {
    assert.equal(normalizeOrigin(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("originOfRequest reads the origin a request arrived at, in the same form as a registered one", () => {
  assert.equal(originOfRequest(new Request("https://Docs.Example.com:443/a/b?c=d")), "https://docs.example.com");
  assert.equal(originOfRequest({ url: "not a url" }), null);
  assert.equal(originOfRequest({}), null);
});

test("assertOrigins normalises, de-duplicates, and rejects an empty, invalid or oversized list", () => {
  assert.deepEqual(assertOrigins(["https://A.example/x", "https://a.example", "https://b.example"]), ["https://a.example", "https://b.example"]);
  for (const bad of [undefined, null, [], "https://a.example", ["https://a.example", "nope"], [null], Array.from({ length: 11 }, (_, n) => `https://s${n}.example`)]) {
    assert.throws(() => assertOrigins(bad), /origins/, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.equal(assertOrigins(Array.from({ length: 10 }, (_, n) => `https://s${n}.example`)).length, 10);
});

test("suggestNamespace prefers the display name, then the URL's first label, and always yields a usable id", () => {
  assert.equal(suggestNamespace({ name: "Internal docs", url: "https://docs.example.com" }), "internal-docs");
  assert.equal(suggestNamespace({ name: "", url: "https://docs.example.com" }), "docs");
  assert.equal(suggestNamespace({ url: "https://www.example.com" }), "example", "www is not a name");
  assert.equal(suggestNamespace({ url: "https://acme.workers.dev" }), "acme");
  assert.equal(suggestNamespace({ url: "http://localhost:8787" }), "localhost");
  assert.equal(suggestNamespace({ name: "Café Münch!" }), "cafe-munch", "accents fold to plain letters");
  assert.equal(suggestNamespace({ name: "日本語", url: "https://forum.example.com" }), "forum", "a name with no usable letters falls back to the URL");
  assert.equal(suggestNamespace({ name: "日本語", url: "nope" }), "site");
  assert.equal(suggestNamespace({}), "site");
  assert.equal(suggestNamespace(), "site");
});

test("suggestNamespace never exceeds 24 characters, ends in a letter or digit, and always passes the namespace rules", () => {
  for (const name of ["A very long display name that goes on and on", "x".repeat(100), "a-".repeat(30), "  ---  ", "!!!", "Hub Admin", "hub-admin"]) {
    for (const taken of [[], ["x".repeat(24), "a-very-long-display-name"], ["site", "site-2"]]) {
      const id = suggestNamespace({ name }, taken);
      assert.match(id, NAMESPACE_RE, `${name} ${taken}`);
      assert.doesNotThrow(() => assertSiteNamespace(id), id);
      assert.doesNotMatch(id, /^-|-$|--/, id);
      assert.ok(!taken.includes(id), id);
    }
  }
});

test("suggestNamespace steps past ids that exist, and past the one the console reserves", () => {
  assert.equal(suggestNamespace({ name: "Docs" }, ["docs"]), "docs-2");
  assert.equal(suggestNamespace({ name: "Docs" }, ["docs", "docs-2", "docs-3"]), "docs-4");
  assert.equal(suggestNamespace({ name: "Hub Admin" }), "hub-admin-2", "the console's own id is never offered");
  assert.equal(suggestNamespace({ name: "x".repeat(30) }, ["x".repeat(24)]), `${"x".repeat(22)}-2`, "the suffix still fits in 24");
  assert.equal(suggestNamespace({ name: "Docs" }, new Set(["docs"])), "docs-2", "any iterable works");
});

test("parseTelegramIds reports bad entries instead of dropping them", () => {
  assert.deepEqual(parseTelegramIds("1, 2\n3;4 4"), { ids: [1, 2, 3, 4], invalid: [] });
  assert.deepEqual(parseTelegramIds("1, abc, -2, 0, 1.5"), { ids: [1], invalid: ["abc", "-2", "0", "1.5"] });
  assert.deepEqual(parseTelegramIds(""), { ids: [], invalid: [] });
  assert.deepEqual(parseTelegramIds(null), { ids: [], invalid: [] });
});
