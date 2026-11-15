CREATE UNIQUE INDEX "articles_artCode_colorCode_unique"
  ON "articles" (
    upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')),
    upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g'))
  )
  WHERE btrim("artCode") <> ''
    AND btrim("colorCode") <> '';
