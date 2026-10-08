// The site side of a hub: createTelegramQrAuth with the hub's gate already wired in.
//
// A site registered in the hub's console needs almost nothing of its own: a namespace, the shared
// login store, the registry, and a session secret. It does NOT need the bot token — the hub's
// webhook is what talks to Telegram — so a compromised site cannot impersonate the bot.

import { createTelegramQrAuth } from "../provider.js";
import { every } from "../gates.js";
import { hubGate } from "./gates.js";
import { assertSiteNamespace } from "./validate.js";

// Stands in for a Telegram client the site never uses. If something does reach for it (a
// chatMember gate composed in via `authorize`, say) it fails loudly, naming the fix.
const NO_TELEGRAM = {
  async call() {
    throw new Error("createSiteAuth: no Telegram client — pass `botToken` or `telegram` to use gates that call Telegram");
  },
};

/**
 * @param {object} config  Everything createTelegramQrAuth takes, plus:
 * @param {object} config.registry   A HubStore (D1HubStore on Workers).
 * @param {string} config.namespace  The id this site was registered under in the console.
 * @param {object} config.session    `{ secret }` is required: unlike a standalone app there is no
 *   bot token to default to. Give each site its own, so one site's cookies are worthless on another.
 * @param {Function} [config.authorize]  Optional extra gate, ANDed with the hub's — e.g. also
 *   require `chatMember(...)`. Needs `botToken` or `telegram`.
 * @param {boolean|(() => boolean)} [config.recordRequests]  See hubGate.
 *
 * The site is served from the URL(s) registered for its namespace in the console. Visitors reaching
 * it at any other origin are refused, and so is a scan of a QR minted anywhere else.
 */
export function createSiteAuth(config) {
  const { registry, namespace, authorize, recordRequests, botToken, telegram, ...rest } = config ?? {};
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

  const hub = hubGate({ registry, namespace, recordRequests });
  return createTelegramQrAuth({
    ...rest,
    namespace,
    botToken,
    telegram: telegram ?? (botToken ? undefined : NO_TELEGRAM),
    authorize: authorize ? every(hub, authorize) : hub,
  });
}
