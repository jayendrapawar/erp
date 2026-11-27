-- detect: select to_regclass('stock_movements') is not null as present
-- requires-backup
--
-- Inventory foundation (see docs/architecture/inventory-foundation.md).
--
--  1. Parties: vendors → retailers (it always held retailers); orders get retailerId;
--     a real suppliers table; the unused shopkeepers table is removed.
--  2. Article master: review status, source and division on articles; article_sizes
--     becomes the stable SKU table (unique per article + size, deactivated not deleted).
--  3. audit_events: who changed what, before/after, and why.
--  4. locations: warehouse → section → rack → shelf / zone, seeded with MAIN.
--  5. scan_events: one row per physical box scan (never merged), idempotent per device
--     event, one active scan per unique label.
--  6. stock_movements (append-only ledger) + stock_balances (maintained by trigger only).
--  7. missing_article_reviews: admin review state for unknown article/colour codes.
--  8. scans → legacy_scans (kept read-only; imported by scripts/db/import-legacy-scans.ts).
--
-- Rollback: 0002_inventory_foundation.down.sql (restores the previous table names; new
-- tables and their rows are dropped, so take the required backup first).

-- ── 1. Parties ─────────────────────────────────────────────────────────────

ALTER TABLE vendors RENAME TO retailers;
ALTER TABLE retailers RENAME CONSTRAINT vendors_pkey TO retailers_pkey;
ALTER INDEX vendors_party_name_idx RENAME TO retailers_party_name_idx;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM retailers GROUP BY lower(btrim("partyName")) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'retailers has duplicate party names (case-insensitive). Merge them before adding the unique index.';
  END IF;
END $$;
CREATE UNIQUE INDEX retailers_party_name_unique ON retailers (lower(btrim("partyName")));

ALTER TABLE orders ADD COLUMN "retailerId" text REFERENCES retailers(id) ON DELETE RESTRICT;
UPDATE orders o SET "retailerId" = r.id
FROM retailers r
WHERE lower(btrim(r."partyName")) = lower(btrim(o."shopkeeperName"));
CREATE INDEX orders_retailer_idx ON orders ("retailerId");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shopkeepers) THEN
    RAISE EXCEPTION 'shopkeepers has rows. It was believed unused; review before dropping.';
  END IF;
END $$;
DROP TABLE shopkeepers;

CREATE TABLE suppliers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  "contactPerson" text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  gst text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  divisions text[] NOT NULL DEFAULT '{}',
  "paymentTermsDays" integer CHECK ("paymentTermsDays" IS NULL OR "paymentTermsDays" >= 0),
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_name_unique ON suppliers (lower(btrim(name)));

-- ── 2. Article master ──────────────────────────────────────────────────────

-- Existing rows came from CSV imports and are known to be partly wrong: they start as
-- 'unverified'. They stay usable for scanning and orders; review marks them 'approved'.
ALTER TABLE articles
  ADD COLUMN "reviewStatus" text NOT NULL DEFAULT 'unverified' CHECK ("reviewStatus" IN ('unverified', 'approved')),
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN source text NOT NULL DEFAULT 'legacy' CHECK (source IN ('legacy', 'import', 'manual', 'scan_dialog')),
  ADD COLUMN division text;

CREATE INDEX articles_code_colour_idx ON articles (upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')), upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g')));

-- article_sizes rows are the SKUs (article + colour + size). Their ids are referenced by
-- the ledger, so they are deactivated instead of deleted from now on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM article_sizes GROUP BY "articleId", "sizeLabel" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'article_sizes has duplicate (article, size) rows. Merge them first.';
  END IF;
END $$;
ALTER TABLE article_sizes ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE article_sizes ADD CONSTRAINT article_sizes_article_size_unique UNIQUE ("articleId", "sizeLabel");

ALTER TABLE article_scan_links
  ADD COLUMN "userId" text REFERENCES "user"(id) ON DELETE SET NULL,
  ADD COLUMN "scanEventId" bigint;

-- ── 3. Audit log ───────────────────────────────────────────────────────────

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  "occurredAt" timestamptz NOT NULL DEFAULT now(),
  "actorUserId" text REFERENCES "user"(id) ON DELETE SET NULL,
  "actorName" text NOT NULL DEFAULT '',
  action text NOT NULL,
  "entityType" text NOT NULL,
  "entityId" text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  metadata jsonb
);
CREATE INDEX audit_events_entity_idx ON audit_events ("entityType", "entityId", "occurredAt" DESC);
CREATE INDEX audit_events_actor_idx ON audit_events ("actorUserId", "occurredAt" DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, "occurredAt" DESC);

-- ── 4. Locations ───────────────────────────────────────────────────────────

CREATE TABLE locations (
  id serial PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('warehouse', 'section', 'rack', 'shelf', 'zone')),
  "parentId" integer REFERENCES locations(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_code_unique UNIQUE (code),
  CONSTRAINT locations_parent_check CHECK ("parentId" IS NULL OR "parentId" <> id)
);
INSERT INTO locations (code, name, kind) VALUES ('MAIN', 'Main warehouse', 'warehouse');

