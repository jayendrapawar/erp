CREATE TABLE "article_mrps" (
  "id" serial PRIMARY KEY,
  "artCode" text NOT NULL,
  "mrp" numeric(10, 2) NOT NULL,
  CONSTRAINT "article_mrps_artCode_normalized_check"
    CHECK ("artCode" = upper(btrim("artCode"))),
  CONSTRAINT "article_mrps_artCode_mrp_unique" UNIQUE ("artCode", "mrp")
);

INSERT INTO "article_mrps" ("artCode", "mrp")
SELECT DISTINCT
  upper(regexp_replace(btrim(s."artNumber"), '\s+', ' ', 'g')),
  s."mrp"::numeric(10, 2)
FROM "scans" AS s
WHERE nullif(btrim(s."artNumber"), '') IS NOT NULL
  AND s."mrp" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "articles" AS a
    WHERE upper(regexp_replace(btrim(a."artCode"), '\s+', ' ', 'g'))
      = upper(regexp_replace(btrim(s."artNumber"), '\s+', ' ', 'g'))
  )
ON CONFLICT ("artCode", "mrp") DO NOTHING;
