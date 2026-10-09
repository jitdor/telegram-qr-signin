// telegram-qr-signin/hub — one bot, many sites, and an admin console for who gets into which.
//
// The hub side:  createHub({ ..., store, registry: new D1HubStore(env.HUB_DB) })
// The site side: createSiteAuth({ hub: { url, key }, botUsername, session: { secret } })
//
// A site holds the hub's address and its own key and nothing else of the hub's: the hub is the only
// thing that touches the data, and answers the site's questions over HTTPS.
//
// See docs/hub.md.

export { createHub } from "./hub.js";
export { createSiteAuth } from "./site.js";
export { HubError } from "./client.js";
export { hubGate, superAdminGate, parseRootAdmins, parseRootAdminNames } from "./gates.js";
export { D1HubStore } from "./d1-store.js";
export { MemoryHubStore } from "./store.js";
export { ADMIN_NAMESPACE, NAMESPACE_RE, OriginInUseError, parseTelegramId, parseTelegramIds } from "./validate.js";
