-- detect: select to_regclass('public.stocktake_sessions') is not null as present
--
-- Warehouse Scanner rework (owner, 26 Nov 2026): racks, stocktake sessions, sealed cartons.
--
-- racks                A fixed list of racks / areas, kept by admin and supervisor (replaces the
--                      free-text scanner flags). Filled once from the existing flag names.
-- stocktake_sessions   One count of one rack: started, scanned by one or more people, finished.
--                      At most one open session per rack. Scans saved offline while a session was
--                      open still join it when they sync (a box that was really scanned is never lost).
-- scan_events          + "sessionId". "flag" keeps the rack name, so exports and reports stay the same.
-- carton_receipts      + match 'stocktake' (a sealed carton counted in the scanner, no bill),
--                      + "sessionId", + flag (rack name). The one-active-row-per-label index means a
--                      carton counted at stocktake cannot also be received on a bill, and the reverse.
-- stock_movements      + movement type 'stocktake_carton' (Inventory shows it with scans).
--
-- New tables, three nullable columns, two widened CHECKs, indexes. No existing row changes
-- (except the one-off copy of flag names into racks). Rollback: 0021_stocktake_sessions.down.sql.

CREATE TABLE racks (
  id           serial PRIMARY KEY,
  name         text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 50),
  active       boolean NOT NULL DEFAULT true,
  "sortOrder"  integer NOT NULL DEFAULT 0,
  "createdBy"  text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX racks_name_key ON racks (lower(btrim(name)));

INSERT INTO racks (name, "sortOrder")
SELECT f.name, row_number() OVER (ORDER BY f.first)::int
  FROM (SELECT min(btrim(name)) AS name, min("createdAt") AS first FROM flags
         WHERE btrim(name) <> '' AND length(btrim(name)) <= 50 GROUP BY lower(btrim(name))) f
ON CONFLICT DO NOTHING;

CREATE TABLE stocktake_sessions (
  id                serial PRIMARY KEY,
  "rackId"          integer NOT NULL REFERENCES racks(id),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished')),
  "startedBy"       text REFERENCES "user"(id) ON DELETE SET NULL,
  "startedByName"   text NOT NULL DEFAULT '',
  "startedAt"       timestamptz NOT NULL DEFAULT now(),
  "finishedAt"      timestamptz,
  "finishedBy"      text REFERENCES "user"(id) ON DELETE SET NULL,
  "finishedByName"  text,
  note              text NOT NULL DEFAULT '',
  CONSTRAINT stocktake_sessions_finish_check CHECK ((status = 'finished') = ("finishedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX stocktake_sessions_one_open ON stocktake_sessions ("rackId") WHERE status = 'open';
CREATE INDEX stocktake_sessions_recent_idx ON stocktake_sessions (id DESC);

ALTER TABLE scan_events ADD COLUMN "sessionId" integer REFERENCES stocktake_sessions(id);
CREATE INDEX scan_events_session_idx ON scan_events ("sessionId") WHERE "sessionId" IS NOT NULL;

-- Sealed cartons counted at stocktake.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'carton_receipts'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%match%' AND pg_get_constraintdef(oid) LIKE '%unexpected%'
              AND pg_get_constraintdef(oid) NOT LIKE '%billLineId%'
  LOOP EXECUTE format('ALTER TABLE carton_receipts DROP CONSTRAINT %I', c); END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%movementType%' AND pg_get_constraintdef(oid) LIKE '%stocktake_scan%'
  LOOP EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', c); END LOOP;
END $$;

ALTER TABLE carton_receipts ADD CONSTRAINT carton_receipts_match_check
  CHECK (match IN ('matched', 'unexpected', 'stocktake'));
ALTER TABLE carton_receipts ADD COLUMN flag text;
ALTER TABLE carton_receipts ADD COLUMN "sessionId" integer REFERENCES stocktake_sessions(id);
CREATE INDEX carton_receipts_session_idx ON carton_receipts ("sessionId") WHERE "sessionId" IS NOT NULL;
CREATE INDEX carton_receipts_stocktake_user_idx ON carton_receipts ("userId", id DESC) WHERE match = 'stocktake';

ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movementType_check CHECK ("movementType" IN (
  'stocktake_scan', 'stocktake_manual', 'stocktake_carton', 'legacy_import', 'adjustment', 'reversal',
  'transfer', 'provenance_transfer', 'receipt', 'dispatch', 'return'));
