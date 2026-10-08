// The site side of a hub: createTelegramQrAuth with the hub's gate already wired in.
//
// A site registered in the hub's console needs almost nothing of its own: the shared login store,
// the registry, and a session secret. It does NOT need the bot token — the hub's webhook is what
// talks to Telegram — so a compromised site cannot impersonate the bot.
//
// It also does not need to say which site it is. Leave `namespace` out and the site works that out
// from the URL each request arrives at, by looking that origin up in the registry. The id then comes
// from the one thing a Worker cannot misreport — where it was actually reached — instead of from a
// string in its code that has to be kept in step with the console. Pass `namespace` to pin it
// instead, which skips that lookup.

import { createTelegramQrAuth, jsonResponse } from "../provider.js";
import { renderLoginPage as defaultRenderLoginPage } from "../login-page.js";
import { every } from "../gates.js";
import { hubGate } from "./gates.js";
import { assertSiteNamespace, originOfRequest } from "./validate.js";

// Stands in for a Telegram client the site never uses. If something does reach for it (a
// chatMember gate composed in via `authorize`, say) it fails loudly, naming the fix.
const NO_TELEGRAM = {
  async call() {
    throw new Error("createSiteAuth: no Telegram client — pass `botToken` or `telegram` to use gates that call Telegram");
  },
};

// The cookie's name cannot depend on the namespace when the namespace is not known until a request
// arrives. Cookies are per-origin, so one fixed name cannot collide between sites.
const DEFAULT_COOKIE_NAME = "site_session";

// Any valid id: used only to build the namespace-independent members of a resolving site.
const TEMPLATE_NAMESPACE = "site";

/**
 * @param {object} config  Everything createTelegramQrAuth takes, plus:
 * @param {object} config.registry   A HubStore (D1HubStore on Workers).
 * @param {string} [config.namespace]  The id this site was registered under. Leave it out and the
 *   site resolves it from the request's origin on every request (one extra registry query), which
 *   is what you want. Pass it to pin the site and skip that query; the request's origin must still
 *   be one of that namespace's registered URLs. Either way the URL is registered in the console,
 *   to exactly one site.
 * @param {object} config.session    `{ secret }` is required: unlike a standalone app there is no
 *   bot token to default to. Give each site its own, so one site's cookies are worthless on another.
 * @param {Function} [config.authorize]  Optional extra gate, ANDed with the hub's — e.g. also
 *   require `chatMember(...)`. Needs `botToken` or `telegram`.
 * @param {boolean|(() => boolean)} [config.recordRequests]  See hubGate.
 * @param {(err: unknown) => void} [config.onError]  Registry failures. Defaults to console.error.
 *
 * The site is served from the URL(s) registered for its namespace in the console. Visitors reaching
 * it at any other origin are refused, and so is a scan of a QR minted anywhere else.
 */
export function createSiteAuth(config) {
  return config?.namespace === undefined ? createResolvingSiteAuth(config) : createPinnedSiteAuth(config);
}

/** A site that was told its namespace. */
function createPinnedSiteAuth(config) {
  const { registry, namespace, authorize, recordRequests, botToken, telegram, onError, ...rest } = config ?? {};
  if (!registry) throw new Error("createSiteAuth: `registry` is required");
  assertSiteNamespace(namespace);
  if (!rest.session?.secret) {
    throw new Error("createSiteAuth: `session.secret` is required — a site has no bot token to fall back on");
  }

  // The hub binds a namespace to its site by the origin recorded when each QR is minted, so a site
  // cannot opt out of recording it.
  if (rest.captureClient === false) {
    throw new Error("createSiteAuth: `captureClient` cannot be turned off — the hub uses it to check which site a QR came from");
  }

  const hub = hubGate({ registry, namespace, recordRequests, onError });

  // The sign-in page says which site it is and where it is served from, so a person who ends up on
  // the wrong environment, or the wrong site, can see it before they scan. The name is read from the
  // registry each time (an admin may rename the site); if that fails the page still renders, with the
  // host alone. It is self-reported by the page, so it helps people orient, not defend: the bot's
  // message is the check that cannot be faked by a page.
  const render = rest.renderLoginPage ?? defaultRenderLoginPage;
  const renderLoginPage = async (params) => {
    let name;
    try {
      name = (await registry.getNamespace(namespace))?.name;
    } catch (err) {
      (onError ?? defaultOnError)(err);
    }
    let host;
    try {
      host = params.origin ? new URL(params.origin).host : undefined;
    } catch {
      host = undefined;
    }
    return render({ ...params, site: { name, host } });
  };

  return createTelegramQrAuth({
    ...rest,
    renderLoginPage,
    namespace,
    botToken,
    telegram: telegram ?? (botToken ? undefined : NO_TELEGRAM),
    authorize: authorize ? every(hub, authorize) : hub,
  });
}

/**
 * A site that finds its namespace from the request. It wraps one pinned auth per namespace it has
 * seen (building one is only closures) and sends each request to the right one.
 */
