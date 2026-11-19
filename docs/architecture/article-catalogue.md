# Article catalogue: Article → Variant → SKU

Status: implemented on development (migration 0003, 18 Nov 2026).
Production: rehearsed, not released (see `docs/runbooks/production-release.md`).

**Owner decision, 18 Nov 2026:** the article master starts from the approved Sparx list only.
The old hand-entered rows (other brands, wrong codes, duplicates) were cleared on development
with `scripts/release/reset-article-master.ts` (backup first) and will be cleared the same way
on production. Other brands and articles not in the list arrive through scanning (Missing
Articles → admin confirms). The matching / retiring rules below still apply to every later
import (e.g. the corrected four-division sheets).

## Model

| Level | Table | Identity | Example |
|---|---|---|---|
| Article | `catalog_articles` | manufacturer article code | `SS0702B` named "SS-702" |
| Variant | `articles` (historical name) | article code + colour code | `SS0702B` + `BKRD` "Black Red" |
| Size range | `article_size_ranges` | variant + min + max, as supplied | 11–13, 1–1, 2–5 |
| SKU | `article_sizes` | variant + size | `SS0702B BKRD 12` |

- **artName is a display / family name**, not an identity. One name can cover several codes:
  "SS-702" is both `SS0702B` and `SS0702C`; Flite "FL-20" is `FL0020G`, `FL0020L` …
- **Segment is never read from the code or name.** The owner (18 Nov 2026) said to ignore any
  keyword in them (last letter G/L/B/C, "kids", "men" …). The segment (Gents / Ladies / Kids) comes only from the Segment column
  of the final article list and links an article to its carton assortments.
- The variant table keeps the name `articles` because scans, SKUs and the stock ledger point
  at its ids. Renaming it would be churn with no data benefit.
- A variant may have **several size ranges**. They are kept as given and expanded to one SKU per
  size; disjoint ranges are never merged into an invented range. Children's ranges wrap:
  11–1 = 11, 12, 13, 1 (`lib/catalog/sizes.ts`). `sortOrder` encodes the chart (children's 11–13
  sort before 1). `articles.minSize/maxSize` now hold the first and last size in that order
  (e.g. `11` / `5`); the SKUs are the source of truth.
- `reviewStatus`: `approved` (matches the approved catalogue), `needs_review` (usable, but the
  source had a conflict), `unverified` (legacy, not yet reviewed).
- **Retired** = `active = false` + `retiredAt` + `retiredReason`. Never deleted while anything
  references it. Retired variants are hidden from booking and scanning; their scans and stock
  stay attached and still appear in stock reports. A scan of a retired code + colour goes to
  Missing Articles; when an admin creates it from the scan, the retired row is re-activated
  (same id) and marked `needs_review`.

## Import rules (`lib/catalog/import.ts`, `scripts/catalog/import-sparx.ts`)

1. Match **only** on normalised article code + colour code. Never on names.
2. Matched variants keep their id; name, colour and sizes come from the workbook.
3. SKUs are matched by size label ("06" = "6") and keep their ids; sizes no longer listed are
   deactivated, never deleted; a deactivated size holding stock becomes a review item.
4. Scope = the article **name family** (SS-, SFG-, SFL-, SFK-, SM-, SL-, SK-). In-scope variants
   absent from the workbook are retired. Other brands (FL-, PU*, BH*, …) are not touched — even
   when they carry a Sparx-looking code by mistake (then a `brand_code_mismatch` review item).
5. Conflicts are recorded, not resolved by guessing: colour-name conflicts (shown as
   "A / B"), overlapping ranges, code with several names, name/code mismatch, one colour
   name under two colour codes. Queue: `catalog_review_items` (Master → Articles →
   Catalogue review; admins close items with a note, audited).
6. Every workbook row is stored verbatim in `catalog_source_rows` with the variant it became;
   every change has an `audit_events` row with before/after; the batch has file name + SHA-256.
7. Scans waiting as Missing Articles for an imported variant are resolved and posted.
8. Re-running the same workbook changes nothing (the plan is empty → no batch written).
9. `--trust-source` (owner decision 18 Nov 2026: "assume the article data has no mistakes"): conflicts in
   the workbook are still reported, but variants are approved, no review items are raised for
   them and open ones are closed with that reason. Applied on development as batch 2 (9 variants
   approved, 15 items closed). Items about the database itself (retired variants with history,
   other-brand rows with Sparx codes) stay open.

