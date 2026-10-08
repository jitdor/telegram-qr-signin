-- Upgrade for a hub database created before sites were bound to their URLs.
--
-- Run it ONCE, against a database set up with an earlier migrations/hub-d1.sql (and, if that was
-- older than open access, after hub-d1-upgrade-access.sql). A fresh install does not need it.
--
--   wrangler d1 execute <your-db> --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1-upgrade-origins.sql
--
-- Existing sites become "unbound" ('[]'): they keep working exactly as before, from any URL, so
-- nobody is locked out by running this. The console flags every unbound site; open each one and
-- add the URL it is served from. Once a site has an origin, requests from anywhere else are refused.
-- (SQLite cannot add a column "if not exists", so a second run fails on this statement with
-- "duplicate column name" and changes nothing.)

ALTER TABLE hub_namespaces ADD COLUMN origins TEXT NOT NULL DEFAULT '[]';
