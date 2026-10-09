// A site's connection to its hub: HTTPS and JSON with a key, nothing else. This is all a site holds
// of the hub, and it works from anywhere that can make a `fetch` — Cloudflare, Node, Deno, Bun, a VPS.

import { parseSiteKey } from "./validate.js";

/** The hub did not give an answer, or refused to. `code` says which; `status` is the HTTP status (0 if it never answered). */
export class HubError extends Error {
  constructor(code, status, message) {
    super(message ?? `the hub answered "${code}"${status ? ` (${status})` : ""}`);
    this.name = "HubError";
    this.code = code;
    this.status = status;
  }

  /** Worth trying again: the hub was unreachable or unwell, or this site's key is wrong (an operator's problem, not a visitor's). */
  get transient() {
    return this.code === "hub_unreachable" || this.code === "hub_unavailable" || this.code === "unauthorized";
  }
}

/**
 * @param {object} options
 * @param {string} options.url   The hub's API address, as the console shows it: "https://auth.example.com/hub-api".
 *   https, except for localhost.
 * @param {string} options.key   This site's key, from the console. Keep it in a secret.
 * @param {typeof fetch} [options.fetch]  Replaces global fetch. A Cloudflare service binding's `fetch` works.
 * @param {number} [options.timeoutMs=5000]  How long to wait for the hub before treating it as unreachable.
 */
export function createHubClient({ url, key, fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const parsed = parseSiteKey(key);
  if (!parsed) throw new Error("createSiteAuth: `hub.key` is missing or is not a site key (it looks like tqk_<site>_<64 hex>; make one in the hub console)");
  const base = apiBase(url);
  if (typeof fetchImpl !== "function") throw new Error("createSiteAuth: no `fetch` available; pass `hub.fetch`");

  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${base}/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would carry the key somewhere the operator did not choose.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HubError("hub_unreachable", 0, "could not reach the hub");
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Not JSON (a proxy's error page, say): handled by status below.
    }
    if (response.ok) return data ?? {};
    if (response.status >= 500) throw new HubError("hub_unavailable", response.status);
    throw new HubError(typeof data?.error === "string" ? data.error : "refused", response.status);
  }

  return {
    /** The site this key is for, read off the key. */
    namespace: parsed.namespace,
    site: () => call("GET", "/site"),
    startLogin: (login) => call("POST", "/logins", login),
    getLogin: async (token) => (await call("GET", `/logins/${token}`)).record ?? null,
    consumeLogin: async (token) => (await call("POST", `/logins/${token}/consume`)).record ?? null,
    removeLogin: (token) => call("DELETE", `/logins/${token}`),
    check: (query) => call("POST", "/check", query),
    block: (id, label = "") => call("POST", "/blocks", { id, label }),
    unblock: (id) => call("DELETE", `/blocks/${id}`),
  };
}

/** A login store whose records live at the hub. A site can start, read, take and drop its own sign-ins; only the hub's bot can confirm one. */
export class HubLoginStore {
  constructor(client) {
    this.client = client;
  }

  async create({ token, expiresAt, client }) {
    await this.client.startLogin({ token, expiresAt, client });
  }

  get(token) {
    return this.client.getLogin(token);
  }

  consume(token) {
    return this.client.consumeLogin(token);
  }

  async remove(token) {
    await this.client.removeLogin(token);
  }

  async confirm() {
    throw new Error("a site cannot confirm a sign-in: only the hub's bot does, when the person scans");
  }
}

function apiBase(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('createSiteAuth: `hub.url` must be the hub\'s API address, such as "https://auth.example.com/hub-api"');
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error("createSiteAuth: `hub.url` must be https (http is allowed only for localhost): the key travels in every request");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("createSiteAuth: `hub.url` must be a plain address, with no credentials, query or fragment");
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}
