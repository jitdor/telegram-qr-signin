// In-process hub registry. Complete and correct, and the reference for what a HubStore does —
// D1HubStore must behave identically, which tests/hub-store.test.mjs enforces by running one suite
// against both. Only usable when the hub and the sites share a process (a Node server, tests);
// across Workers, bind the same D1 database in each and use D1HubStore.
//
// The HubStore contract, for anyone writing their own:
//
//   Sites     listNamespaces() · getNamespace(ns) · createNamespace({ namespace, name, origins, access?, createdBy })
//             · updateNamespace(ns, { name?, enabled?, access? }) · deleteNamespace(ns)
//   Origins   addOrigin(ns, url) · removeOrigin(ns, origin) · namespacesForOrigin(origin)
//             (a site's `origins` come back on every site record: the URLs it may be served from.
//             An origin belongs to ONE site: giving it to a second throws OriginInUseError, and
//             namespacesForOrigin is how a site finds its own namespace from the URL it is served at)
//   Access    access(ns, userId) -> { exists, enabled, mode, origins, granted, blocked }
//                                                                     (the one call a gate makes)
//   Admins    listAdmins() · isAdmin(id) · addAdmin({ id, label, addedBy }) · removeAdmin(id)
//   Grants    listGrants(ns, { limit }) · addGrant({ namespace, id, label, addedBy }) · removeGrant(ns, id)
//   Blocks    listBlocks(ns, { limit }) · addBlock({ namespace, id, label, addedBy }) · removeBlock(ns, id)
//   Requests  recordRequest({ namespace, user }) -> { isNew, attempts } · listRequests(ns, { limit }) · getRequest(ns, id)
//             · removeRequest(ns, id)
//   Audit     appendAudit({ actor, action, target, detail }) · listAudit({ limit })
//
// `create*` / `add*` return true if they made a row and false if it already existed (and leave the
// existing row alone); `update*` / `remove*` return true if there was a row to change.

import {
  DEFAULT_ACCESS,
  MAX_ORIGINS,
  OriginInUseError,
  assertAccessMode,
  assertOrigins,
  assertSiteNamespace,
  cleanLabel,
  cleanName,
  normalizeOrigin,
} from "./validate.js";

export const DEFAULT_REQUEST_CAP = 100;
export const DEFAULT_AUDIT_KEEP = 1000;
export const DEFAULT_LIST_LIMIT = 500;

export class MemoryHubStore {
  /**
   * @param {object} [options]
   * @param {number} [options.requestCap=100]   Pending access requests kept per site; the least
   *   recently seen are dropped first.
   * @param {number} [options.auditKeep=1000]   Audit entries kept.
   */
  constructor({ requestCap = DEFAULT_REQUEST_CAP, auditKeep = DEFAULT_AUDIT_KEEP } = {}) {
    this.requestCap = requestCap;
    this.auditKeep = auditKeep;
    this.namespaces = new Map();
    this.admins = new Map();
    this.grants = new Map(); // namespace -> Map(id -> grant)
    this.blocks = new Map(); // namespace -> Map(id -> block)
    this.requests = new Map(); // namespace -> Map(id -> request)
    this.audit = [];
    this.auditSeq = 0;
  }

  // --- Sites -----------------------------------------------------------------------------------

  async listNamespaces() {
    return [...this.namespaces.values()]
      .sort((a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.namespace, b.namespace))
      .map((record) => ({
        ...record,
        origins: [...record.origins],
        users: this.grants.get(record.namespace)?.size ?? 0,
        requests: this.requests.get(record.namespace)?.size ?? 0,
      }));
  }

  async getNamespace(namespace) {
    const record = this.namespaces.get(namespace);
    return record ? { ...record, origins: [...record.origins] } : null;
  }

  /**
   * `origins` is required: a site is born bound to the URL(s) it is served from, so there is no
   * moment at which a namespace exists but any Worker can use it.
   */
  async createNamespace({ namespace, name, origins, access = DEFAULT_ACCESS, createdBy = null }) {
    assertSiteNamespace(namespace);
    assertAccessMode(access);
    const bound = assertOrigins(origins);
    if (this.namespaces.has(namespace)) return false;
    for (const origin of bound) this.#assertFree(origin, namespace);
    this.namespaces.set(namespace, {
      namespace,
      name: cleanName(name) || namespace,
      enabled: true,
      access,
      origins: bound,
      createdAt: nowSeconds(),
      createdBy,
    });
    return true;
  }

