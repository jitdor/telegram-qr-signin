// The hub's HTTP API: how a site asks the hub things, instead of touching the hub's data.
//
// A site holds exactly one thing from the hub, its KEY, and everything else it needs it asks for:
//
//   POST   /v1/logins                 start a sign-in (the site made the token; the hub keeps it)
//   GET    /v1/logins/<token>         where is it: pending, or confirmed by whom
//   POST   /v1/logins/<token>/consume take a confirmed sign-in, once
//   DELETE /v1/logins/<token>         forget one
//   POST   /v1/check                  may this person be signed in to this site, right now
//   GET    /v1/site                   this site's name and URLs
//   POST   /v1/blocks, DELETE /v1/blocks/<id>   the site's own moderation, for open sites
//
// Whatever the call, the hub works out WHICH site is asking from the key, never from the body, so a
// site can only ever see and change its own sign-ins and its own block list. There is no call that
// reads the access list, another site, or the admins; the hub answers "yes" or "no".
//
// It is plain HTTPS with JSON, so a site can be anywhere: another cloud, a VPS, a laptop.

import { timingSafeEqualHex, tokenPattern } from "../crypto.js";
import { hubGate } from "./gates.js";
import { cleanLabel, hashSiteKey, normalizeOrigin, parseSiteKey, parseTelegramId } from "./validate.js";

const TOKEN_RE = tokenPattern(16); // sites use the default token size, as the webhook assumes
const MAX_BODY_BYTES = 4096;

/** A sign-in is good for ten minutes by default; no site may ask the hub to hold one longer than this. */
export const MAX_LOGIN_TTL_SECONDS = 900;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

/**
 * @param {object} options
 * @param {object} options.registry  A HubStore.
 * @param {object} options.store     The hub's login store. Only the hub reads or writes it.
 * @param {string} options.apiPath   Where the API is mounted, e.g. "/hub-api". Routes live under `/v1`.
 * @param {(err: unknown) => void} [options.onError]
 * @param {() => number} [options.now]  Epoch seconds. Tests only.
 */