function createResolvingSiteAuth(config) {
  if (!config?.registry) throw new Error("createSiteAuth: `registry` is required");
  const { registry, onError = defaultOnError } = config;
  const shared = { ...config, session: { ...config.session, cookieName: config.session?.cookieName ?? DEFAULT_COOKIE_NAME } };

  // Validates the whole config once, and supplies everything that does not depend on the namespace.
  const template = createPinnedSiteAuth({ ...shared, namespace: TEMPLATE_NAMESPACE });
  const { paths } = template;

  const bound = new Map();
  function authFor(namespace) {
    let auth = bound.get(namespace);
    if (!auth) bound.set(namespace, (auth = createPinnedSiteAuth({ ...shared, namespace })));
    return auth;
  }

  /**
   * The namespace this request's origin is registered to, and the auth for it. Not found, found
   * twice (two sites claim the URL: refuse rather than guess), and "could not ask" are three
   * different answers, and the last is retryable rather than a refusal.
   */
  async function resolve(request) {
    const origin = request ? originOfRequest(request) : null;
    let matches = [];
    if (origin) {
      try {
        matches = await registry.namespacesForOrigin(origin);
      } catch (err) {
        onError(err);
        return { ok: false, reason: "hub_unavailable", transient: true };
      }
    }
    if (matches.length === 0) return { ok: false, reason: "origin_not_allowed" };
    if (matches.length > 1) return { ok: false, reason: "origin_ambiguous" };
    return { ok: true, namespace: matches[0], auth: authFor(matches[0]) };
  }

  /** The response for a request that could not be matched to a site. */
  function refusal(result) {
    const headers = { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (result.transient) {
      return new Response("Temporarily unable to verify this site. Please try again shortly.", { status: 503, headers: { ...headers, "Retry-After": "5" } });
    }
    return new Response(
      result.reason === "origin_ambiguous"
        ? "This address is registered to more than one site. An administrator needs to fix that in the hub console."
        : "This address is not registered as a site. An administrator can add it in the hub console.",
      { status: 403, headers }
    );
  }

  function mustResolve(result) {
    if (!result.ok) throw new Error(`createSiteAuth: this request's origin is not a registered site (${result.reason})`);
    return result.auth;
  }

  const ownsPath = (pathname) =>
    pathname === paths.poll || pathname === paths.login || pathname === paths.logout || pathname === paths.qr || pathname.startsWith(`${paths.scan}/`);

  return {
    // What does not depend on which site a request is for.
    basePath: template.basePath,
    paths,
    cookieName: template.cookieName,
    tokenTtlSeconds: template.tokenTtlSeconds,
    getSession: template.getSession,
    verifyAssertion: template.verifyAssertion,
    logoutResponse: template.logoutResponse,
    store: template.store,
    telegram: template.telegram,
    session: template.session,

    /** The namespace a request's origin is registered to, or null. For apps that key their own data per site. */
    async namespaceFor(request) {
      const result = await resolve(request);
      return result.ok ? result.namespace : null;
    },

    async handle(request) {
      const { pathname } = new URL(request.url);
      if (!ownsPath(pathname)) return null;
      if (pathname === paths.logout) return template.handle(request); // clearing a cookie needs no site
      const result = await resolve(request);
      if (!result.ok) {
        return pathname === paths.poll ? jsonResponse({ status: "denied", reason: result.reason }, result.transient ? 503 : 403) : refusal(result);
      }
      return result.auth.handle(request);
    },

    async guard(request, options) {
      const result = await resolve(request);
      if (!result.ok) return { ok: false, reason: result.reason, response: refusal(result) };
      return result.auth.guard(request, options);
    },

    async poll(request) {
      const result = await resolve(request);
      if (!result.ok) return jsonResponse({ status: "denied", reason: result.reason }, result.transient ? 503 : 403);
      return result.auth.poll(request);
    },

    async scan(request) {
      const result = await resolve(request);
      return result.ok ? result.auth.scan(request) : refusal(result);
    },

    // These need the request to know which site they are for.
    async beginLogin(options = {}) {
      return mustResolve(await resolve(options.request)).beginLogin(options);
    },
    async loginPage(options = {}) {
      return mustResolve(await resolve(options.request)).loginPage(options);
    },
    async loginResponse(options = {}) {
      const result = await resolve(options.request);
      return result.ok ? result.auth.loginResponse(options) : refusal(result);
    },

    /** The hub's check for a user, for the site the request in `ctx` is for. Without a request there is no site to check. */
    async authorize(user, ctx = {}) {
      const result = await resolve(ctx.request);
      return result.ok ? result.auth.authorize(user, ctx) : { ok: false, reason: result.reason, ...(result.transient ? { transient: true } : {}) };
    },
  };
}

function defaultOnError(err) {
  console.error("telegram-qr-signin/hub: registry error", err);
}
