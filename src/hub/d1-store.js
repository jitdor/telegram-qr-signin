// Cloudflare D1 hub registry — the supported store for a real hub, because the hub Worker and every
// site Worker are separate isolates that must see the same access list. All of them bind the same
// database; the hub writes it from the console and each site's gate reads it. See
// ../../migrations/hub-d1.sql for the schema.
//
// Every statement is a single atomic SQL operation (conditional INSERT/UPDATE/DELETE), so two
// admins acting at once cannot corrupt anything. A gate check is ONE query (`access`), because it
// runs on every guarded request of every site.

import { DEFAULT_ACCESS, assertAccessMode, assertSiteNamespace, cleanLabel, cleanName } from "./validate.js";
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
      grants: `${prefix}grants`,
      blocks: `${prefix}blocks`,
      requests: `${prefix}requests`,
      audit: `${prefix}audit`,
    };
  }

  // --- Sites -----------------------------------------------------------------------------------

  async listNamespaces() {
    const { results } = await this.db
      .prepare(
        `SELECT n.namespace, n.name, n.enabled, n.access, n.created_at, n.created_by,
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
      .prepare(`SELECT namespace, name, enabled, access, created_at, created_by FROM ${this.t.namespaces} WHERE namespace = ?1`)
      .bind(namespace)
      .first();
    return row ? rowToNamespace(row) : null;
  }

  async createNamespace({ namespace, name, access = DEFAULT_ACCESS, createdBy = null }) {
    assertSiteNamespace(namespace);
    assertAccessMode(access);
    const res = await this.db
      .prepare(
        `INSERT INTO ${this.t.namespaces} (namespace, name, enabled, access, created_at, created_by)
         VALUES (?1, ?2, 1, ?3, ?4, ?5) ON CONFLICT (namespace) DO NOTHING`
      )
      .bind(namespace, cleanName(name) || namespace, access, nowSeconds(), createdBy)
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

  /** Grants, blocks and requests first, then the site — see MemoryHubStore.deleteNamespace for why. */
  async deleteNamespace(namespace) {
    await this.db.prepare(`DELETE FROM ${this.t.grants} WHERE namespace = ?1`).bind(namespace).run();
    await this.db.prepare(`DELETE FROM ${this.t.blocks} WHERE namespace = ?1`).bind(namespace).run();
    await this.db.prepare(`DELETE FROM ${this.t.requests} WHERE namespace = ?1`).bind(namespace).run();
    const res = await this.db.prepare(`DELETE FROM ${this.t.namespaces} WHERE namespace = ?1`).bind(namespace).run();
    return res.meta.changes > 0;
  }

  // --- Access ----------------------------------------------------------------------------------

  async access(namespace, userId) {
    const row = await this.db
      .prepare(
        `SELECT n.enabled AS enabled, n.access AS access,
                EXISTS (SELECT 1 FROM ${this.t.grants} g WHERE g.namespace = n.namespace AND g.telegram_id = ?2) AS granted,
                EXISTS (SELECT 1 FROM ${this.t.blocks} b WHERE b.namespace = n.namespace AND b.telegram_id = ?2) AS blocked
         FROM ${this.t.namespaces} n WHERE n.namespace = ?1`
      )
      .bind(namespace, Number(userId))
      .first();
    if (!row) return { exists: false, enabled: false, mode: DEFAULT_ACCESS, granted: false, blocked: false };
    return {
      exists: true,
      enabled: Boolean(row.enabled),
      mode: row.access ?? DEFAULT_ACCESS,
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
    await this.db
      .prepare(
        `INSERT INTO ${this.t.requests}
           (namespace, telegram_id, first_name, last_name, username, first_seen, last_seen, attempts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1)
         ON CONFLICT (namespace, telegram_id) DO UPDATE SET
           first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username,
           last_seen = excluded.last_seen, attempts = attempts + 1`
      )
      .bind(namespace, Number(user.id), user.first_name ?? "", user.last_name ?? "", user.username ?? "", nowSeconds())
      .run();
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
    createdAt: Number(row.created_at),
    createdBy: row.created_by == null ? null : Number(row.created_by),
  };
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
