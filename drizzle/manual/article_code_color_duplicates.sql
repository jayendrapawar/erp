-- Read-only report of duplicate article/color code groups.
-- Uses the same normalization and nonblank predicate as migration 0013.
SELECT
  upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')) AS "normalizedArtCode",
  upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g')) AS "normalizedColorCode",
  count(*) AS "rowCount",
  array_agg("id" ORDER BY "id") AS "articleIds"
FROM "articles"
WHERE btrim("artCode") <> ''
  AND btrim("colorCode") <> ''
GROUP BY
  upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')),
  upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g'))
HAVING count(*) > 1
ORDER BY "normalizedArtCode", "normalizedColorCode";
