# Inventory screen (`/inventory`)

Status: built on development, 18 Nov 2026. Home → Inventory. Visible to all staff
(`inventory.view.all`); stock corrections for admin and supervisor (`inventory.adjust`).

## What it shows

- **Header figures:** pairs in stock, value at MRP, articles (code + colour) and sizes in stock,
  movements today (India time). Warnings: sizes below zero; scanned pairs still waiting for their
  article (Missing Articles), which are not counted in stock.
- **Stock tab:** one row per article + colour with pairs per size, total pairs and value. Search
  (name, code, colour), division filter, "show articles with no stock". 50 per page.
- **Movements tab:** every ledger line, newest first — scans, undone scans / corrections, hand
  corrections — with who, when, MRP of the box and the reason. Filters: type, staff, date range,
  search. 50 per page (keyset).
- **Article dialog** (tap a row): pairs per size, value, latest 30 movements. Admin / supervisor
  can tap a size to add or remove pairs with a reason, and undo a correction with a reason.

## Rules

- Stock comes only from the ledger (`stock_movements`) and its trigger-maintained balances.
  Nothing is cached.
- **Value at MRP** = pairs on hand × the average MRP of that size's scanned boxes (net of undone
  scans). Sizes never scanned with an MRP are shown as "without MRP" instead of guessed.
- **Corrections** post `adjustment` movements: additions as `unscanned`; removals take
  `unscanned`, then `scanned`, then `carton`, so no provenance goes negative. A correction can
  never take a size below zero. Each request carries a client UUID, so a retry never posts
  twice. Every correction and undo has a reason and an `audit_events` row. Corrections are not
  optimistic: the screen waits for the server.
- **Undo** reverses one correction movement once (unique `reversalOfId`), and is refused if it
  would leave a provenance below zero. Scans are undone in the scanner, not here.
- Concurrency: an advisory lock per SKU serialises corrections and undos of that size.
- Division shown = the variant's division, else the catalogue brand (Sparx rows carry no
  division yet).

## Performance (AGENTS.md; measured on development, 651 articles, Neon cold start excluded)

| Action | Queries | Measured / expected |
|---|---|---|
| Open the screen | 3 in parallel (figures, first stock page, staff names) | ~0.4 s database |
| Search / filter stock (debounced 300 ms) | 1 | ~0.1 s in stock; ~0.4–0.7 s with "no stock" articles |
| Show more | 1 | same |
| Movements tab, filter, older | 1 each | ~0.1 s |
| Open an article | 2 in parallel | ~0.2 s |
| Correction / undo | 1 transaction (lock, read, 1–3 inserts, audit) + 2 reads for the refreshed article + 1 for the figures | <0.5 s |

The header figures aggregate the whole ledger once per screen load; at today's volume this is
cheap. If the ledger grows to hundreds of thousands of lines, measure first, then consider
keeping the MRP value in a summary table.

## Files

`lib/inventory/stock-queries.ts`, `lib/inventory/adjust.ts`, `app/actions/inventory.ts`,
`app/inventory/page.tsx`, `components/inventory/inventory-page.tsx`, Home tile in
`components/home-menu-page.tsx`. Tests: `tests/db/inventory-screen.test.ts`.
