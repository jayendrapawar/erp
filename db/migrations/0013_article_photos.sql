-- detect: select to_regclass('public.article_photos') is not null as present
--
-- Article photos for the retailer shop (owner, 21 Nov 2026). One row per photo of an article colour
-- (articles row = article code + colour code). The photo file lives in Vercel Blob (public store);
-- only its link is kept here, never the image. sortOrder 0 = main photo shown in the shop list.
-- The shop lists only article colours that have at least one photo.
--
-- Rollback: DROP TABLE article_photos; (the Blob files stay and can be removed from the Vercel
-- dashboard).

CREATE TABLE article_photos (
  id            serial PRIMARY KEY,
  "articleId"   integer NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  url           text NOT NULL,
  "pathname"    text NOT NULL,
  width         integer,
  height        integer,
  bytes         integer,
  "sortOrder"   integer NOT NULL DEFAULT 0,
  "createdBy"   text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT article_photos_url_unique UNIQUE (url)
);

CREATE INDEX article_photos_article_idx ON article_photos ("articleId", "sortOrder");

-- Uploads this month are counted from the audit rows (they stay when a photo is deleted), so
-- uploads can stop before Vercel Blob's monthly limit. Index for that count (and any audit lookup
-- by action + time). Rollback: DROP INDEX audit_events_action_time_idx;
CREATE INDEX audit_events_action_time_idx ON audit_events (action, "occurredAt");
