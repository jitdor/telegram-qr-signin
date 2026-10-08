-- Upgrade for a hub database created before sites could be open to anyone.
--
-- Run it ONCE, against a database that was set up with an earlier migrations/hub-d1.sql. A fresh
-- install does not need it: the current hub-d1.sql already has everything below.
--
--   wrangler d1 execute <your-db> --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1-upgrade-access.sql
--
-- Every existing site becomes 'granted', which is exactly how it behaved before, so nobody gains
-- or loses access by running this. (SQLite cannot add a column "if not exists", so a second run
-- fails on the first statement with "duplicate column name" and changes nothing.)

ALTER TABLE hub_namespaces ADD COLUMN access TEXT NOT NULL DEFAULT 'granted' CHECK (access IN ('granted', 'anyone'));

CREATE TABLE IF NOT EXISTS hub_blocks (
  namespace TEXT NOT NULL,
  telegram_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  added_by INTEGER,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_hub_blocks_namespace ON hub_blocks (namespace, added_at);
