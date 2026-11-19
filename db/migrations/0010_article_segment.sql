-- detect: select exists (select 1 from information_schema.columns where table_name = 'articles' and column_name = 'segment') as present
--
-- Segment per article colour (owner, 20 Nov 2026): Gents, Ladies, Kids or Baby, from the Segment
-- column of the article list (Master → Articles upload / edit). Used to pick the carton assortment
-- (division + segment + pairs per carton + size range) when several fit. Never derived from the code.
--
-- One nullable column; no data change, no lock beyond a moment. Rollback: ALTER TABLE articles DROP COLUMN segment.

ALTER TABLE articles ADD COLUMN segment text;
