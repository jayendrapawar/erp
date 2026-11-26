-- Rollback of 0021_stocktake_sessions.sql. Refuses once stocktake cartons exist (their stock would
-- lose its source). Sessions and racks are dropped; scans keep their flag (rack name).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM carton_receipts WHERE match = 'stocktake')
     OR EXISTS (SELECT 1 FROM stock_movements WHERE "movementType" = 'stocktake_carton') THEN
    RAISE EXCEPTION 'Stocktake cartons exist; rollback would lose them.';
  END IF;
END $$;

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movementType_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movementType_check CHECK ("movementType" IN (
  'stocktake_scan', 'stocktake_manual', 'legacy_import', 'adjustment', 'reversal',
  'transfer', 'provenance_transfer', 'receipt', 'dispatch', 'return'));
DROP INDEX IF EXISTS carton_receipts_stocktake_user_idx;
DROP INDEX IF EXISTS carton_receipts_session_idx;
ALTER TABLE carton_receipts DROP COLUMN "sessionId";
ALTER TABLE carton_receipts DROP COLUMN flag;
ALTER TABLE carton_receipts DROP CONSTRAINT carton_receipts_match_check;
ALTER TABLE carton_receipts ADD CONSTRAINT carton_receipts_match_check CHECK (match IN ('matched', 'unexpected'));

DROP INDEX IF EXISTS scan_events_session_idx;
ALTER TABLE scan_events DROP COLUMN "sessionId";
DROP TABLE stocktake_sessions;
DROP TABLE racks;
