-- detect: select exists (select 1 from information_schema.columns where table_name = 'carton_assortments' and column_name = 'onlyFor') as present
--
-- "Only for" assortments (owner, 20 Nov 2026). Some assortments apply only to certain articles
-- (Bahamas sheet: Gents 42 pairs 608 … "Hawaii only: HC003G, TR002G, SUP001G, ORTH01G, ORTH02G").
-- "onlyFor" = those article codes, sorted, comma-separated; '' = any article (as before).
-- An assortment is chosen automatically only for an article it covers; for another article with
-- the same pairs the user is asked: use it for this article too (its code is added), or enter a
-- new assortment. Two active assortments may share division + segment + pairs + code when their
-- "onlyFor" differs, so the unique keys include it.
--
-- Rollback: drop the two new indexes, recreate the 0005 ones (only if no two active rows share
-- division + segment + packing + code), ALTER TABLE carton_assortments DROP COLUMN "onlyFor".

ALTER TABLE carton_assortments ADD COLUMN "onlyFor" text NOT NULL DEFAULT '';

DROP INDEX carton_assortments_active_key;
DROP INDEX carton_assortments_version_key;
CREATE UNIQUE INDEX carton_assortments_active_key ON carton_assortments (division, segment, packing, code, "onlyFor") WHERE active;
CREATE UNIQUE INDEX carton_assortments_version_key ON carton_assortments (division, segment, packing, code, "onlyFor", version);