export function createHubApi({ registry, store, apiPath, onError = defaultOnError, now = () => Math.floor(Date.now() / 1000) }) {
  const unavailable = () => json({ error: "hub_unavailable" }, 503, { "Retry-After": "5" });

  /** The site this request's key belongs to, or a Response refusing it. */
  async function authenticate(request) {
    const refuse = () => json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="hub"' });
    const header = request.headers.get("Authorization") ?? "";
    const key = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const parsed = key ? parseSiteKey(key) : null;
    if (!parsed) return refuse();
    // Hashed before anything is looked up, so a key for a site that has none takes as long to refuse
    // as a wrong key for one that does.
    const presented = await hashSiteKey(key);
    let stored;
    let site;
    try {
      stored = await registry.getSiteKey(parsed.namespace);
      site = stored ? await registry.getNamespace(parsed.namespace) : null;
    } catch (err) {
      onError(err);
      return unavailable();
    }
    if (!stored || !site || !timingSafeEqualHex(presented, stored.hash)) return refuse();
    return { namespace: parsed.namespace, site };
  }

  async function readBody(request) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return { error: json({ error: "too_large" }, 413) };
    try {
      const body = text ? JSON.parse(text) : {};
      return body && typeof body === "object" && !Array.isArray(body) ? { body } : { error: json({ error: "bad_request" }, 400) };
    } catch {
      return { error: json({ error: "bad_request" }, 400) };
    }
  }

  /** The store's atomic `consume`, or read-then-delete for a bring-your-own store that predates it. */
  async function consume(token, namespace) {
    if (typeof store.consume === "function") return store.consume(token, namespace);
    const record = await store.get(token, namespace);
    if (!record || record.status !== "confirmed") return null;
    await store.remove(token, namespace);
    return record;
  }

  async function startLogin({ namespace, site }, request) {
    const { body, error } = await readBody(request);
    if (error) return error;
    if (!site.enabled) return json({ error: "namespace_disabled" }, 403);
    if (typeof body.token !== "string" || !TOKEN_RE.test(body.token)) return json({ error: "bad_token" }, 400);
    if (!Number.isInteger(body.expiresAt)) return json({ error: "bad_request" }, 400);

    // Where the QR is being shown must be one of the site's registered URLs. It is the site that says
    // so, so this catches a mistake (staging with production's key), not a hostile site holding it.
    const origin = normalizeOrigin(body.client?.origin);
    if (!origin || !site.origins.includes(origin)) return json({ error: "origin_not_allowed" }, 403);

    // The hub, not the site, decides how long a sign-in lives.
    const expiresAt = Math.min(body.expiresAt, now() + MAX_LOGIN_TTL_SECONDS);
    if (expiresAt <= now()) return json({ error: "bad_request" }, 400);

    const text = (value) => (typeof value === "string" ? value.slice(0, 300) : null);
    const client = { ip: text(body.client.ip), userAgent: text(body.client.userAgent), origin, at: text(body.client.at) };
    await store.create({ token: body.token, namespace, expiresAt, client });
    return json({ ok: true, expiresAt }, 201);
  }

  async function check({ namespace }, request) {
    const { body, error } = await readBody(request);
    if (error) return error;
    const id = Number(body.user?.id);
    // "confirm" is the bot's alone: it is what records a request, and a site must not be able to.
    if (!Number.isSafeInteger(id) || id <= 0 || (body.stage !== "poll" && body.stage !== "session")) return json({ error: "bad_request" }, 400);

    const gate = hubGate({ registry, namespace, recordRequests: false, onError });
    const result = await gate({ id, username: typeof body.user.username === "string" ? body.user.username : undefined }, { stage: body.stage, origin: normalizeOrigin(body.origin) ?? "" });
    if (result === true) return json({ ok: true });
    if (result.transient) return unavailable();
    return json({ ok: false, reason: result.reason });
  }

  async function block({ namespace }, request, idText) {
    let id;
    let label = "";
    if (request.method === "DELETE") {
      id = parseTelegramId(idText);
    } else {
      const { body, error } = await readBody(request);
      if (error) return error;
      id = parseTelegramId(String(body.id ?? ""));
      label = cleanLabel(body.label);
    }
    if (id === null) return json({ error: "bad_request" }, 400);

    if (request.method === "DELETE") {
      const removed = await registry.removeBlock(namespace, id);
      if (removed) await audit("block.remove", namespace, `${id} (by the site)`);
      return json({ ok: true, removed });
    }
    const added = await registry.addBlock({ namespace, id, label, addedBy: null });
    await registry.removeRequest(namespace, id); // someone banned has no business in the approval queue
    if (added) await audit("block.add", namespace, `${id} (by the site)`);
    return json({ ok: true, added });
  }

  async function audit(action, target, detail) {
    try {
      await registry.appendAudit({ actor: null, action, target, detail });
    } catch (err) {
      onError(err); // the change is made; a log failure must not undo it
    }
  }

  async function route(auth, request, url) {
    const [version, resource, token, action] = url.pathname.slice(apiPath.length).split("/").filter(Boolean);
    const method = request.method;
    const wrongMethod = (...allowed) => json({ error: "method_not_allowed" }, 405, { Allow: allowed.join(", ") });
    if (version !== "v1") return json({ error: "not_found" }, 404);

    if (resource === "site" && token === undefined) {
      if (method !== "GET") return wrongMethod("GET");
      const { site } = auth;
      return json({ namespace: auth.namespace, name: site.name, enabled: site.enabled, origins: site.origins });
    }
    if (resource === "logins" && token === undefined) {
      return method === "POST" ? startLogin(auth, request) : wrongMethod("POST");
    }
    if (resource === "logins" && token !== undefined) {
      if (!TOKEN_RE.test(token)) return json({ error: "bad_token" }, 400);
      if (action === undefined) {
        if (method === "GET") return json({ record: (await store.get(token, auth.namespace)) ?? null });
        if (method === "DELETE") {
          await store.remove(token, auth.namespace);
          return json({ ok: true });
        }
        return wrongMethod("GET", "DELETE");
      }
      if (action === "consume") return method === "POST" ? json({ record: (await consume(token, auth.namespace)) ?? null }) : wrongMethod("POST");
    }
    if (resource === "check" && token === undefined) return method === "POST" ? check(auth, request) : wrongMethod("POST");
    if (resource === "blocks" && action === undefined) {
      if (token === undefined && method === "POST") return block(auth, request);
      if (token !== undefined && method === "DELETE") return block(auth, request, token);
      return wrongMethod(token === undefined ? "POST" : "DELETE");
    }
    return json({ error: "not_found" }, 404);
  }

  /** The API's response, or null for a path that is not the API's. */
  async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== apiPath && !url.pathname.startsWith(`${apiPath}/`)) return null;
    const auth = await authenticate(request);
    if (auth instanceof Response) return auth;
    try {
      return await route(auth, request, url);
    } catch (err) {
      onError(err);
      return unavailable();
    }
  }

  return { handle };
}

function defaultOnError(err) {
  console.error("telegram-qr-signin/hub: api error", err);
}