  async updateNamespace(namespace, { name, enabled, access } = {}) {
    if (access !== undefined) assertAccessMode(access);
    const record = this.namespaces.get(namespace);
    if (!record) return false;
    if (name !== undefined) record.name = cleanName(name) || record.namespace;
    if (enabled !== undefined) record.enabled = Boolean(enabled);
    if (access !== undefined) record.access = access;
    return true;
  }

  /**
   * Adds a URL the site may be served from. True if added; false if it was already there or the site
   * does not exist. Throws for a URL that is not a valid origin, or past MAX_ORIGINS.
   */
  async addOrigin(namespace, url) {
    const origin = normalizeOrigin(url);
    if (!origin) throw new Error("origin must be an https URL such as https://docs.example.com (http only for localhost)");
    const record = this.namespaces.get(namespace);
    if (!record || record.origins.includes(origin)) return false;
    this.#assertFree(origin, namespace);
    if (record.origins.length >= MAX_ORIGINS) throw new Error(`a site can have at most ${MAX_ORIGINS} origins`);
    record.origins.push(origin);
    return true;
  }

  /**
   * The sites whose origins include `url`: one, normally; none for an unregistered origin. More than
   * one only if two admins gave the same URL to different sites at the same moment, which the caller
   * must treat as "cannot tell" and refuse, never as "pick one".
   */
  async namespacesForOrigin(url) {
    const origin = normalizeOrigin(url);
    if (!origin) return [];
    return [...this.namespaces.values()].filter((site) => site.origins.includes(origin)).map((site) => site.namespace).sort(compare);
  }

