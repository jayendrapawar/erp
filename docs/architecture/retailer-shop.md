# Retailer shop (started 21 Nov 2026)

Retailers sign in at `/shop`, see article photos with the latest MRP and place orders that arrive in
Orders as "to confirm". Owner decisions are kept in this file as the shop is built.

## Owner decisions

- A section of this app (same database), not a separate app.
- Sign-in: phone + PIN set by staff in Master → Retailers (no SMS).
- The shop shows photo per article colour and the **latest** MRP only (no stock, no discounted rate).
- Only article colours with at least one photo are listed.
- Quantities: pairs per size, a Master set, or a carton (assortment).
- Retailer orders need staff approval before picking.

## Step 1 — photos (migration 0013)

- `article_photos`: one row per photo of an article colour (`articles` row). The image is in
  **Vercel Blob** (public store); only its link is stored. Lowest `sortOrder` = main photo.
- Master → Articles → **Photos**: photos are shrunk in the browser (longest side 1000 px, WebP or
  JPEG, about 100 KB) and uploaded straight to Blob through `/api/article-photos/upload`, which only
  hands out a short-lived upload token (articles.edit, path `articles/<id>/…`, WebP/JPEG, ≤ 2 MB).
  The link is then saved by `addArticlePhoto`. Make main / delete (the Blob file is removed too).
- Vercel Blob Hobby limits (checked 21 Nov 2026): 1 GB storage, 10 GB transfer and 2,000 uploads a
  month; going over blocks the store for 30 days. So: one file per photo (no thumbnail), uploads stop
  at 1,800 a month (counted from `article_photo.added` audit rows, index
  `audit_events_action_time_idx`), files cached for a year (links never change).
- Queries: photo counts 1; open photos 2 (parallel); add photo 1 transaction; make main 1 + audit;
  delete 1 transaction. Every change invalidates the cached shop catalogue (`lib/shop/cache.ts`).
- Setup: Vercel dashboard → Storage → Create → Blob (public) → connect to the project; this adds
  `BLOB_READ_WRITE_TOKEN`. Local development needs the same variable in `.env.local`. Without it the
  Photos dialog says the store is not connected.
