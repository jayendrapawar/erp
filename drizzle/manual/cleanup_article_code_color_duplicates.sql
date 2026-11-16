-- Merge duplicate article/color rows whose normalized article names agree.
-- Review the saved rows and results, then change ROLLBACK; to COMMIT; after review.
BEGIN;

CREATE TABLE IF NOT EXISTS "article_duplicate_review" AS
SELECT
  a.*,
  NULL::integer AS "keptArticleId",
  NULL::timestamp AS "reviewSavedAt"
FROM "articles" AS a
WITH NO DATA;

CREATE TEMP TABLE _article_merge_groups ON COMMIT DROP AS
WITH normalized_articles AS (
  SELECT
    "id",
    upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')) AS "normalizedArtCode",
    upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g')) AS "normalizedColorCode",
    lower(regexp_replace(btrim("artName"), '\s+', ' ', 'g')) AS "normalizedArtName"
  FROM "articles"
  WHERE btrim("artCode") <> ''
    AND btrim("colorCode") <> ''
)
SELECT
  "normalizedArtCode",
  "normalizedColorCode",
  min("normalizedArtName") AS "normalizedArtName",
  min("id") AS "keptArticleId"
FROM normalized_articles
GROUP BY "normalizedArtCode", "normalizedColorCode"
HAVING count(*) > 1
  AND count(DISTINCT "normalizedArtName") = 1;

CREATE TEMP TABLE _article_merge_rows ON COMMIT DROP AS
SELECT
  a."id",
  groups."keptArticleId"
FROM "articles" AS a
JOIN _article_merge_groups AS groups
  ON upper(regexp_replace(btrim(a."artCode"), '\s+', ' ', 'g')) = groups."normalizedArtCode"
 AND upper(regexp_replace(btrim(a."colorCode"), '\s+', ' ', 'g')) = groups."normalizedColorCode"
 AND lower(regexp_replace(btrim(a."artName"), '\s+', ' ', 'g')) = groups."normalizedArtName";

-- Add each distinct label from all rows to the kept article, including its existing labels.
INSERT INTO "article_sizes" ("articleId", "sizeLabel", "sortOrder")
SELECT DISTINCT
  rows."keptArticleId",
  sizes."sizeLabel",
  0
FROM _article_merge_rows AS rows
JOIN "article_sizes" AS sizes ON sizes."articleId" = rows."id"
WHERE NOT EXISTS (
  SELECT 1
  FROM "article_sizes" AS existing
  WHERE existing."articleId" = rows."keptArticleId"
    AND existing."sizeLabel" = sizes."sizeLabel"
);

-- Give the kept row the numeric bounds found in either size field across its group.
WITH bounds AS (
  SELECT
    rows."keptArticleId",
    min(btrim(value)::numeric) AS "minValue",
    max(btrim(value)::numeric) AS "maxValue"
  FROM _article_merge_rows AS rows
  JOIN "articles" AS a ON a."id" = rows."id"
  CROSS JOIN LATERAL (VALUES (a."minSize"), (a."maxSize")) AS field(value)
  WHERE btrim(field.value) ~ '^[+-]?[0-9]+([.][0-9]+)?$'
  GROUP BY rows."keptArticleId"
)
UPDATE "articles" AS kept
SET
  "minSize" = bounds."minValue"::text,
  "maxSize" = bounds."maxValue"::text
FROM bounds
WHERE kept."id" = bounds."keptArticleId";

-- Renumber all distinct retained size labels; numeric labels sort ascending first.
WITH deduplicated_sizes AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "articleId", "sizeLabel"
      ORDER BY "id"
    ) AS duplicate_number
  FROM "article_sizes"
  WHERE "articleId" IN (SELECT DISTINCT "keptArticleId" FROM _article_merge_rows)
)
DELETE FROM "article_sizes" AS sizes
USING deduplicated_sizes AS duplicates
WHERE sizes."id" = duplicates."id"
  AND duplicates.duplicate_number > 1;

WITH ranked_sizes AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "articleId"
      ORDER BY
        CASE WHEN "sizeLabel" ~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN 0 ELSE 1 END,
        CASE WHEN "sizeLabel" ~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN "sizeLabel"::numeric END,
        "sizeLabel",
        "id"
    ) AS new_order
  FROM "article_sizes"
  WHERE "articleId" IN (SELECT DISTINCT "keptArticleId" FROM _article_merge_rows)
)
UPDATE "article_sizes" AS sizes
SET "sortOrder" = ranked.new_order
FROM ranked_sizes AS ranked
WHERE sizes."id" = ranked."id";

-- Save each non-kept source row before deleting it.
INSERT INTO "article_duplicate_review"
SELECT
  duplicates.*,
  now()
FROM (
  SELECT a.*, rows."keptArticleId"
  FROM _article_merge_rows AS rows
  JOIN "articles" AS a ON a."id" = rows."id"
  WHERE rows."id" <> rows."keptArticleId"
) AS duplicates;

DELETE FROM "articles" AS a
USING _article_merge_rows AS rows
WHERE a."id" = rows."id"
  AND rows."id" <> rows."keptArticleId";

-- Read-only preview of the merged articles and their resulting size labels.
SELECT
  kept."id" AS "keptArticleId",
  kept."artCode",
  kept."colorCode",
  kept."artName",
  kept."minSize",
  kept."maxSize",
  COALESCE(
    array_agg(sizes."sizeLabel" ORDER BY sizes."sortOrder", sizes."sizeLabel")
      FILTER (WHERE sizes."id" IS NOT NULL),
    ARRAY[]::text[]
  ) AS "remainingSizes"
FROM "articles" AS kept
JOIN (SELECT DISTINCT "keptArticleId" FROM _article_merge_rows) AS groups
  ON groups."keptArticleId" = kept."id"
LEFT JOIN "article_sizes" AS sizes ON sizes."articleId" = kept."id"
GROUP BY kept."id", kept."artCode", kept."colorCode", kept."artName", kept."minSize", kept."maxSize"
ORDER BY kept."id";

-- Change this to COMMIT; only after reviewing the saved rows and preview.
COMMIT;
