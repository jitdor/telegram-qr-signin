// The two gates a hub is built from. Both are ordinary authorization gates (see ../gates.js), so
// they compose with `every` / `some` and with the built-in chatMember, allowlist and friends.

import { parseIdList } from "../gates.js";
import { cleanLabel, originOfRequest } from "./validate.js";

/**
 * Who may sign in to the site registered as `namespace`. In "granted" (invite only) and "approval"
 * mode that is whoever holds a grant for it in the registry; in "anyone" mode it is any Telegram
 * account. A block refuses someone in every mode, and beats a grant. Read live — one query per check, no
 * cache — so revoking or blocking in the console locks someone out of the site on their next
 * request, which is the same guarantee chatMember gives.
 *
 * Refusal reasons, so a custom login page or log can tell them apart:
 *   "unknown_namespace"  the site is not registered (deleted, or never added)
 *   "namespace_disabled" the site is switched off in the console
 *   "origin_not_allowed" the request came to a URL this namespace is not registered for
 *   "blocked"            this person is on the site's block list
 *   "not_granted"        an invite-only site, and this person has no grant
 *   "pending_approval"   an approval site, and this person has no grant yet. `requested` says
 *                        whether this refusal was written down as a request for an admin to answer
 *   "hub_unavailable"    the registry could not be read (transient: retry, do not sign anyone out)
 *
 * @param {object} options
 * @param {object} options.registry   A HubStore.
 * @param {string} options.namespace
 * @param {boolean|(() => boolean)} [options.recordRequests=true]  Remember the scan as a request, so
 *   an admin can approve the person from the console without being told their numeric id. Only
 *   acts at `stage: "confirm"` — a scan, not a stale cookie — and only for a site in "approval"
 *   mode: an invite-only site keeps no record of strangers, and an open site has nobody to approve.
 *   A function is asked each time.
 * @param {(request: {user: object, isNew: boolean, attempts: number}) => void} [options.onRequest]
 *   Called after a request has been written down, so the caller can tell the admins.
 * @param {(err: unknown) => void} [options.onError]
 */
export function hubGate({ registry, namespace, recordRequests = true, onRequest, onError = defaultOnError }) {
  if (!registry) throw new Error("hubGate: `registry` is required");
  if (!namespace) throw new Error("hubGate: `namespace` is required");

  return async (user, ctx) => {
    let state;
    try {
      state = await registry.access(namespace, user.id);
    } catch (err) {
      onError(err);
      // The registry being down says nothing about this person. A transient refusal is answered
      // with "try again" and never signs anyone out.
      return { ok: false, reason: "hub_unavailable", transient: true };
    }

    if (!state.exists) return { ok: false, reason: "unknown_namespace" };
    if (!state.enabled) return { ok: false, reason: "namespace_disabled" };

    // A namespace is bound to the URL(s) it was registered for. A request that reaches the site at
    // any other origin — a staging copy that borrowed production's namespace, say — gets nothing
    // from this registry: no grants, no open-site access. Checked wherever a request is in hand
    // (the browser's poll and every guarded request). The bot's scan has no request; the hub checks
    // where that QR was minted instead (see hub.js). Every site has at least one origin.
    // The origin comes from the request in hand, or, when a site asks the hub over its API, from the
    // origin that site reports (`ctx.origin`).
    if (ctx?.request || ctx?.origin !== undefined) {
      const origin = ctx.request ? originOfRequest(ctx.request) : ctx.origin;
      if (!origin || !state.origins.includes(origin)) return { ok: false, reason: "origin_not_allowed" };
    }
    // Before the grant check, and in every mode: a ban holds even for someone with a grant, and on
    // a site that is open to everyone it is the only way anyone is refused. A blocked person is
    // also not recorded as an access request — the queue is for people an admin might approve.
    if (state.blocked) return { ok: false, reason: "blocked" };
    if (state.mode === "anyone" || state.granted) return true;

    // Invite only: a stranger is turned away and nothing is kept about them.
    if (state.mode !== "approval") return { ok: false, reason: "not_granted" };

    let requested = false;
    const record = typeof recordRequests === "function" ? recordRequests() : recordRequests;
    if (ctx?.stage === "confirm" && record) {
      try {
        const { isNew, attempts } = (await registry.recordRequest({ namespace, user })) ?? {};
        requested = true;
        try {
          await onRequest?.({ user, isNew: isNew !== false, attempts: attempts ?? 1 });
        } catch (err) {
          onError(err);
        }
      } catch (err) {
        onError(err); // Best effort: the refusal stands whether or not it was written down.
      }
    }
    return { ok: false, reason: "pending_approval", requested };
  };
}

/**
 * Who may use the admin console: the bootstrap admins from configuration, plus anyone added as a
 * super admin in the console. The bootstrap list is checked first and never touches the registry,
 * so a broken or empty database cannot lock the operator out.
 *
 * @param {object} options
 * @param {object} options.registry
 * @param {Iterable<number>} options.rootAdmins
 */
export function superAdminGate({ registry, rootAdmins, onError = defaultOnError }) {
  const roots = new Set(rootAdmins);
  return async (user) => {
    const id = Number(user.id);
    if (roots.has(id)) return true;
    try {
      return (await registry.isAdmin(id)) ? true : { ok: false, reason: "not_admin" };
    } catch (err) {
      onError(err);
      return { ok: false, reason: "hub_unavailable", transient: true };
    }
  };
}

/**
 * The bootstrap admins from "111, 222" | [111, 222] | 111, as a list of ids. An entry may carry a
 * name, "111:Ada" or "111=Ada", which parseRootAdminNames reads; the id is all this cares about.
 */
export function parseRootAdmins(value) {
  return rootAdminEntries(value).map((entry) => entry.id);
}

/** The names given to bootstrap admins, as a Map of id to name ("111:Ada, 222" gives 111 -> "Ada"). */
export function parseRootAdminNames(value) {
  return new Map(rootAdminEntries(value).filter((entry) => entry.name).map((entry) => [entry.id, entry.name]));
}

function rootAdminEntries(value) {
  const raw = Array.isArray(value) ? value : typeof value === "number" ? [value] : String(value ?? "").split(",");
  return raw
    .map((entry) => String(entry).trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const at = entry.search(/[:=]/);
      return { id: Number(at < 0 ? entry : entry.slice(0, at)), name: at < 0 ? "" : cleanLabel(entry.slice(at + 1)) };
    })
    .filter((entry) => Number.isInteger(entry.id) && entry.id > 0);
}

function defaultOnError(err) {
  console.error("telegram-qr-signin/hub: registry error", err);
}