  #assertFree(origin, namespace) {
    for (const site of this.namespaces.values()) {
      if (site.namespace !== namespace && site.origins.includes(origin)) throw new OriginInUseError(origin, site.namespace);
    }
  }

  /**
   * Removes a URL. True if removed; false if it was not there, or it is the site's only one — a
   * site is never left without one.
   */
  async removeOrigin(namespace, url) {
    const origin = normalizeOrigin(url);
    const record = this.namespaces.get(namespace);
    if (!origin || !record || !record.origins.includes(origin) || record.origins.length === 1) return false;
    record.origins = record.origins.filter((o) => o !== origin);
    return true;
  }

  /**
   * Removes the site and everything that hung off it. Grants go first: if this is interrupted, the
   * site is left with fewer users than before, never with users and no site to attach them to
   * (which would hand them back their access if the name were registered again). Blocks go with
   * them, so a re-registered site does not inherit a stranger's ban list.
   */
  async deleteNamespace(namespace) {
    // Switched off first: if this is interrupted partway, the site is dead, not half-removed in a
    // way that could leave it open (an open site that has lost its grants still lets everyone in).
    const record = this.namespaces.get(namespace);
    if (record) record.enabled = false;
    this.grants.delete(namespace);
    this.blocks.delete(namespace);
    this.requests.delete(namespace);
    return this.namespaces.delete(namespace);
  }

  // --- Access ----------------------------------------------------------------------------------

  async access(namespace, userId) {
    const record = this.namespaces.get(namespace);
    if (!record) return { exists: false, enabled: false, mode: DEFAULT_ACCESS, origins: [], granted: false, blocked: false };
    const id = Number(userId);
    return {
      exists: true,
      enabled: record.enabled,
      mode: record.access,
      origins: [...record.origins],
      granted: Boolean(this.grants.get(namespace)?.has(id)),
      blocked: Boolean(this.blocks.get(namespace)?.has(id)),
    };
  }

  // --- Super admins ----------------------------------------------------------------------------

  async listAdmins() {
    return [...this.admins.values()].sort((a, b) => a.addedAt - b.addedAt || a.id - b.id).map((a) => ({ ...a }));
  }

  async isAdmin(id) {
    return this.admins.has(Number(id));
  }

  async addAdmin({ id, label = "", addedBy = null }) {
    id = Number(id);
    if (this.admins.has(id)) return false;
    this.admins.set(id, { id, label: cleanLabel(label), addedBy, addedAt: nowSeconds() });
    return true;
  }

  async removeAdmin(id) {
    return this.admins.delete(Number(id));
  }

  // --- Grants ----------------------------------------------------------------------------------

  async listGrants(namespace, { limit = DEFAULT_LIST_LIMIT } = {}) {
    const rows = [...(this.grants.get(namespace)?.values() ?? [])];
    return rows.sort((a, b) => b.addedAt - a.addedAt || a.id - b.id).slice(0, limit).map((g) => ({ ...g }));
  }

  async addGrant({ namespace, id, label = "", addedBy = null }) {
    id = Number(id);
    let forSite = this.grants.get(namespace);
    if (!forSite) this.grants.set(namespace, (forSite = new Map()));
    if (forSite.has(id)) return false;
    forSite.set(id, { namespace, id, label: cleanLabel(label), addedBy, addedAt: nowSeconds() });
    return true;
  }

  async removeGrant(namespace, id) {
    return this.grants.get(namespace)?.delete(Number(id)) ?? false;
  }

  // --- Blocks ----------------------------------------------------------------------------------
  // A block overrides everything: a blocked person is refused whether the site is open or not, and
  // whether or not they also hold a grant.

  async listBlocks(namespace, { limit = DEFAULT_LIST_LIMIT } = {}) {
    const rows = [...(this.blocks.get(namespace)?.values() ?? [])];
    return rows.sort((a, b) => b.addedAt - a.addedAt || a.id - b.id).slice(0, limit).map((b) => ({ ...b }));
  }

  async addBlock({ namespace, id, label = "", addedBy = null }) {
    id = Number(id);
    let forSite = this.blocks.get(namespace);
    if (!forSite) this.blocks.set(namespace, (forSite = new Map()));
    if (forSite.has(id)) return false;
    forSite.set(id, { namespace, id, label: cleanLabel(label), addedBy, addedAt: nowSeconds() });
    return true;
  }

  async removeBlock(namespace, id) {
    return this.blocks.get(namespace)?.delete(Number(id)) ?? false;
  }

  // --- Access requests -------------------------------------------------------------------------

  async recordRequest({ namespace, user }) {
    const id = Number(user.id);
    const now = nowSeconds();
    let forSite = this.requests.get(namespace);
    if (!forSite) this.requests.set(namespace, (forSite = new Map()));
    const existing = forSite.get(id);
    const attempts = (existing?.attempts ?? 0) + 1;
    forSite.set(id, {
      namespace,
      id,
      firstName: user.first_name ?? "",
      lastName: user.last_name ?? "",
      username: user.username ?? "",
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      attempts,
    });
    if (forSite.size > this.requestCap) {
      const oldest = [...forSite.values()].sort((a, b) => a.lastSeen - b.lastSeen || a.id - b.id);
      for (const row of oldest.slice(0, forSite.size - this.requestCap)) forSite.delete(row.id);
    }
    return { isNew: !existing, attempts };
  }

  async listRequests(namespace, { limit = DEFAULT_LIST_LIMIT } = {}) {
    const rows = [...(this.requests.get(namespace)?.values() ?? [])];
    return rows.sort((a, b) => b.lastSeen - a.lastSeen || b.id - a.id).slice(0, limit).map((r) => ({ ...r }));
  }

  async getRequest(namespace, id) {
    const row = this.requests.get(namespace)?.get(Number(id));
    return row ? { ...row } : null;
  }

  async removeRequest(namespace, id) {
    return this.requests.get(namespace)?.delete(Number(id)) ?? false;
  }

  // --- Audit -----------------------------------------------------------------------------------

  async appendAudit({ actor = null, action, target = "", detail = "" }) {
    this.audit.push({ id: ++this.auditSeq, at: nowSeconds(), actor, action, target, detail });
    if (this.audit.length > this.auditKeep) this.audit.splice(0, this.audit.length - this.auditKeep);
  }

  async listAudit({ limit = 100 } = {}) {
    return this.audit
      .slice(-limit)
      .reverse()
      .map((entry) => ({ ...entry }));
  }
}

/** Binary string order (SQLite's default collation), so both stores list ASCII names identically. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
