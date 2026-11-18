-- detect: select to_regclass('catalog_articles') is not null as present
-- requires-backup
--
-- Article catalogue structure (see docs/architecture/article-catalogue.md).
--
-- Additive only: no table, column or row is dropped or deleted.
--
--   Article  catalog_articles      one row per manufacturer article code (SS0702B). artName is
--                                  its display / family name ("SS-702") and may cover several codes.
--   Variant  articles (existing)   article code + colour code. Ids are unchanged; scans, SKUs and
--                                  the stock ledger keep pointing at them.
--   SKU      article_sizes         variant + size (unchanged).
--
--   article_size_ranges   the size ranges a variant was supplied with (kids 11–13, 1, 2–5 …),
--                         kept as given next to the expanded SKUs.
--   catalog_import_batches / catalog_source_rows
--                         every imported workbook row, verbatim, with what it became.
--   catalog_review_items  conflicts the import found and will not guess about (colour-name
--                         conflicts, overlapping ranges, retired variants that hold stock …).
--
-- articles also gets: catalogArticleId, retiredAt / retiredReason (variants absent from the
-- approved catalogue are retired = inactive, never deleted) and reviewStatus 'needs_review'.
--
-- Rollback: 0003_article_catalog.down.sql.

-- ── 1. Article (code level) ─────────────────────────────────────────────────

CREATE TABLE catalog_articles (
  id              serial PRIMARY KEY,
  "artCode"       text NOT NULL,
  "artName"       text NOT NULL,
  brand           text,
  "segmentHint"   text,
  active          boolean NOT NULL DEFAULT true,
  "reviewStatus"  text NOT NULL DEFAULT 'unverified' CHECK ("reviewStatus" IN ('unverified', 'approved', 'needs_review')),
  source          text NOT NULL DEFAULT 'import' CHECK (source IN ('legacy', 'import', 'manual', 'scan_dialog')),
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_articles_code_normalised CHECK ("artCode" = upper(btrim("artCode")) AND "artCode" <> ''),
  CONSTRAINT catalog_articles_code_unique UNIQUE ("artCode")
);
CREATE INDEX catalog_articles_name_idx ON catalog_articles (upper("artName"));
COMMENT ON TABLE catalog_articles IS 'Manufacturer article codes. articles (variants) reference this through catalogArticleId.';

-- ── 2. Variants (existing articles table) ───────────────────────────────────

ALTER TABLE articles
  ADD COLUMN "catalogArticleId" integer REFERENCES catalog_articles(id) ON DELETE RESTRICT,
  ADD COLUMN "retiredAt" timestamptz,
  ADD COLUMN "retiredReason" text;
CREATE INDEX articles_catalog_article_idx ON articles ("catalogArticleId");

ALTER TABLE articles DROP CONSTRAINT "articles_reviewStatus_check";
ALTER TABLE articles ADD CONSTRAINT "articles_reviewStatus_check"
  CHECK ("reviewStatus" IN ('unverified', 'approved', 'needs_review'));

COMMENT ON TABLE articles IS 'Article VARIANTS: one row per article code + colour code. Never deleted once referenced; retired variants have active = false.';

-- ── 3. Size ranges as supplied ──────────────────────────────────────────────

CREATE TABLE article_size_ranges (
  id               serial PRIMARY KEY,
  "articleId"      integer NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  "minSize"        text NOT NULL,
  "maxSize"        text NOT NULL,
  sizes            text[] NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  "sourceBatchId"  integer,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT article_size_ranges_unique UNIQUE ("articleId", "minSize", "maxSize"),
  CONSTRAINT article_size_ranges_sizes_present CHECK (cardinality(sizes) > 0)
);

-- ── 4. Import traceability ──────────────────────────────────────────────────

CREATE TABLE catalog_import_batches (
  id               serial PRIMARY KEY,
  source           text NOT NULL,
  "fileName"       text NOT NULL,
  "fileSha256"     text NOT NULL,
  "sheetName"      text NOT NULL,
  "rowCount"       integer NOT NULL,
  "appliedBy"      text REFERENCES "user"(id) ON DELETE SET NULL,
  "appliedByName"  text NOT NULL DEFAULT '',
  "appliedAt"      timestamptz NOT NULL DEFAULT now(),
  summary          jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE article_size_ranges
  ADD CONSTRAINT article_size_ranges_batch_fkey FOREIGN KEY ("sourceBatchId") REFERENCES catalog_import_batches(id) ON DELETE SET NULL;

CREATE TABLE catalog_source_rows (
  id           bigserial PRIMARY KEY,
  "batchId"    integer NOT NULL REFERENCES catalog_import_batches(id) ON DELETE CASCADE,
  "rowNumber"  integer NOT NULL,
  raw          jsonb NOT NULL,
  "artName"    text NOT NULL DEFAULT '',
  "artCode"    text NOT NULL DEFAULT '',
  color        text NOT NULL DEFAULT '',
  "colorCode"  text NOT NULL DEFAULT '',
  "minSize"    text NOT NULL DEFAULT '',
  "maxSize"    text NOT NULL DEFAULT '',
  "articleId"  integer REFERENCES articles(id) ON DELETE SET NULL,
  outcome      text NOT NULL CHECK (outcome IN ('used', 'duplicate', 'rejected')),
  CONSTRAINT catalog_source_rows_unique UNIQUE ("batchId", "rowNumber")
);
CREATE INDEX catalog_source_rows_article_idx ON catalog_source_rows ("articleId");

-- ── 5. Review queue ─────────────────────────────────────────────────────────

CREATE TABLE catalog_review_items (
  id              serial PRIMARY KEY,
  kind            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('info', 'review', 'error')),
  "subjectKey"    text NOT NULL,
  "artCode"       text NOT NULL DEFAULT '',
  "colorCode"     text,
  "articleId"     integer REFERENCES articles(id) ON DELETE SET NULL,
  message         text NOT NULL,
  details         jsonb,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  "firstBatchId"  integer REFERENCES catalog_import_batches(id) ON DELETE SET NULL,
  "lastBatchId"   integer REFERENCES catalog_import_batches(id) ON DELETE SET NULL,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "resolvedAt"    timestamptz,
  "resolvedBy"    text REFERENCES "user"(id) ON DELETE SET NULL,
  resolution      text,
  CONSTRAINT catalog_review_items_subject_unique UNIQUE (kind, "subjectKey")
);
CREATE INDEX catalog_review_items_open_idx ON catalog_review_items (status, severity) WHERE status = 'open';
