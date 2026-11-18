-- detect: select to_regclass('article_mrps') is not null and to_regclass('article_scan_links') is not null and not exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'articles' and column_name = 'createdAt') as present
-- requires-backup
--
-- Feature 01 (new article detection and creation). Consolidates the hand-applied
-- legacy files 0011–0014. The development database already has these changes;
-- production (checked 18 Nov 2026) does not.
--
-- Precondition: no two articles may share the same normalised article code + colour
-- code, or the unique index below cannot be built. Production currently has 83 such
-- groups (193 rows). Review and merge them with db/manual/cleanup_article_code_color_duplicates.sql
-- first; this migration stops with a clear message instead of guessing which row wins.

DO $$
DECLARE dup_groups integer;
BEGIN
  SELECT count(*) INTO dup_groups FROM (
    SELECT 1 FROM articles
    WHERE btrim("artCode") <> '' AND btrim("colorCode") <> ''
    GROUP BY upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')), upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g'))
    HAVING count(*) > 1
  ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION 'articles has % duplicate article code + colour code groups. Run the reviewed duplicate cleanup before this migration.', dup_groups;
  END IF;
END $$;

-- 0011: article timestamps were dropped by Feature 01 (history now lives in audit_events, added in 0002).
ALTER TABLE articles DROP COLUMN IF EXISTS "createdAt", DROP COLUMN IF EXISTS "updatedAt";

-- 0012: MRP history per normalised article code, seeded from existing scans.
CREATE TABLE IF NOT EXISTS article_mrps (
  id serial PRIMARY KEY,
  "artCode" text NOT NULL,
  mrp numeric(10, 2) NOT NULL,
  CONSTRAINT "article_mrps_artCode_normalized_check" CHECK ("artCode" = upper(btrim("artCode"))),
  CONSTRAINT "article_mrps_artCode_mrp_unique" UNIQUE ("artCode", mrp)
);

INSERT INTO article_mrps ("artCode", mrp)
SELECT DISTINCT upper(regexp_replace(btrim(s."artNumber"), '\s+', ' ', 'g')), s.mrp::numeric(10, 2)
FROM scans s
WHERE nullif(btrim(s."artNumber"), '') IS NOT NULL
  AND s.mrp IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM articles a
    WHERE upper(regexp_replace(btrim(a."artCode"), '\s+', ' ', 'g')) = upper(regexp_replace(btrim(s."artNumber"), '\s+', ' ', 'g'))
  )
ON CONFLICT ("artCode", mrp) DO NOTHING;

-- 0013: one article row per code + colour code.
CREATE UNIQUE INDEX IF NOT EXISTS "articles_artCode_colorCode_unique" ON articles (
  upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')),
  upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g'))
) WHERE btrim("artCode") <> '' AND btrim("colorCode") <> '';

-- 0014: which scan created or linked an article.
CREATE TABLE IF NOT EXISTS article_scan_links (
  id serial PRIMARY KEY,
  "articleId" integer NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('created', 'linked')),
  "rawQr" text NOT NULL,
  "userName" text NOT NULL DEFAULT '',
  "createdAt" timestamp NOT NULL DEFAULT now()
);
