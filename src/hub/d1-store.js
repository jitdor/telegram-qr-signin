// Cloudflare D1 hub registry — the supported store for a real hub, because the hub Worker and every
// site Worker are separate isolates that must see the same access list. All of them bind the same
// database; the hub writes it from the console and each site's gate reads it. See
// ../../migrations/hub-d1.sql for the schema.
//
// Every statement is a single atomic SQL operation (conditional INSERT/UPDATE/DELETE), so two
// admins acting at once cannot corrupt anything. A gate check is ONE query (`access`), because it
// runs on every guarded request of every site.

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
import { DEFAULT_REQUEST_CAP, DEFAULT_AUDIT_KEEP, DEFAULT_LIST_LIMIT } from "./store.js";

// Table names are interpolated, not bound (SQLite cannot bind identifiers), so they are validated.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class D1HubStore {
  /**
   * @param {D1Database} db   A D1 binding, e.g. `env.HUB_DB`.
   * @param {object} [options]
   * @param {string} [options.prefix="hub_"]  Table-name prefix; must match the migration.
   * @param {number} [options.requestCap=100]
   * @param {number} [options.auditKeep=1000]
   */
  constructor(db, { prefix = "hub_", requestCap = DEFAULT_REQUEST_CAP, auditKeep = DEFAULT_AUDIT_KEEP } = {}) {
    if (!db) throw new Error("D1HubStore: a D1 database binding is required");
    if (!SAFE_IDENTIFIER.test(prefix)) throw new Error(`D1HubStore: unsafe table prefix ${JSON.stringify(prefix)}`);
    this.db = db;
    this.requestCap = requestCap;
    this.auditKeep = auditKeep;
    this.t = {
      namespaces: `${prefix}namespaces`,
      admins: `${prefix}admins`,
      adminNames: `${prefix}admin_names`,
      grants: `${prefix}grants`,
      blocks: `${prefix}blocks`,
      requests: `${prefix}requests`,
      audit: `${prefix}audit`,
      keys: `${prefix}site_keys`,
    };
  }

  // --- Sites -----------------------------------------------------------------------------------

  async listNamespaces() {
    const { results } = await this.db
      .prepare(
        `SELECT n.namespace, n.name, n.enabled, n.access, n.origins, n.created_at, n.created_by,
                (SELECT COUNT(*) FROM ${this.t.grants} g WHERE g.namespace = n.namespace) AS users,
                (SELECT COUNT(*) FROM ${this.t.requests} r WHERE r.namespace = n.namespace) AS requests
         FROM ${this.t.namespaces} n ORDER BY n.name COLLATE NOCASE, n.namespace`
      )
      .bind()
      .all();
    return results.map((row) => ({ ...rowToNamespace(row), users: Number(row.users), requests: Number(row.requests) }));
  }

  async getNamespace(namespace) {
    const row = await this.db
      .prepare(`SELECT namespace, name, enabled, access, origins, created_at, created_by FROM ${this.t.namespaces} WHERE namespace = ?1`)
      .bind(namespace)
      .first();
    return row ? rowToNamespace(row) : null;
  }

  /** One INSERT, origins included: there is no instant at which the site exists without them. */
  async createNamespace({ namespace, name, origins, access = DEFAULT_ACCESS, createdBy = null }) {
    assertSiteNamespace(namespace);
    assertAccessMode(access);
    const bound = assertOrigins(origins);
    for (const origin of bound) await this.#assertFree(origin, namespace);
    const res = await this.db
      .prepare(
        `INSERT INTO ${this.t.namespaces} (namespace, name, enabled, access, origins, created_at, created_by)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6) ON CONFLICT (namespace) DO NOTHING`
      )
      .bind(namespace, cleanName(name) || namespace, access, JSON.stringify(bound), nowSeconds(), createdBy)
      .run();
    return res.meta.changes > 0;
  }

  async updateNamespace(namespace, { name, enabled, access } = {}) {
    if (access !== undefined) assertAccessMode(access);
    const res = await this.db
      .prepare(
        `UPDATE ${this.t.namespaces}
         SET name = COALESCE(?2, name), enabled = COALESCE(?3, enabled), access = COALESCE(?4, access)
         WHERE namespace = ?1`
      )
      .bind(
        namespace,
        name === undefined ? null : cleanName(name) || namespace,
        enabled === undefined ? null : enabled ? 1 : 0,
        access === undefined ? null : access
      )
      .run();
    return res.meta.changes > 0;
  }

  /**
   * Adds a URL the site may be served from — a compare-and-swap on the site's own row, so two
   * admins editing at once cannot lose each other's change. See MemoryHubStore.addOrigin.
   */
  async addOrigin(namespace, url) {
    const origin = normalizeOrigin(url);
    if (!origin) throw new Error("origin must be an https URL such as https://docs.example.com (http only for localhost)");
    return this.#editOrigins(namespace, async (list) => {
      if (list.includes(origin)) return null;
      await this.#assertFree(origin, namespace);
      if (list.length >= MAX_ORIGINS) throw new Error(`a site can have at most ${MAX_ORIGINS} origins`);
      return [...list, origin];
    });
  }

  /**
   * The sites whose origins include `url` — normally one, none if unregistered. The match runs in
   * SQL over each row's JSON list; a row whose JSON is damaged is skipped (and is shut anyway by the
   * gate) instead of failing the lookup for every other site.
   */
  async namespacesForOrigin(url) {
    const origin = normalizeOrigin(url);
    if (!origin) return [];
    const { results } = await this.db
      .prepare(
        `SELECT n.namespace FROM ${this.t.namespaces} n
         WHERE CASE WHEN json_valid(n.origins)
                    THEN EXISTS (SELECT 1 FROM json_each(n.origins) j WHERE j.value = ?1)
                    ELSE 0 END
         ORDER BY n.namespace LIMIT 5`
      )
      .bind(origin)
      .all();
    return results.map((row) => row.namespace);
  }

  async #assertFree(origin, namespace) {
    const owner = (await this.namespacesForOrigin(origin)).find((ns) => ns !== namespace);
    if (owner) throw new OriginInUseError(origin, owner);
  }

  /** See MemoryHubStore.removeOrigin: never removes a site's last origin. */
  async removeOrigin(namespace, url) {
    const origin = normalizeOrigin(url);
    if (!origin) return false;
    return this.#editOrigins(namespace, (list) => (list.includes(origin) && list.length > 1 ? list.filter((o) => o !== origin) : null));
  }

  /** Read the list, compute the next one, and write it only if nobody changed it meanwhile. */
  async #editOrigins(namespace, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.db.prepare(`SELECT origins FROM ${this.t.namespaces} WHERE namespace = ?1`).bind(namespace).first();
      if (!row) return false;
      const next = await change(parseOrigins(row.origins, { forEdit: true }));
      if (next === null) return false;
      const res = await this.db
        .prepare(`UPDATE ${this.t.namespaces} SET origins = ?3 WHERE namespace = ?1 AND origins = ?2`)
        .bind(namespace, row.origins, JSON.stringify(next))
        .run();
      if (res.meta.changes > 0) return true;
    }
    throw new Error("D1HubStore: the site's origins kept changing underneath this edit; try again");
  }

  /** Switched off first, then grants, blocks and requests, then the site — see MemoryHubStore.deleteNamespace for why. */
  async deleteNamespace(namespace) {
    await this.db.prepare(`UPDATE ${this.t.namespaces} SET enabled = 0 WHERE namespace = ?1`).bind(namespace).run();
    await this.db.prepare(`DELETE FROM ${this.t.grants} WHERE namespace = ?1`).bind(namespace).run();
    await this.db.prepare(`DELETE FROM ${this.t.blocks} WHERE namespace = ?1`).bind(namespace).run();
    await this.db.prepare(`DELETE FROM ${this.t.requests} WHERE namespace = ?1`).bind(namespace).run();
    await this.db.prepare(`DELETE FROM ${this.t.keys} WHERE namespace = ?1`).bind(namespace).run();
    const res = await this.db.prepare(`DELETE FROM ${this.t.namespaces} WHERE namespace = ?1`).bind(namespace).run();
    return res.meta.changes > 0;
  }

  // --- Site keys -------------------------------------------------------------------------------

  async setSiteKey(namespace, hash) {
    // INSERT ... SELECT so a key is only ever written for a site that exists.
    const res = await this.db
      .prepare(
        `INSERT INTO ${this.t.keys} (namespace, key_hash, created_at)
         SELECT namespace, ?2, ?3 FROM ${this.t.namespaces} WHERE namespace = ?1
         ON CONFLICT (namespace) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at`
      )
      .bind(namespace, String(hash), nowSeconds())
      .run();
    return res.meta.changes > 0;
  }

  async getSiteKey(namespace) {
    const row = await this.db.prepare(`SELECT key_hash, created_at FROM ${this.t.keys} WHERE namespace = ?1`).bind(namespace).first();
    return row ? { hash: row.key_hash, createdAt: row.created_at } : null;
  }

  async removeSiteKey(namespace) {
    const res = await this.db.prepare(`DELETE FROM ${this.t.keys} WHERE namespace = ?1`).bind(namespace).run();
    return res.meta.changes > 0;
  }

  // --- Access ----------------------------------------------------------------------------------

  async access(namespace, userId) {
    const row = await this.db
      .prepare(
        `SELECT n.enabled AS enabled, n.access AS access, n.origins AS origins,
                EXISTS (SELECT 1 FROM ${this.t.grants} g WHERE g.namespace = n.namespace AND g.telegram_id = ?2) AS granted,
                EXISTS (SELECT 1 FROM ${this.t.blocks} b WHERE b.namespace = n.namespace AND b.telegram_id = ?2) AS blocked
         FROM ${this.t.namespaces} n WHERE n.namespace = ?1`
      )
      .bind(namespace, Number(userId))
      .first();
    if (!row) return { exists: false, enabled: false, mode: DEFAULT_ACCESS, origins: [], granted: false, blocked: false };
    return {
      exists: true,
      enabled: Boolean(row.enabled),
      mode: row.access ?? DEFAULT_ACCESS,
      origins: parseOrigins(row.origins),
      granted: Boolean(row.granted),
      blocked: Boolean(row.blocked),
    };
  }

  // --- Super admins ----------------------------------------------------------------------------

  async listAdmins() {
    const { results } = await this.db
      .prepare(`SELECT telegram_id, label, added_by, added_at FROM ${this.t.admins} ORDER BY added_at, telegram_id`)
      .bind()
      .all();
    return results.map((row) => ({
      id: Number(row.telegram_id),
      label: row.label ?? "",
      addedBy: row.added_by == null ? null : Number(row.added_by),
      addedAt: Number(row.added_at),
    }));
  }

  async isAdmin(id) {
    const row = await this.db.prepare(`SELECT 1 AS found FROM ${this.t.admins} WHERE telegram_id = ?1`).bind(Number(id)).first();
    return Boolean(row);
  }

  async addAdmin({ id, label = "", addedBy = null }) {
    const res = await this.db
      .prepare(
        `INSERT INTO ${this.t.admins} (telegram_id, label, added_by, added_at)
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT (telegram_id) DO NOTHING`
      )
      .bind(Number(id), cleanLabel(label), addedBy, nowSeconds())
      .run();
    return res.meta.changes > 0;
  }

  async listAdminNames() {
    const { results } = await this.db.prepare(`SELECT telegram_id, name FROM ${this.t.adminNames}`).bind().all();
    return results.map((row) => ({ id: Number(row.telegram_id), name: row.name }));
  }

  async setAdminName(id, name) {
    const clean = cleanLabel(name);
    if (!clean) return;
    await this.db
      .prepare(
        `INSERT INTO ${this.t.adminNames} (telegram_id, name, seen_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (telegram_id) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at`
      )
      .bind(Number(id), clean, nowSeconds())
      .run();
  }

  async removeAdmin(id) {
    const res = await this.db.prepare(`DELETE FROM ${this.t.admins} WHERE telegram_id = ?1`).bind(Number(id)).run();
    return res.meta.changes > 0;
  }

  // --- Grants ----------------------------------------------------------------------------------

  async listGrants(namespace, { limit = DEFAULT_LIST_LIMIT } = {}) {
    const { results } = await this.db
      .prepare(
        `SELECT namespace, telegram_id, label, added_by, added_at FROM ${this.t.grants}
         WHERE namespace = ?1 ORDER BY added_at DESC, telegram_id LIMIT ?2`
      )
      .bind(namespace, limit)
      .all();
    return results.map((row) => ({
      namespace: row.namespace,
      id: Number(row.telegram_id),
      label: row.label ?? "",
      addedBy: row.added_by == null ? null : Number(row.added_by),
      addedAt: Number(row.added_at),
    }));
  }

  async addGrant({ namespace, id, label = "", addedBy = null }) {
    const res = await this.db
      .prepare(
        `INSERT INTO ${this.t.grants} (namespace, telegram_id, label, added_by, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (namespace, telegram_id) DO NOTHING`
      )
      .bind(namespace, Number(id), cleanLabel(label), addedBy, nowSeconds())
      .run();
    return res.meta.changes > 0;
  }

  async removeGrant(namespace, id) {
    const res = await this.db
      .prepare(`DELETE FROM ${this.t.grants} WHERE namespace = ?1 AND telegram_id = ?2`)
      .bind(namespace, Number(id))
      .run();
    return res.meta.changes > 0;
  }

  // --- Blocks ----------------------------------------------------------------------------------

  async listBlocks(namespace, { limit = DEFAULT_LIST_LIMIT } = {}) {
    const { results } = await this.db
      .prepare(
        `SELECT namespace, telegram_id, label, added_by, added_at FROM ${this.t.blocks}
         WHERE namespace = ?1 ORDER BY added_at DESC, telegram_id LIMIT ?2`
      )
      .bind(namespace, limit)
      .all();
    return results.map((row) => ({
      namespace: row.namespace,
      id: Number(row.telegram_id),
      label: row.label ?? "",
      addedBy: row.added_by == null ? null : Number(row.added_by),
      addedAt: Number(row.added_at),
    }));
  }

  async addBlock({ namespace, id, label = "", addedBy = null }) {
    const res = await this.db
      .prepare(
        `INSERT INTO ${this.t.blocks} (namespace, telegram_id, label, added_by, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (namespace, telegram_id) DO NOTHING`
      )
      .bind(namespace, Number(id), cleanLabel(label), addedBy, nowSeconds())
      .run();
    return res.meta.changes > 0;
  }

  async removeBlock(namespace, id) {
    const res = await this.db
      .prepare(`DELETE FROM ${this.t.blocks} WHERE namespace = ?1 AND telegram_id = ?2`)
      .bind(namespace, Number(id))
      .run();
    return res.meta.changes > 0;
  }

  // --- Access requests -------------------------------------------------------------------------

  async recordRequest({ namespace, user }) {
    // RETURNING gives the count this very statement produced, so "is this the first time" is
    // decided atomically: of two scans racing for the same person, exactly one sees attempts = 1.
    const row = await this.db
      .prepare(
        `INSERT INTO ${this.t.requests}
           (namespace, telegram_id, first_name, last_name, username, first_seen, last_seen, attempts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1)
         ON CONFLICT (namespace, telegram_id) DO UPDATE SET
           first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username,
           last_seen = excluded.last_seen, attempts = attempts + 1
         RETURNING attempts`
      )
      .bind(namespace, Number(user.id), user.first_name ?? "", user.last_name ?? "", user.username ?? "", nowSeconds())
      .first();
    const attempts = Number(row?.attempts ?? 1);
    // Keep only the most recently seen `requestCap`, so strangers scanning a site's QR cannot grow
    // this table without bound.
    await this.db
      .prepare(
        `DELETE FROM ${this.t.requests} WHERE namespace = ?1 AND telegram_id NOT IN (
           SELECT telegram_id FROM ${this.t.requests} WHERE namespace = ?1
           ORDER BY last_seen DESC, telegram_id DESC LIMIT ?2)`
      )
      .bind(namespace, this.requestCap)
      .run();
    return { isNew: attempts === 1, attempts };
  }

  async listRequests(namespace, { limit = DEFAULT_LIST_LIMIT } = {}) {
    const { results } = await this.db
      .prepare(
        `SELECT namespace, telegram_id, first_name, last_name, username, first_seen, last_seen, attempts
         FROM ${this.t.requests} WHERE namespace = ?1 ORDER BY last_seen DESC, telegram_id DESC LIMIT ?2`
      )
      .bind(namespace, limit)
      .all();
    return results.map(rowToRequest);
  }

  async getRequest(namespace, id) {
    const row = await this.db
      .prepare(
        `SELECT namespace, telegram_id, first_name, last_name, username, first_seen, last_seen, attempts
         FROM ${this.t.requests} WHERE namespace = ?1 AND telegram_id = ?2`
      )
      .bind(namespace, Number(id))
      .first();
    return row ? rowToRequest(row) : null;
  }

  async removeRequest(namespace, id) {
    const res = await this.db
      .prepare(`DELETE FROM ${this.t.requests} WHERE namespace = ?1 AND telegram_id = ?2`)
      .bind(namespace, Number(id))
      .run();
    return res.meta.changes > 0;
  }

  // --- Audit -----------------------------------------------------------------------------------

  async appendAudit({ actor = null, action, target = "", detail = "" }) {
    await this.db
      .prepare(`INSERT INTO ${this.t.audit} (at, actor, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(nowSeconds(), actor, action, target, detail)
      .run();
    // Delete everything older than the newest `auditKeep` entries. When there are fewer than that
    // the subquery is NULL, `id <= NULL` is never true, and nothing is deleted.
    await this.db
      .prepare(`DELETE FROM ${this.t.audit} WHERE id <= (SELECT id FROM ${this.t.audit} ORDER BY id DESC LIMIT 1 OFFSET ?1)`)
      .bind(this.auditKeep)
      .run();
  }

  async listAudit({ limit = 100 } = {}) {
    const { results } = await this.db
      .prepare(`SELECT id, at, actor, action, target, detail FROM ${this.t.audit} ORDER BY id DESC LIMIT ?1`)
      .bind(limit)
      .all();
    return results.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      actor: row.actor == null ? null : Number(row.actor),
      action: row.action,
      target: row.target ?? "",
      detail: row.detail ?? "",
    }));
  }
}

function rowToNamespace(row) {
  return {
    namespace: row.namespace,
    name: row.name,
    enabled: Boolean(row.enabled),
    access: row.access ?? DEFAULT_ACCESS,
    origins: parseOrigins(row.origins),
    createdAt: Number(row.created_at),
    createdBy: row.created_by == null ? null : Number(row.created_by),
  };
}

/** Matches no real origin, so a site whose stored list cannot be read is refused, not opened to every URL. */
const UNREADABLE = "(unreadable)";

/**
 * The site's origins from the stored JSON. The schema guarantees a non-empty list of origins, so
 * anything else (damaged by hand, or written around the CHECK) is reported as one origin that can
 * never match: the site is shut, visibly. `forEdit` reads only the valid entries, so adding an
 * origin repairs it.
 */
function parseOrigins(value, { forEdit = false } = {}) {
  let list;
  try {
    list = JSON.parse(value ?? "[]");
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) return forEdit ? [] : [UNREADABLE];
  const valid = list.filter((o) => typeof o === "string" && normalizeOrigin(o) === o);
  return valid.length === 0 && !forEdit ? [UNREADABLE] : valid;
}

function rowToRequest(row) {
  return {
    namespace: row.namespace,
    id: Number(row.telegram_id),
    firstName: row.first_name ?? "",
    lastName: row.last_name ?? "",
    username: row.username ?? "",
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
    attempts: Number(row.attempts),
  };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
