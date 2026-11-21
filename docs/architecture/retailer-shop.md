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
- Setup (done 21 Nov 2026): Vercel Blob store connected to the project. On Vercel the app uses OIDC
  (`BLOB_STORE_ID`; no long-lived secret). Locally `.env.local` holds `BLOB_READ_WRITE_TOKEN`;
  `lib/photos/store.ts` passes it explicitly, because the library otherwise tries OIDC first and
  fails in development. Uploads use the presigned flow (`handleUploadPresigned` + `issueSignedToken`),
  which works with both. Without either variable the Photos dialog says the store is not connected.
- Deleted files can still be served from Vercel's CDN for about a minute.

## Step 2 — sign-in, shop, cart, order (migration 0015)

- **Shop access** (Master → Retailers → Shop): staff switch the shop on, set the 10-digit mobile the
  retailer signs in with and a 4–6 digit PIN ("Make one"), then share link + mobile + PIN (WhatsApp /
  copy). PIN = scrypt hash in `retailers."shopPinHash"`; the hash never leaves the server
  (`lib/retailer-columns.ts` everywhere retailer rows are read). A new PIN sets `shopPinSetAt`, which
  ends old sessions. 5 wrong PINs lock sign-in for 15 minutes.
- **Session** (`lib/shop/auth.ts`): signed cookie `shayona_shop` (HMAC, key from BETTER_AUTH_SECRET),
  7 days, holds retailer id + name + PIN time. Pages trust it with no query; placing an order
  re-checks the retailer (still on, same PIN) inside its transaction.
- **/shop** (`components/shop/shop-app.tsx`): photo grid of article colours that have a photo, search,
  division / segment chips, latest MRP; an article opens with all photos, its other colours, pairs per
  size, "+ Set" (Master sets whose sizes all exist) and "+ Carton" (active assortments of the same
  division + segment that the "only for" rule allows, sizes all on the article). Cart kept on the
  phone (localStorage). Place order → `lib/shop/place-order.ts`: one transaction, status
  `to_confirm`, source `retailer`, lines in the salesman format (name, colour, size, article code).
- **Catalogue** (`lib/shop/catalogue.ts`): cached (`unstable_cache`, tag `shop-catalogue`, 30 min);
  refreshed at once by photo / article / assortment / set changes. Building it: 3 queries in parallel.
  Browsing: 0 queries most of the time.
- **Latest MRP**: `article_mrps."mfgYm"` (newest manufacture month) and `"lastSeenAt"`, kept by every
  scan and billed box; shop shows the MRP of the newest manufacture, then the most recently seen.
- **/shop/orders**: the retailer's last 30 shop orders with plain status words (1 query).

## Step 3 — staff confirm

Orders (admin hub, and the role hub for salesmen) shows **Retailer orders to confirm** when there are
any (1 query): retailer, time, pairs, lines per article/colour/size, note. **Confirm** → status
`pending` (picking as usual; the confirming salesman/admin becomes its salesman). **Not accepted** →
`cancelled` with the reason added to the notes. Both audited. Pickers never see `to_confirm`.
