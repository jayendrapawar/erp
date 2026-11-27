-- Manual rollback for 0002_inventory_foundation. Not run by the migration runner.
--
--   1. Take a backup first (scripts/db/backup.ts). Every row in the new tables
--      (scan events, ledger, audit, suppliers, locations) is dropped by this file.
--   2. Run inside one transaction, e.g. psql -1 -f, or paste into the Neon SQL editor.
--   3. Then: DELETE FROM schema_migrations WHERE version = '0002';
--
-- legacy_scans was never modified by 0002, so the old scanner data returns intact.

ALTER TABLE legacy_scans RENAME CONSTRAINT legacy_scans_pkey TO scans_pkey;
ALTER TABLE legacy_scans RENAME TO scans;

DROP VIEW IF EXISTS article_quality_issues;
DROP TABLE IF EXISTS missing_article_reviews;
DROP VIEW IF EXISTS stock_balance_mismatches;
DROP FUNCTION IF EXISTS stock_balances_rebuild();
DROP TABLE IF EXISTS stock_balances;
DROP TABLE IF EXISTS stock_movements;
DROP FUNCTION IF EXISTS stock_movements_apply();
DROP FUNCTION IF EXISTS stock_movements_immutable();
DROP FUNCTION IF EXISTS stock_balances_guard();
ALTER TABLE article_scan_links DROP CONSTRAINT IF EXISTS article_scan_links_scan_event_fk;
DROP TABLE IF EXISTS scan_events;
DROP TABLE IF EXISTS locations;
DROP TABLE IF EXISTS audit_events;

ALTER TABLE article_scan_links DROP COLUMN IF EXISTS "scanEventId", DROP COLUMN IF EXISTS "userId";
ALTER TABLE article_sizes DROP CONSTRAINT IF EXISTS article_sizes_article_size_unique, DROP COLUMN IF EXISTS active;
DROP INDEX IF EXISTS articles_code_colour_idx;
ALTER TABLE articles DROP COLUMN IF EXISTS "reviewStatus", DROP COLUMN IF EXISTS active, DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS division;

DROP TABLE IF EXISTS suppliers;
CREATE TABLE shopkeepers (
  id serial PRIMARY KEY, name text NOT NULL, code text, phone text, address text,
  "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX shopkeepers_name_idx ON shopkeepers (name);

DROP INDEX IF EXISTS orders_retailer_idx;
ALTER TABLE orders DROP COLUMN IF EXISTS "retailerId";
DROP INDEX IF EXISTS retailers_party_name_unique;
ALTER INDEX retailers_party_name_idx RENAME TO vendors_party_name_idx;
ALTER TABLE retailers RENAME CONSTRAINT retailers_pkey TO vendors_pkey;
ALTER TABLE retailers RENAME TO vendors;
