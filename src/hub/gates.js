// The two gates a hub is built from. Both are ordinary authorization gates (see ../gates.js), so
// they compose with `every` / `some` and with the built-in chatMember, allowlist and friends.

import { parseIdList } from "../gates.js";

/**
 * Who may sign in to the site registered as `namespace`: whoever holds a grant for it in the
 * registry. Read live — one query per check, no cache — so revoking in the console locks someone
 * out of the site on their next request, which is the same guarantee chatMember gives.
 *
 * Refusal reasons, so a custom login page or log can tell them apart:
 *   "unknown_namespace"  the site is not registered (deleted, or never added)
 *   "namespace_disabled" the site is switched off in the console
 *   "not_granted"        the site is on, and this person has no grant
 *   "hub_unavailable"    the registry could not be read (transient: retry, do not sign anyone out)
 *
 * @param {object} options
 * @param {object} options.registry   A HubStore.
 * @param {string} options.namespace
 * @param {boolean|(() => boolean)} [options.recordRequests=true]  Remember refused scans, so an
 *   admin can approve the person from the console without being told their numeric id. Only acts at
 *   `stage: "confirm"` — a refused scan, not a stale cookie. A function is asked each time.
 * @param {(err: unknown) => void} [options.onError]
 */
export function hubGate({ registry, namespace, recordRequests = true, onError = defaultOnError }) {
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
    if (state.granted) return true;

    const record = typeof recordRequests === "function" ? recordRequests() : recordRequests;
    if (ctx?.stage === "confirm" && record) {
      try {
        await registry.recordRequest({ namespace, user });
      } catch (err) {
        onError(err); // Best effort: the refusal stands whether or not it was written down.
      }
    }
    return { ok: false, reason: "not_granted" };
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

/** The bootstrap admins from "111, 222" | [111, 222] | 111, as a list of ids. */
export function parseRootAdmins(value) {
  return parseIdList(typeof value === "number" ? [value] : value).filter((id) => id > 0);
}

function defaultOnError(err) {
  console.error("telegram-qr-signin/hub: registry error", err);
}
