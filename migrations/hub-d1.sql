-- Schema for D1HubStore (src/hub/d1-store.js) — the registry behind the shared-bot hub.
--
-- Apply to the database that the hub Worker AND every site Worker bind: the hub writes it from the
-- admin console, and each site's gate reads it on every guarded request.
--
--   wrangler d1 execute <your-db> --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1.sql
--
-- Unlike telegram_qr_logins, these rows are durable: they are the access list. Back them up like
-- one. If you pass `prefix` to `new D1HubStore(db, { prefix })`, rename the tables here to match.
--
-- Telegram user ids are stored as INTEGER. They exceed 32 bits (SQLite integers are 64-bit, and a
-- JavaScript number holds them exactly), so nothing here truncates them. All times are Unix epoch
-- seconds, for the same reason telegram_qr_logins uses them.

-- The sites ("namespaces") the hub serves. A site is registered here once; its Worker then uses
-- the same string as `namespace` in createSiteAuth.
CREATE TABLE IF NOT EXISTS hub_namespaces (
  namespace TEXT PRIMARY KEY,
  -- What people see in the bot chat and the console: "Acme dashboard".
  name TEXT NOT NULL,
  -- 0 shuts the site: nobody signs in, and sessions already open fail on their next request.
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Who gets in:
  --   'granted'   invite only: people holding a row in hub_grants, nobody else, no queue.
  --   'approval'  the same, but a stranger's scan is recorded in hub_requests so an admin can
  --               approve them (the admins and the person are messaged).
  --   'anyone'    any Telegram account not in hub_blocks.
  -- Grants are kept, not consulted, while a site is 'anyone', so switching back restores them.
  access TEXT NOT NULL DEFAULT 'granted' CHECK (access IN ('granted', 'approval', 'anyone')),
  -- The URLs the site is served from, as a JSON array of origins: '["https://docs.example.com"]'.
  -- A site finds its own namespace by looking its origin up here, a request from any other origin is
  -- refused, and so is a scan of a QR minted anywhere else. There must always be at least one: the
  -- database refuses a site without, so a site that anything could use is not a state that exists.
  origins TEXT NOT NULL CHECK (json_valid(origins) AND json_array_length(origins) >= 1),
  created_at INTEGER NOT NULL,
  created_by INTEGER
);

-- Super admins added through the console. The bootstrap admins from configuration are NOT rows
-- here — they cannot be removed from the console, which is what stops anyone locking themselves out.
CREATE TABLE IF NOT EXISTS hub_admins (
  telegram_id INTEGER PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  added_by INTEGER,
  added_at INTEGER NOT NULL
);

-- Who may sign in to which site. Presence of a row IS the permission; revoking deletes the row,
-- and the site's gate sees that on its very next request.
CREATE TABLE IF NOT EXISTS hub_grants (
  namespace TEXT NOT NULL,
  telegram_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  added_by INTEGER,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, telegram_id)
);

-- People refused by a site whatever else is true of them. A block beats a grant and applies to
-- 'anyone' sites too, which is how a site that is open to everyone bans someone.
CREATE TABLE IF NOT EXISTS hub_blocks (
  namespace TEXT NOT NULL,
  telegram_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  added_by INTEGER,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, telegram_id)
);

-- People who scanned the QR of an 'approval' site and are waiting to be let in, so an admin can
-- approve them without asking for a numeric Telegram id. Capped per site by the store; safe to
-- truncate at any time.
CREATE TABLE IF NOT EXISTS hub_requests (
  namespace TEXT NOT NULL,
  telegram_id INTEGER NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (namespace, telegram_id)
);

-- How a site proves who it is to the hub's API: a key made in the console and shown once. Only a
-- SHA-256 of it is stored, so this table cannot be turned back into working keys. One per site;
-- making a new one replaces it.
CREATE TABLE IF NOT EXISTS hub_site_keys (
  namespace TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every change made in the console, newest last. Pruned by the store to its most recent entries.
CREATE TABLE IF NOT EXISTS hub_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor INTEGER,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

-- Serves "which sites can this person use" and the per-site user list.
CREATE INDEX IF NOT EXISTS idx_hub_grants_namespace ON hub_grants (namespace, added_at);
CREATE INDEX IF NOT EXISTS idx_hub_blocks_namespace ON hub_blocks (namespace, added_at);
CREATE INDEX IF NOT EXISTS idx_hub_requests_namespace ON hub_requests (namespace, last_seen);
