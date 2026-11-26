# Warehouse Scanner (rework, 26 Nov 2026)

Owner's brief: hard to use on a phone, slow / laggy. Wanted: one scan screen, stocktake sessions,
a fixed list of racks. Migration 0021 (`db/migrations/0021_stocktake_sessions.sql`), not yet applied.

## The screen (one page, phone first)

1. **Choose the rack** (`components/scanner/rack-picker.tsx`). A rack being counted shows
   "Counting now · pairs · since … (who)"; tapping it **joins** that count, else a new count starts.
2. **Count card**: rack, big pairs total, boxes / cartons / by hand / not in master / waiting on this
   phone; Change rack, Finish count, ↻.
3. **Scan box** for the scanner machine (USB / Bluetooth; keys typed anywhere go to it), **Scan with
   camera** (+ torch where the phone allows).
4. Carton card when a carton label is scanned (`docs/architecture/stocktake-cartons.md`).
5. **By hand · Counts · More** (photo scan, scans waiting on this phone, Manage racks, Reports).
6. **The list**: every scan appears at once ("Saving…") and turns green (saved), amber (saved, not in
   master / kept on this phone) or red (already scanned, not saved). Undo per row (reason required).

The phone remembers the count it is in (`localStorage` `shayona.scanner.count`); opening the screen
again goes straight back to it (or to the rack list when someone finished it).

## Racks and counts (sessions)

- `racks`: fixed list, kept by admin + supervisor (`racks.manage`); never deleted, switched off.
  Filled once from the old scanner flags. The old free-text flags are no longer offered.
- `stocktake_sessions`: one count of one rack; one **open** count per rack (several people join it).
  Finish: whoever started it, or admin / supervisor (`scan.void.any`). Totals are aggregated in SQL:
  pairs = boxes + pairs typed by hand + carton pairs; plus cartons, not in master, people.
- Every scan, typed box and counted carton carries `sessionId`; `flag` = the rack name (set on the
  server from the session), so Reports and exports keep working.
- Scans kept on a phone while a count was open still join it when they sync, even if it was
  finished meanwhile (a box that was really scanned is never dropped).

## Why it was slow, and what changed

Before, each box was **three server actions one after another** (article check → save → reload the last
50 scans), the save re-rendered the page on the server (`revalidatePath`, one more query), and Next.js
sends server actions **one at a time** per page, so quick scans queued up.

Now:

| Action | Requests | Database | Expected |
|---|---|---|---|
| Open the screen | 1 (`getScannerBoot`) | racks, counts + totals, my count + my list — in parallel | ~0.3–0.5 s warm; +1–3 s Neon cold start |
| Choose a rack | 1 | 1 transaction (2–3 statements) + totals | ~0.3 s |
| **Scan a box** | **1** (`POST /api/scanner/scan`, a route so scans run side by side) | 1 transaction (~8 statements) + 1 read for names | row shows at once; saved ~0.2–0.4 s |
| Scan a carton label | 1 (same route) | 1 read | ~0.2–0.4 s |
| Count a carton / type a box | 1 | 1 transaction | ~0.3–0.6 s |
| ↻ / back to the tab | 1 | totals + my list | ~0.2 s |
| Counts list | 1 | 2 statements (50 counts + totals) | ~0.3 s |

- No page re-render after a scan; the list and totals update on the phone. No polling.
- The camera uses the phone's built-in QR reader (`BarcodeDetector`) when there is one — faster and
  off the main thread; otherwise jsQR as before. It decodes nothing while a card or dialog is open.
- A box already in this phone's list is refused at once without a request.
- No internet, or the server fails → the scan is kept on the phone (same id, so sending it twice
  never adds it twice) and sent when the internet is back.

## Files

`components/scanner-page.tsx` (screen), `components/scanner/{rack-picker,rack-manager,scan-feed,
manual-entry-dialog,counts-dialog,sheet,stocktake-carton-card,use-qr-scanner}.tsx`,
`app/api/scanner/scan/route.ts`, `app/actions/scanner.ts`, `lib/inventory/{scanner-scan,
stocktake-sessions,stocktake-carton}.ts`. Tests: `tests/db/stocktake-sessions.test.ts`,
`tests/db/stocktake-carton.test.ts`.

Not used by the screen any more (kept, harmless): `components/scanner/ui.tsx` (FlagSelector),
`components/scanner/storage.ts`, `lib/offline-flags.ts`, `app/actions/flags.ts`.
