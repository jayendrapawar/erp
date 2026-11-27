-- Archive for article rows changed by scripts/release/prepare-article-duplicates.ts.
--
-- On production the release script creates this table itself (it runs BEFORE 0001, whose
-- unique index needs the duplicates resolved), so this migration is a no-op there. It exists so
-- every environment ends up with the same schema.
--
-- Rollback: DROP TABLE article_duplicate_archive (only if it is empty or exported first).

CREATE TABLE IF NOT EXISTS article_duplicate_archive (
  id               serial PRIMARY KEY,
  "articleId"      integer NOT NULL,
  action           text NOT NULL CHECK (action IN ('merged', 'codes_cleared')),
  "keptArticleId"  integer,
  "row"            jsonb NOT NULL,
  sizes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  colours          jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason           text NOT NULL,
  "archivedBy"     text NOT NULL DEFAULT '',
  "archivedAt"     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE article_duplicate_archive IS 'Full copies of article rows removed or re-coded while resolving duplicate article code + colour code groups. Never edited.';
