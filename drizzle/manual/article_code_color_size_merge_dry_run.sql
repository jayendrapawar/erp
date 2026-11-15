-- Read-only preview of size labels each eligible group would retain after merging.
WITH normalized_articles AS (
  SELECT
    "id",
    upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')) AS "normalizedArtCode",
    upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g')) AS "normalizedColorCode",
    lower(regexp_replace(btrim("artName"), '\s+', ' ', 'g')) AS "normalizedArtName"
  FROM "articles"
  WHERE btrim("artCode") <> ''
    AND btrim("colorCode") <> ''
), eligible_groups AS (
  SELECT
    "normalizedArtCode",
    "normalizedColorCode",
    min("normalizedArtName") AS "normalizedArtName",
    min("id") AS "keptArticleId"
  FROM normalized_articles
  GROUP BY "normalizedArtCode", "normalizedColorCode"
  HAVING count(*) > 1
    AND count(DISTINCT "normalizedArtName") = 1
), merged_labels AS (
  SELECT DISTINCT
    groups."normalizedArtCode",
    groups."normalizedColorCode",
    groups."normalizedArtName",
    groups."keptArticleId",
    sizes."sizeLabel"
  FROM eligible_groups AS groups
  JOIN normalized_articles AS a
    ON a."normalizedArtCode" = groups."normalizedArtCode"
   AND a."normalizedColorCode" = groups."normalizedColorCode"
   AND a."normalizedArtName" = groups."normalizedArtName"
  LEFT JOIN "article_sizes" AS sizes ON sizes."articleId" = a."id"
)
SELECT
  labels."normalizedArtCode",
  labels."normalizedColorCode",
  labels."normalizedArtName",
  labels."keptArticleId",
  COALESCE(array_agg(
    labels."sizeLabel"
    ORDER BY
      CASE WHEN labels."sizeLabel" ~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN 0 ELSE 1 END,
      CASE WHEN labels."sizeLabel" ~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN labels."sizeLabel"::numeric END,
      labels."sizeLabel"
  ) FILTER (WHERE labels."sizeLabel" IS NOT NULL), ARRAY[]::text[]) AS "sizesAfterMerge"
FROM merged_labels AS labels
GROUP BY
  labels."normalizedArtCode",
  labels."normalizedColorCode",
  labels."normalizedArtName",
  labels."keptArticleId"
ORDER BY labels."normalizedArtCode", labels."normalizedColorCode", labels."keptArticleId";
