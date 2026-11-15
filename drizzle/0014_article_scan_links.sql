CREATE TABLE "article_scan_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "articleId" integer NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
  "action" text NOT NULL CHECK ("action" IN ('created', 'linked')),
  "rawQr" text NOT NULL,
  "userName" text NOT NULL DEFAULT '',
  "createdAt" timestamp NOT NULL DEFAULT now()
);
