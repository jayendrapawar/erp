-- Rollback of 0022_godown_stocktake.sql: back to one open count per rack. Refuses while a stocktake
-- without a rack exists (it cannot be given one afterwards).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM stocktake_sessions WHERE "rackId" IS NULL) THEN
    RAISE EXCEPTION 'Godown stocktakes without a rack exist; rollback would lose them.';
  END IF;
END $$;

DROP INDEX stocktake_sessions_one_open;
CREATE UNIQUE INDEX stocktake_sessions_one_open ON stocktake_sessions ("rackId") WHERE status = 'open';
ALTER TABLE stocktake_sessions ALTER COLUMN "rackId" SET NOT NULL;
