// telegram-qr-signin/hub — one bot, many sites, and an admin console for who gets into which.
//
// The hub side:  createHub({ ..., registry: new D1HubStore(env.HUB_DB) })
// The site side: createSiteAuth({ namespace, registry, store, session: { secret }, ... })
//
// See docs/hub.md.

export { createHub } from "./hub.js";
export { createSiteAuth } from "./site.js";
export { hubGate, superAdminGate, parseRootAdmins } from "./gates.js";
export { D1HubStore } from "./d1-store.js";
export { MemoryHubStore } from "./store.js";
export { ADMIN_NAMESPACE, NAMESPACE_RE, OriginInUseError, parseTelegramId, parseTelegramIds } from "./validate.js";