-- ── 5. Scan events ─────────────────────────────────────────────────────────

CREATE TABLE scan_events (
  id bigserial PRIMARY KEY,
  "clientEventId" uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'stocktake' CHECK (purpose IN ('stocktake')),
  "entryType" text NOT NULL CHECK ("entryType" IN ('scan', 'manual')),
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'offline_sync', 'legacy_import')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  "rawInput" text,
  payload text,
  "dedupeKey" text,
  "formatId" text,
  "parserVersion" text,
  "parseStatus" text CHECK ("parseStatus" IN ('parsed', 'partial', 'manual')),
  parsed jsonb,
  "articleCode" text,
  "colourCode" text,
  "sizeLabel" text,
  mrp numeric(10, 2),
  "mfgMonth" integer CHECK ("mfgMonth" IS NULL OR "mfgMonth" BETWEEN 1 AND 12),
  "mfgYear" integer,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  resolution text NOT NULL CHECK (resolution IN ('resolved', 'missing_article', 'missing_size')),
  "articleId" integer REFERENCES articles(id) ON DELETE RESTRICT,
  "skuId" integer REFERENCES article_sizes(id) ON DELETE RESTRICT,
  "locationId" integer NOT NULL REFERENCES locations(id),
  flag text,
  notes text,
  "userId" text REFERENCES "user"(id) ON DELETE SET NULL,
  "userName" text NOT NULL DEFAULT '',
  "deviceAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "voidedAt" timestamptz,
  "voidedBy" text REFERENCES "user"(id) ON DELETE SET NULL,
  "voidReason" text,
  "legacyScanId" integer,
  CONSTRAINT scan_events_client_event_unique UNIQUE ("clientEventId"),
  CONSTRAINT scan_events_scan_is_single CHECK ("entryType" = 'manual' OR quantity = 1),
  CONSTRAINT scan_events_scan_has_input CHECK ("entryType" = 'manual' OR "rawInput" IS NOT NULL),
  CONSTRAINT scan_events_resolved_has_sku CHECK (resolution <> 'resolved' OR ("skuId" IS NOT NULL AND "articleId" IS NOT NULL)),
  CONSTRAINT scan_events_void_complete CHECK ((status = 'voided') = ("voidedAt" IS NOT NULL))
);
-- One active scan per physical label (only formats that carry a unique id get a dedupeKey).
CREATE UNIQUE INDEX scan_events_active_label_unique ON scan_events (purpose, "dedupeKey") WHERE status = 'active' AND "dedupeKey" IS NOT NULL;
CREATE INDEX scan_events_user_recent_idx ON scan_events ("userId", "createdAt" DESC);
CREATE INDEX scan_events_recent_idx ON scan_events ("createdAt" DESC);
CREATE INDEX scan_events_unresolved_idx ON scan_events ("articleCode", "colourCode") WHERE resolution <> 'resolved' AND status = 'active';
CREATE INDEX scan_events_sku_idx ON scan_events ("skuId");
CREATE UNIQUE INDEX scan_events_legacy_unique ON scan_events ("legacyScanId", "rawInput") WHERE "legacyScanId" IS NOT NULL;

ALTER TABLE article_scan_links ADD CONSTRAINT article_scan_links_scan_event_fk FOREIGN KEY ("scanEventId") REFERENCES scan_events(id) ON DELETE SET NULL;

-- ── 6. Stock ledger ────────────────────────────────────────────────────────

CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  "skuId" integer NOT NULL REFERENCES article_sizes(id) ON DELETE RESTRICT,
  "locationId" integer NOT NULL REFERENCES locations(id),
  provenance text NOT NULL CHECK (provenance IN ('scanned', 'unscanned', 'carton')),
  quantity integer NOT NULL CHECK (quantity <> 0),
  "movementType" text NOT NULL CHECK ("movementType" IN (
    'stocktake_scan', 'stocktake_manual', 'legacy_import', 'adjustment', 'reversal',
    'transfer', 'provenance_transfer', 'receipt', 'dispatch', 'return')),
  "sourceType" text NOT NULL,
  "sourceId" text NOT NULL,
  "idempotencyKey" text NOT NULL,
  "reversalOfId" bigint REFERENCES stock_movements(id),
  "userId" text REFERENCES "user"(id) ON DELETE SET NULL,
  reason text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_idempotency_unique UNIQUE ("idempotencyKey"),
  CONSTRAINT stock_movements_reversal_once UNIQUE ("reversalOfId"),
  CONSTRAINT stock_movements_reversal_type CHECK (("movementType" = 'reversal') = ("reversalOfId" IS NOT NULL))
);
CREATE INDEX stock_movements_sku_idx ON stock_movements ("skuId", "createdAt");
CREATE INDEX stock_movements_source_idx ON stock_movements ("sourceType", "sourceId");
CREATE INDEX stock_movements_created_idx ON stock_movements ("createdAt" DESC);

