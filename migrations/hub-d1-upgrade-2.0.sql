-- Upgrade for hub databases created before telegram-qr-signin 2.0 (1.x).
--
--   wrangler d1 execute <your-db> --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1-upgrade-2.0.sql
--
-- A new database does not need this: hub-d1.sql already has it. It only adds a table and is safe to
-- run more than once, and before deploying the new hub code.
--
-- In 2.0 a site no longer binds the hub's database. It calls the hub's API with a key instead, and
-- the hub stores a hash of each key here. Existing sites have no key yet: open each one in the
-- console and make one under "Site key", then give it to the site as HUB_KEY.

CREATE TABLE IF NOT EXISTS hub_site_keys (
  namespace TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