## Performance and consistency (AGENTS.md)

| Action | Queries | Expected time | Notes |
|---|---|---|---|
| Catalogue import (admin script) | 11 reads + ~15 set-based writes in one transaction, independent of row count | ~10 s on Neon free (rehearsed) | advisory lock serialises imports; plan recomputed inside the transaction |
| Booking catalogue `loadCatalogue` | unchanged (4 parallel selects) | unchanged | now filters `active` and sorts by `sortOrder`; fewer rows than before |
| Scanner `resolveSku` | unchanged (1 query) | unchanged | |
| Master page load | +1 query (review items, ≤300 rows) in the existing parallel batch | +~20 ms | |
| Close a review item | 1 transaction (select for update, update, audit) | <300 ms | admin only |
| `saveArticle` (edit) | unchanged + 1 statement (catalogue link) | unchanged | sizes of multi-range variants are left alone unless the admin changes them |

Consistency risks and mitigations:
- *Booking lines store text, not SKU ids* (pre-existing). Two codes of one design can share a
  name, colour name and size. Mitigation planned: `order_items.skuId` (orders module).
- *Concurrent edits during an import*: the import locks with an advisory lock and works from a
  state read inside its transaction; admin edits touch single rows and are serialised by row locks.
- *Cache*: the booking catalogue is reference data; it is re-read on page load (no new cache).

## Data on development (after the reset, 18 Nov 2026)

651 variants, 267 article codes, 704 size ranges, 3,120 SKUs, 0 retired, 0 review items, no
scans or stock (the 10 test scans were cleared with the reset). Logins kept. Import batch 1
with `--trust-source`. Reports: `docs/catalog/sparx-reconciliation.md` and
`docs/catalog/sparx-reconciliation/*.csv`. Backup before the reset:
`backups/ep-damp-scene-b3i40jjo/2026-11-18T14-37-03-311Z` (local, not committed).

## Tests

- `npm test` → `tests/catalog/catalog.test.ts` (size ranges, workbook model, scope, plan).
- `TEST_DB_ENV_FILE=.env.local npm run test:db` → `tests/db/catalog-import.test.ts`: ids,
  SKU ids and stock preserved; retired not deleted; other brands untouched (including one that
  shares a code); children's multi-range variant; waiting scan resolved into stock; source rows
  and audit; second apply is a no-op.
- `npm run db:verify` adds catalogue checks; `scripts/catalog/validate.ts` checks scanning
  (QR corpus), booking filters and reporting against a live database.

## Rollback

Restore the pre-import backup (`npm run db:restore`), or run
`db/migrations/0003_article_catalog.down.sql` after re-activating retired rows
(`UPDATE articles SET active = true, "retiredAt" = NULL, "retiredReason" = NULL WHERE "retiredReason" LIKE 'Not in approved catalogue%'`).

## Article list upload (Master → Articles → Upload Excel / CSV)

Code: `lib/catalog/article-upload.ts` (shared by the screen and `scripts/catalog/upload-articles.ts`);
column guide in `lib/catalog/article-upload-columns.ts` (shown on screen under "How to upload").

- Columns: artName, artCode, color, colorCode (optional), minSize, maxSize, Stock source (optional →
  division: Sparx, PU → Flite PU, Flite/EVA → Flite EVA, Bahamas), Segment (accepted, not stored yet).
- Add-only: never deletes, retires or edits an existing variant. Preview first (1 read), then one
  transaction (~8–15 statements whatever the row count).
- Rows without a colour code are stored as "colour code pending" variants (colorCode = '', keyed by
  article code + colour name). The code is filled (same row id) by:
  1. the New Article form: its colour list shows pending colours of the scanned article code first;
     choosing one gives that variant the scanned colour code;
  2. a later upload that has the code for the same article code + colour name;
  3. editing the article in the master.
- Boxes scanned before their article existed are posted to stock when the upload adds the code.

Loaded 19 Nov 2026: `Relaxo filled Article.xlsx` (Sparx, Flite PU, Flite EVA; 3 "Test Article" rows left out).