CREATE TABLE stock_balances (
  "skuId" integer NOT NULL REFERENCES article_sizes(id) ON DELETE RESTRICT,
  "locationId" integer NOT NULL REFERENCES locations(id),
  provenance text NOT NULL CHECK (provenance IN ('scanned', 'unscanned', 'carton')),
  quantity integer NOT NULL DEFAULT 0,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("skuId", "locationId", provenance)
);
CREATE INDEX stock_balances_location_idx ON stock_balances ("locationId");

-- Balances change only through ledger inserts.
CREATE FUNCTION stock_movements_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('shayona.ledger', 'on', true);
  INSERT INTO stock_balances ("skuId", "locationId", provenance, quantity, "updatedAt")
  VALUES (NEW."skuId", NEW."locationId", NEW.provenance, NEW.quantity, now())
  ON CONFLICT ("skuId", "locationId", provenance)
  DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, "updatedAt" = now();
  PERFORM set_config('shayona.ledger', 'off', true);
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION stock_movements_apply();

CREATE FUNCTION stock_movements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;
  RAISE EXCEPTION 'stock_movements is append-only. Post a reversal or adjustment instead.';
END $$;
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION stock_movements_immutable();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION stock_movements_immutable();

CREATE FUNCTION stock_balances_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('shayona.ledger', true), '') <> 'on' THEN
    RAISE EXCEPTION 'stock_balances is maintained from stock_movements. Post a movement instead.';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER stock_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_balances FOR EACH ROW EXECUTE FUNCTION stock_balances_guard();

-- Rows where the stored balance disagrees with the ledger. Should always be empty.
CREATE VIEW stock_balance_mismatches AS
SELECT coalesce(l."skuId", b."skuId") AS "skuId",
       coalesce(l."locationId", b."locationId") AS "locationId",
       coalesce(l.provenance, b.provenance) AS provenance,
       coalesce(l.quantity, 0) AS ledger_quantity,
       coalesce(b.quantity, 0) AS balance_quantity
FROM (SELECT "skuId", "locationId", provenance, sum(quantity)::integer AS quantity FROM stock_movements GROUP BY 1, 2, 3) l
FULL JOIN stock_balances b USING ("skuId", "locationId", provenance)
WHERE coalesce(l.quantity, 0) <> coalesce(b.quantity, 0);

-- Rebuild every balance from the ledger (repair tool; normally never needed).
CREATE FUNCTION stock_balances_rebuild() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('shayona.ledger', 'on', true);
  DELETE FROM stock_balances;
  INSERT INTO stock_balances ("skuId", "locationId", provenance, quantity, "updatedAt")
  SELECT "skuId", "locationId", provenance, sum(quantity), now() FROM stock_movements GROUP BY 1, 2, 3;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('shayona.ledger', 'off', true);
  RETURN n;
END $$;

-- ── 7. Missing article review state ────────────────────────────────────────

CREATE TABLE missing_article_reviews (
  "articleCode" text NOT NULL,
  "colourCode" text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ignored')),
  note text NOT NULL DEFAULT '',
  "updatedBy" text REFERENCES "user"(id) ON DELETE SET NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("articleCode", "colourCode")
);

-- Master-data problems for the review screen. Read-only view; nothing is merged automatically.
CREATE VIEW article_quality_issues AS
SELECT a.id AS "articleId", 'missing_article_code'::text AS issue FROM articles a WHERE a.active AND btrim(a."artCode") = ''
UNION ALL
SELECT a.id, 'missing_colour_code' FROM articles a WHERE a.active AND btrim(a."artCode") <> '' AND btrim(a."colorCode") = ''
UNION ALL
SELECT a.id, 'missing_sizes' FROM articles a WHERE a.active AND NOT EXISTS (SELECT 1 FROM article_sizes s WHERE s."articleId" = a.id AND s.active)
UNION ALL
SELECT a.id, 'duplicate_name_colour' FROM articles a
JOIN (SELECT upper(btrim("artName")) n, upper(btrim(color)) c FROM articles WHERE active GROUP BY 1, 2 HAVING count(*) > 1) d
  ON d.n = upper(btrim(a."artName")) AND d.c = upper(btrim(a.color))
WHERE a.active
UNION ALL
SELECT a.id, 'code_has_several_names' FROM articles a
JOIN (SELECT upper(btrim("artCode")) code FROM articles WHERE active AND btrim("artCode") <> '' GROUP BY 1 HAVING count(DISTINCT upper(btrim("artName"))) > 1) d
  ON d.code = upper(btrim(a."artCode"))
WHERE a.active;

-- ── 8. Legacy scans ────────────────────────────────────────────────────────

ALTER TABLE scans RENAME TO legacy_scans;
ALTER TABLE legacy_scans RENAME CONSTRAINT scans_pkey TO legacy_scans_pkey;
COMMENT ON TABLE legacy_scans IS 'Read-only. Merged scan rows from the old scanner (before 0002). Imported into scan_events by scripts/db/import-legacy-scans.ts.';
