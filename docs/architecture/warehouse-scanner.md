# Warehouse Scanner (rework, 26 Nov 2026)

Owner's brief: hard to use on a phone, slow / laggy; one scan screen; stock taking.
Migrations 0021 (`0021_stocktake_sessions.sql`) and 0022 (`0022_godown_stocktake.sql`).

## Three kinds of stock, mixed in the godown (owner, 26 Nov 2026)

The godown has no fixed areas. Everything is scanned in any order, on one screen, with no step before:

| Stock | What is scanned | What happens |
|---|---|---|
| Loose pair (no carton) | the pair's box QR | +1 pair at once |
| Pair in an open carton | the pair's box QR (same as loose) | +1 pair at once; the carton itself is not counted |
| Sealed carton | the carton QR | card: **Sealed — count +N pairs** (pairs per size confirmed / chosen / typed, as in Purchases → Receive) or **Open — I'll scan its pairs** (nothing saved) |

A carton label never adds pairs without the worker pressing "Sealed", so an open carton's label
scanned by mistake cannot count its pairs. Details: `docs/architecture/stocktake-cartons.md`.

## The godown stocktake

- ONE open stocktake (`stocktake_sessions`, unique index on status where open). Everyone scanning is
  in the same one, with one total. Opening the screen creates nothing ("Not started — your first scan
  starts it"); the **first scan** (pair, typed pair or sealed carton) starts it.
- A live scan always goes into the OPEN stocktake (the server looks it up: one indexed statement), even
  when the phone has not heard yet that the last one was finished; the reply tells the phone which one.
  Scans kept on a phone keep the stocktake they were made in (or the open one, if they had none).
- Finish: admin / supervisor only (`scan.void.any`) — one person finishing would end it for all.
  Nothing new starts until the next scan.
- **Finish does not change stock** (every scan already did). It closes the count as a record. A box QR
  or carton label can be counted only once while its scan is active. That is intended: the owner
  decided (27 Nov 2026) this is a ONE-TIME stocktake — afterwards stock moves through purchases
  (receiving) and bills. No recount / "counted vs system" step is needed.
- **Area (optional)**: "Area: none ▾" — pick a rack / area from the list kept by admin + supervisor
  (`racks`, Manage areas) to tag the next scans (`flag`); not needed. The old free-text flags became
  this list. Old per-rack counts (0021) keep their rack; 0022 finished the ones still open.

## The screen (one page, phone first)

1. **Godown stocktake card**: big pairs total; pairs scanned · sealed cartons (pairs) · by hand ·
   not in master · waiting on this phone; Area chip; Finish stocktake (admin / supervisor); ↻.
2. **Scan box** for the scanner machine (USB / Bluetooth; keys typed anywhere go to it) and **Scan with
   camera** (+ torch where the phone allows).
3. Carton card when a carton label is scanned (sealed or open).
4. **By hand · Stocktakes · More** (photo scan, scans waiting on this phone, Manage areas, Reports).
5. **The list**: every scan appears at once ("Saving…") and turns green (saved), amber (saved, not in
   master / kept on this phone) or red (already scanned, not saved). Undo per row (reason required).

## Why it was slow, and what changed

Before, each box was **three server actions one after another** (article check → save → reload the last
50 scans), the save re-rendered the page on the server (`revalidatePath`, one more query), and Next.js
sends server actions **one at a time** per page, so quick scans queued up.

| Action | Requests | Database | Expected |
|---|---|---|---|
| Open the screen | 1 (`getScannerBoot`) | open stocktake id + racks, then totals + my list, in parallel | ~0.3–0.5 s warm; +1–3 s Neon cold start |
| **Scan a pair** | **1** (`POST /api/scanner/scan`, a route so scans run side by side) | open stocktake lookup (+insert for the first scan) + 1 transaction (~8 statements) + 1 read for names | row shows at once; saved ~0.2–0.4 s |
| Live totals | 1 every 30 s, **only** while the screen is visible and this phone scanned in the last 5 min | totals + my list | a phone left open but idle sends nothing, so Neon can sleep |
| Scan a carton label | 1 (same route) | 1 read | ~0.2–0.4 s |
| Sealed carton / type a pair | 1 | 1 transaction | ~0.3–0.6 s |
| ↻ / back to the tab | 1 | totals + my list | ~0.2 s |
| Stocktakes list | 1 | 2 statements (50 + totals) | ~0.3 s |

- No page re-render after a scan; the list and totals update on the phone. No polling.
- The camera uses the phone's built-in QR reader (`BarcodeDetector`) when there is one; otherwise jsQR.
  It decodes nothing while a card or dialog is open.
- A pair already in this phone's list is refused at once without a request.
- No internet, the server fails, or **no answer within 8 s** (Wi-Fi without internet, very slow network)
  → the scan is kept on the phone (same id, so sending it twice never adds it twice) and sent when the
  internet is back. A carton label, undo and the new-article form need internet.
- Opening the scanner with no internet: the page saves its own offline copy (at most once a day per
  phone) into the app worker's page cache (`public/sw.js` saves pages only on a full page load).
- Phone layout: the page keeps room for the bottom menu bar; a carton card scrolls its Sealed / Open
  buttons into view (they were hidden behind the bar).

Note (dev): a long-running `next dev` can keep an old copy of `lib/db/schema.ts` after a schema change —
inserts then silently drop new columns. Restart `npm run dev` after a migration.

## Files

`components/scanner-page.tsx` (screen), `components/scanner/{rack-manager,scan-feed,manual-entry-dialog,
counts-dialog,sheet,stocktake-carton-card,use-qr-scanner}.tsx`, `app/api/scanner/scan/route.ts`,
`app/actions/scanner.ts`, `lib/inventory/{scanner-scan,stocktake-sessions,stocktake-carton}.ts`.
Tests: `tests/db/stocktake-sessions.test.ts`, `tests/db/stocktake-carton.test.ts`.
