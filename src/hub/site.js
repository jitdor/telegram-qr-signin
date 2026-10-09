// The site side of a hub: createTelegramQrAuth, with the hub in place of every piece of shared state.
//
// A site holds one thing from the hub, its KEY. It has no database binding, no share of the login
// store, no copy of the access list, and no bot token. Starting a sign-in, finding out who scanned,
// and "may this person come in" are all questions it puts to the hub over HTTPS, and the hub answers
// yes or no. The hub is the single authority: if it is down, nobody signs in to any site, and nobody
// is signed out (see `transient` below).
//
// Because it is only HTTPS and JSON, a site can run anywhere — it need not be on Cloudflare.

import { createTelegramQrAuth, jsonResponse } from "../provider.js";
import { renderLoginPage as defaultRenderLoginPage } from "../login-page.js";
import { every } from "../gates.js";
import { createHubClient, HubError, HubLoginStore } from "./client.js";

export { HubError };
import { originOfRequest } from "./validate.js";

// Stands in for a Telegram client the site never has. If something does reach for it (a
// chatMember gate composed in via `authorize`, say) it fails loudly, naming the fix.
const NO_TELEGRAM = {
  async call() {
    throw new Error("createSiteAuth: no Telegram client — pass `botToken` or `telegram` to use gates that call Telegram");
  },
};

// How long the sign-in page remembers the site's display name before asking the hub again.
const SITE_INFO_TTL_MS = 30_000;
// Most results the check cache holds; it is only a few seconds deep.
const MAX_CACHED_CHECKS = 1000;

/**
 * @param {object} config  Everything createTelegramQrAuth takes except `store`, `namespace` and the
 *   Telegram options, plus:
 * @param {object} config.hub
 * @param {string} config.hub.url   The hub's API address, as the console shows it: "https://auth.example.com/hub-api".
 * @param {string} config.hub.key   This site's key, made in the console. Keep it in a secret.
 * @param {typeof fetch} [config.hub.fetch]  Replaces global fetch (a service binding's, a test double).
 * @param {number} [config.hub.timeoutMs=5000]
 * @param {number} [config.hub.checkCacheSeconds=0]  How long a "yes" from the hub is reused for the
 *   same person. 0 asks on every request, so revoking someone in the console takes effect on their
 *   very next request; raise it to trade that for fewer calls to the hub.
 * @param {object} config.session    `{ secret }` is required, and different for every site, so one
 *   site's cookies are worthless on another.
 * @param {Function} [config.authorize]  Optional extra gate, ANDed with the hub's — e.g. also require
 *   `chatMember(...)`. Needs `botToken` or `telegram`.
 * @param {(err: unknown) => void} [config.onError]  Hub failures. Defaults to console.error.
 *
 * The site is served from the URL(s) registered for it in the console. A QR minted at any other
 * address is refused by the hub.
 */
