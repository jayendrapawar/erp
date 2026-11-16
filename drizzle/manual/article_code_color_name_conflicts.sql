-- Read-only report of duplicate article/color code groups with differing normalized names.
SELECT
  upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')) AS "normalizedArtCode",
  upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g')) AS "normalizedColorCode",
  count(*) AS "rowCount",
  count(DISTINCT lower(regexp_replace(btrim("artName"), '\s+', ' ', 'g'))) AS "normalizedNameCount",
  array_agg(DISTINCT lower(regexp_replace(btrim("artName"), '\s+', ' ', 'g')) ORDER BY lower(regexp_replace(btrim("artName"), '\s+', ' ', 'g'))) AS "normalizedNames",
  array_agg("id" ORDER BY "id") AS "articleIds"
FROM "articles"
WHERE btrim("artCode") <> ''
  AND btrim("colorCode") <> ''
GROUP BY
  upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')),
  upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g'))
HAVING count(*) > 1
  AND count(DISTINCT lower(regexp_replace(btrim("artName"), '\s+', ' ', 'g'))) > 1
ORDER BY "normalizedArtCode", "normalizedColorCode";
