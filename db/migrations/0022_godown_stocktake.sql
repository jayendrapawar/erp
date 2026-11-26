-- detect: select exists (select 1 from information_schema.columns where table_name = 'stocktake_sessions' and column_name = 'rackId' and is_nullable = 'YES') as present
--
-- One godown stocktake (owner, 26 Nov 2026). The godown has no fixed areas: loose pairs, open
-- cartons and sealed cartons are mixed. So a stocktake is no longer per rack: there is ONE open
-- stocktake that everyone scanning joins; it starts by itself when none is open and an admin or
-- supervisor finishes it. A rack / area is optional, per scan (scan_events.flag / carton_receipts.flag).
--
-- stocktake_sessions."rackId"   nullable (new stocktakes have none; old per-rack counts keep theirs).
-- one open stocktake            unique index on status where open (was: one open per rack).
-- Old per-rack counts still open are finished here (on development: one empty test count).
--
-- Rollback: 0022_godown_stocktake.down.sql (only while every stocktake has a rack).

ALTER TABLE stocktake_sessions ALTER COLUMN "rackId" DROP NOT NULL;
DROP INDEX stocktake_sessions_one_open;

UPDATE stocktake_sessions
   SET status = 'finished', "finishedAt" = now(), "finishedByName" = 'System (one godown stocktake)',
       note = CASE WHEN note = '' THEN 'Finished when counts per rack were replaced by one godown stocktake.' ELSE note END
 WHERE status = 'open';

CREATE UNIQUE INDEX stocktake_sessions_one_open ON stocktake_sessions (status) WHERE status = 'open';