export function createSiteAuth(config) {
  const { hub: hubConfig, authorize, botToken, telegram, onError = defaultOnError, renderLoginPage: customRender, ...rest } = config ?? {};

  for (const gone of ["registry", "store", "namespace", "recordRequests"]) {
    if (config?.[gone] !== undefined) {
      throw new Error(
        `createSiteAuth: \`${gone}\` is no longer an option. A site does not touch the hub's data any more: pass \`hub: { url, key }\` instead (the key says which site this is). See docs/hub.md.`
      );
    }
  }
  if (!hubConfig) throw new Error("createSiteAuth: `hub` is required, as { url, key } — both come from the hub's console");
  if (!rest.session?.secret) {
    throw new Error("createSiteAuth: `session.secret` is required — a site has no bot token to fall back on");
  }
  // The hub binds a site to its URLs by the origin recorded when each QR is minted, so a site
  // cannot opt out of recording it.
  if (rest.captureClient === false) {
    throw new Error("createSiteAuth: `captureClient` cannot be turned off — the hub uses it to check which site a QR came from");
  }

  const { checkCacheSeconds = 0, ...clientOptions } = hubConfig;
  const client = createHubClient(clientOptions);

  // --- "May this person be signed in to this site, right now?" ---------------------------------

  const cache = new Map(); // `${id}|${stage}|${origin}` -> expiry (ms); only "yes" is ever kept
  const hubGate = async (user, ctx = {}) => {
    // The bot's confirmation happens at the hub. A site is only ever asked at poll time, or per request.
    if (ctx.stage !== "poll" && ctx.stage !== "session") return { ok: false, reason: "not_supported" };
    const origin = ctx.request ? originOfRequest(ctx.request) ?? "" : "";
    const cacheKey = `${user.id}|${ctx.stage}|${origin}`;
    if (checkCacheSeconds > 0 && (cache.get(cacheKey) ?? 0) > Date.now()) return true;

    let answer;
    try {
      answer = await client.check({ user: { id: user.id, username: user.username }, stage: ctx.stage, origin });
    } catch (err) {
      if (!(err instanceof HubError)) throw err;
      onError(err);
      // The hub being unreachable, or this site's key being wrong, says nothing about this person:
      // answer "try again", which never signs anyone out.
      return { ok: false, reason: err.transient ? "hub_unavailable" : err.code, transient: err.transient };
    }
    if (answer.ok) {
      if (checkCacheSeconds > 0) {
        if (cache.size >= MAX_CACHED_CHECKS) cache.clear();
        cache.set(cacheKey, Date.now() + checkCacheSeconds * 1000);
      }
      return true;
    }
    return { ok: false, reason: answer.reason ?? "refused" };
  };

  // --- The sign-in page says which site it is --------------------------------------------------

  // The name is read from the hub (an admin may rename the site) and remembered for a moment. If the
  // hub cannot be asked the page still renders, with the host alone. It is self-reported by the page,
  // so it helps people orient, not defend: the bot's message is the check a page cannot fake.
  const render = customRender ?? defaultRenderLoginPage;
  let info = { name: undefined, until: 0 };
  async function siteName() {
    if (info.until > Date.now()) return info.name;
    try {
      info = { name: (await client.site()).name, until: Date.now() + SITE_INFO_TTL_MS };
    } catch (err) {
      onError(err);
      return info.name;
    }
    return info.name;
  }
  const renderLoginPage = async (params) => {
    let host;
    try {
      host = params.origin ? new URL(params.origin).host : undefined;
    } catch {
      host = undefined;
    }
    return render({ ...params, site: { name: await siteName(), host } });
  };

  const auth = createTelegramQrAuth({
    ...rest,
    renderLoginPage,
    namespace: client.namespace,
    store: new HubLoginStore(client),
    botToken,
    telegram: telegram ?? (botToken ? undefined : NO_TELEGRAM),
    authorize: authorize ? every(hubGate, authorize) : hubGate,
  });

  // --- When the hub cannot answer ----------------------------------------------------------------

  /** The page for a visitor when the hub could not do what the site asked, or null if `err` is not the hub's. */
  function refusalFor(err) {
    if (!(err instanceof HubError)) return null;
    const headers = { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (err.code === "origin_not_allowed") {
      return new Response("This address is not registered for this site. An administrator can add it in the hub console.", { status: 403, headers });
    }
    if (err.code === "namespace_disabled") {
      return new Response("Sign-in for this site is switched off.", { status: 403, headers });
    }
    onError(err);
    // An operator's problem (the hub is down, the key is wrong), not something to tell a visitor
    // about; they are asked to try again.
    return new Response("Sign-in is temporarily unavailable. Please try again shortly.", { status: 503, headers: { ...headers, "Retry-After": "5" } });
  }

  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      const response = refusalFor(err);
      if (!response) throw err;
      return response;
    }
  }

  return {
    ...auth,

    handle: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === auth.paths.poll) return auth.poll(request); // answers in JSON, below
      return guarded(() => auth.handle(request));
    },

    // The page polls this. It keeps polling through an answer it does not recognise, so "unavailable" waits and retries.
    poll: async (request) => {
      try {
        return await auth.poll(request);
      } catch (err) {
        if (!(err instanceof HubError)) throw err;
        if (err.code === "origin_not_allowed" || err.code === "namespace_disabled") return jsonResponse({ status: "denied", reason: err.code }, 403);
        onError(err);
        return jsonResponse({ status: "unavailable", reason: "hub_unavailable" }, 503, new Headers({ "Retry-After": "5" }));
      }
    },

    guard: async (request, options) => {
      try {
        return await auth.guard(request, options);
      } catch (err) {
        const response = refusalFor(err);
        if (!response) throw err;
        return { ok: false, reason: err.code === "origin_not_allowed" || err.code === "namespace_disabled" ? err.code : "hub_unavailable", response };
      }
    },

    scan: (request) => guarded(() => auth.scan(request)),
    loginResponse: (options) => guarded(() => auth.loginResponse(options)),

    /** The site's own moderation, for a site open to anyone: refuse this person from now on. Only this site's list. */
    block: (id, label) => client.block(id, label),
    /** Undo `block`. */
    unblock: (id) => client.unblock(id),
  };
}

function defaultOnError(err) {
  console.error("telegram-qr-signin/hub: hub error", err);
}
