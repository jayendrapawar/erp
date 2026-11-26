# Stocktake cartons and the scanner machine (Warehouse Scanner)

Status: built on development, 26 Nov 2026 (migration 0021_stocktake_sessions; part of the scanner rework, docs/architecture/warehouse-scanner.md). Owner decision (26 Nov 2026): a carton
label scanned in the Warehouse Scanner **counts the sealed carton as stock** (stocktake), instead of
being refused. Scanner machine: a 2D / QR scanner (USB or Bluetooth, keyboard type).

## Counting a sealed carton

1. Scan the outer carton label (camera, scanner machine, or upload). Nothing is saved yet: a card
   shows the carton (article, colour, size range, MRP) and the pairs per size to confirm.
2. The proposal follows the receiving rule (`lib/purchases/assortment-match.ts`): same division
   (the article's, from the master) + size code; "only for" and segment decide; most specific wins.
   Pairs per carton are not on the label: when earlier invoices show **one** value for this article +
   range, only assortments with those pairs are proposed and typed pairs must add up to it.
3. The card asks **is this carton sealed?** **Sealed — count +N pairs** (after confirming, choosing another assortment, or typing the pairs per
   size — saved to Master → Assortments exactly as at receiving). **Open — I'll scan its pairs** saves nothing for the carton: its pairs are scanned one by one, like loose pairs. A label
   scanned by mistake is answered the same way. Cartons scanned meanwhile wait in turn; the camera pauses while one waits.
4. Saved: `carton_receipts` row with `match = 'stocktake'` (no bill), the count (session) and rack name, the assortment
   used; +pairs per size in `stock_movements` as provenance **carton**, movement **stocktake_carton**.

Single-size cartons (`00` + size) need no assortment: the worker types the pairs (prefilled from
earlier invoices when known).

## Never counted twice

- One active row per carton label, shared with receiving: a label counted at stocktake cannot be
  received on a bill (Receive says "Already counted in stocktake…") nor counted again, and a received
  carton cannot be counted.
- A box later scanned from the carton moves **carton → scanned** (−1 / +1), as for received cartons.
- Only **sealed** cartons may be counted. A box scanned *before* its carton label cannot be detected
  (box serials are not linked to the carton): the card says so.
- Expected on an open bill → the card warns: receive it in Purchases → Receive instead.
- Article or a size not in the master → not counted (scan the boxes: they are kept as missing articles).
- Offline → not counted (the screen says to scan it again when online).

## Undo

Warehouse Scanner → the carton's row in the list → Undo (reason required): own cartons within 24 hours;
`scan.void.any` (admin, supervisor) any time. Reverses the movements (`voidCartonReceipt`); refused
when boxes from it were already scanned or sold (carton stock would go below zero).

## Scanner machine (USB / Bluetooth)

The Camera tab has a **Scan box**, as on Receive and Direct Billing: the machine types the code and
presses Enter (or Tab). Keys typed while no other text box has the cursor go to the Scan box
(`useScanForwarder`), so a scan is never lost; on a computer it has the cursor from the start. Box
and carton labels both work there. A 1D (lines-only) scanner cannot read the QR labels.

## Performance (AGENTS.md)

| Action | Statements | Expected time | Notes |
|---|---|---|---|
| Scan a carton label | 1 read (one statement) + session check | ~0.2–0.4 s warm; +1–3 s Neon cold start | nothing written |
| Count a carton | 1 transaction, ~8–9 statements (+4–8 when typed pairs are saved to the master) | ~0.3–0.6 s warm | per-SKU lock as for box scans |
| Carton rows in the list | part of the count's list (one statement with the boxes) | ~0.2 s | when the screen opens or ↻ |
| Undo | 1 read + 1 transaction (~5 statements) | ~0.3 s | |
| Scanner machine | 0 | instant | browser only |

No polling, no caching (operational data). Indexes `carton_receipts_session_idx`, `carton_receipts_stocktake_user_idx`.

## Files

`db/migrations/0021_stocktake_sessions.sql` (+ `.down.sql`), `lib/inventory/stocktake-carton.ts`,
`app/actions/scan.ts` (carton actions), `components/scanner/stocktake-carton-card.tsx`,
`components/scanner-page.tsx`, test `tests/db/stocktake-carton.test.ts`.
