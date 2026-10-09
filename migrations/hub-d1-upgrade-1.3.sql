-- Upgrade for hub databases created before telegram-qr-signin 1.3.
--
--   wrangler d1 execute <your-db> --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1-upgrade-1.3.sql
--
-- A new database does not need this: hub-d1.sql already has it. It only adds a table and is safe to
-- run more than once.
--
-- The console remembers the Telegram name each super admin signs in with, so its activity log can say
-- "Ada" instead of a number. Until this is run the console still works and falls back to numbers
-- (and logs an error on each page load).

CREATE TABLE IF NOT EXISTS hub_admin_names (
  telegram_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
