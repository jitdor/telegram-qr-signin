-- Upgrade for databases created before the 'approval' access mode (telegram-qr-signin 1.0.x).
--
--   wrangler d1 execute <your-db> --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1-upgrade-1.1.sql
--
-- A new database does not need this: hub-d1.sql already has it. Run it once, before deploying the
-- new code, and not twice (the second run would find nothing to rebuild and is harmless, but there
-- is no reason to).
--
-- SQLite cannot change a CHECK constraint, so the sites table is rebuilt: copied, with its rows and
-- column order unchanged, into a table whose `access` also allows 'approval'.
--
-- Before 1.1, every 'granted' site kept a queue of refused scans for an admin to approve. In 1.1
-- that behaviour is the 'approval' mode, and 'granted' became invite only, with no queue. The last
-- statement moves existing 'granted' sites to 'approval' so nothing changes for anyone. To make a
-- site invite only, switch it in the console (Access), or delete the UPDATE below to keep every
-- site as it was named.

ALTER TABLE hub_namespaces RENAME TO hub_namespaces_before_approval;

CREATE TABLE hub_namespaces (
  namespace TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  access TEXT NOT NULL DEFAULT 'granted' CHECK (access IN ('granted', 'approval', 'anyone')),
  origins TEXT NOT NULL CHECK (json_valid(origins) AND json_array_length(origins) >= 1),
  created_at INTEGER NOT NULL,
  created_by INTEGER
);

INSERT INTO hub_namespaces (namespace, name, enabled, access, origins, created_at, created_by)
  SELECT namespace, name, enabled, access, origins, created_at, created_by FROM hub_namespaces_before_approval;

DROP TABLE hub_namespaces_before_approval;

UPDATE hub_namespaces SET access = 'approval' WHERE access = 'granted';
