// Import-graph guarantees for the entry points. A deployment that does not use OIDC (or Durable
// Objects) should not load that code, and that only stays true if something checks it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** Every src file reachable from `entry` through relative static imports and re-exports. */
function reachable(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, spec] of source.matchAll(/(?:import|export)\b[^;'"]*?from\s*["'](\.[^"']+)["']/g)) {
      walk(resolve(dirname(file), spec));
    }
  };
  walk(resolve(ROOT, entry));
  return [...seen].map((file) => relative(SRC, file));
}

test("the main entry point does not load OIDC or Durable Object code", () => {
  const files = reachable("src/index.js");
  assert.deepEqual(files.filter((f) => f.startsWith("oidc/") || f === "do.js"), []);
});

test("the stores entry point does not load OIDC or Durable Object code", () => {
  const files = reachable("src/stores/index.js");
  assert.deepEqual(files.filter((f) => f.startsWith("oidc/") || f === "do.js"), []);
});

test("the do entry point is where Durable Object storage lives, and it is exported by name", async () => {
  const files = reachable("src/do.js");
  assert.ok(files.includes("stores/d1.js") && files.includes("oidc/d1-store.js"));

  const mod = await import("../src/do.js");
  assert.deepEqual(Object.keys(mod).filter((k) => /^(Do|define)/.test(k)).sort(), ["DoLoginStore", "DoOidcStore", "defineQrAuthStorage"]);

  const main = await import("../src/index.js");
  assert.equal(main.DoLoginStore, undefined, "no longer exported from the main entry point");
  assert.equal(main.defineQrAuthStorage, undefined);

  const oidc = await import("../src/oidc/index.js");
  assert.equal(oidc.DoOidcStore, mod.DoOidcStore, "/oidc re-exports the same class");
});

test("package.json exports a do entry point with types", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./do"], { types: "./types/do.d.ts", default: "./src/do.js" });
});

test("the hub is its own entry point: nothing else loads it, and it loads neither OIDC nor Durable Objects", () => {
  for (const entry of ["src/index.js", "src/stores/index.js", "src/bot.js", "src/oidc/index.js"]) {
    assert.deepEqual(reachable(entry).filter((f) => f.startsWith("hub/")), [], `${entry} must not pull in the hub`);
  }
  const files = reachable("src/hub/index.js");
  assert.deepEqual(files.filter((f) => f.startsWith("oidc/") || f === "do.js"), []);
  assert.ok(files.includes("hub/console.js") && files.includes("hub/d1-store.js"));
});

test("a site's entry point is small: it loads none of the hub's console, stores or API, nor OIDC or Durable Objects", () => {
  const files = reachable("src/hub/site.js");
  for (const heavy of ["hub/console.js", "hub/console-ui.js", "hub/d1-store.js", "hub/store.js", "hub/api.js", "hub/hub.js", "do.js"]) {
    assert.ok(!files.includes(heavy), `${heavy} must not be pulled into a site`);
  }
  assert.ok(!files.some((f) => f.startsWith("oidc/")));
  assert.ok(files.includes("hub/client.js") && files.includes("provider.js"));
});

test("package.json exports the site entry point", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./site"], { types: "./types/site.d.ts", default: "./src/hub/site.js" });
  assert.equal(pkg.exports["./migrations/hub-d1-upgrade-1.2.sql"], "./migrations/hub-d1-upgrade-1.2.sql");
  assert.equal(pkg.version, "1.2.0");
});

test("the site entry point can be imported by its package name, as a site would", async () => {
  const site = await import("telegram-qr-signin/site");
  assert.equal(typeof site.createSiteAuth, "function");
  assert.equal(typeof site.HubError, "function");
});

test("package.json exports the hub entry point and its migration", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./hub"], { types: "./types/hub.d.ts", default: "./src/hub/index.js" });
  assert.equal(pkg.exports["./migrations/hub-d1.sql"], "./migrations/hub-d1.sql");
  assert.equal(pkg.exports["./migrations/hub-d1-upgrade-1.1.sql"], "./migrations/hub-d1-upgrade-1.1.sql");
});

test("the hub entry point exports what its types and docs promise", async () => {
  const mod = await import("../src/hub/index.js");
  assert.deepEqual(Object.keys(mod).sort(), [
    "ADMIN_NAMESPACE", "D1HubStore", "HubError", "MemoryHubStore", "NAMESPACE_RE", "OriginInUseError", "createHub", "createSiteAuth",
    "hubGate", "parseRootAdminNames", "parseRootAdmins", "parseTelegramId", "parseTelegramIds", "superAdminGate",
  ]);
  const types = readFileSync(join(ROOT, "types", "hub.d.ts"), "utf8");
  for (const name of Object.keys(mod)) assert.match(types, new RegExp(`export declare (function|class|const) ${name}\\b`), `${name} is typed`);
});
