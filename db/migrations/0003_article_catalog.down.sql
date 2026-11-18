-- Manual rollback for 0003_article_catalog.sql. Not run by the migration runner.
--
-- Run only after restoring the pre-import backup, or after accepting that:
--  - variants retired by the import stay retired (active = false) — re-activate them first
--    from catalog_source_rows / audit_events if the old catalogue must be visible again;
--  - import batches, source rows and review items are dropped.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -1 -f db/migrations/0003_article_catalog.down.sql

UPDATE articles SET "reviewStatus" = 'unverified' WHERE "reviewStatus" = 'needs_review';
ALTER TABLE articles DROP CONSTRAINT "articles_reviewStatus_check";
ALTER TABLE articles ADD CONSTRAINT "articles_reviewStatus_check" CHECK ("reviewStatus" IN ('unverified', 'approved'));

DROP TABLE catalog_review_items;
DROP TABLE catalog_source_rows;
DROP TABLE article_size_ranges;
DROP TABLE catalog_import_batches;

ALTER TABLE articles DROP COLUMN "retiredReason", DROP COLUMN "retiredAt", DROP COLUMN "catalogArticleId";
DROP TABLE catalog_articles;

DELETE FROM schema_migrations WHERE version = '0003';
