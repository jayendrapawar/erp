# Purchases: expected stock, carton receiving, verification

Status: built on development, 18 Nov 2026 (migration 0007). Home → Purchases.
Owner decisions: bill PDFs by upload now, Yahoo mail later; a matched carton adds its contents to
stock at once (as 'carton' stock); bills not received 5 days after the bill date are overdue.

## Bills → expected stock

- **Upload** (admin, accountant): one or more Relaxo bill PDFs (`POST /api/purchases/upload`).
  The PDF is read in memory and not stored; the bill and its lines are saved
  (`purchase_bills`, `purchase_bill_lines`). Same reference or same file again → skipped.
- **Reader** (`lib/purchases/relaxo-bill.ts`): the Relaxo "PERFORMA INVOICE" layout. Each line:
  article code, colour code, size range (e.g. `PUG186G-DTDT0810` = 8–10), pack letter (`A`),
  cartons, pairs per carton, pairs, MRP, rate, amount. Wrapped lines (long descriptions) are
  joined. The bill is refused unless Σ cartons and Σ pairs equal the bill's Total row and every
  line has cartons × pairs/ctn = pairs. Checked on the four sample bills (Aug–Sep 2026): all match.
- **Expected on** = bill date + 5 days. Overdue = not fully received after that.
- **Division** is not printed on the bill: suggested from the article codes (PU → Flite PU),
  changeable on the bill.
- **Carton assortment per line**: the single active assortment with the bill's division, the
  line's pairs per carton and size range (code 0810 → `810`) is chosen automatically; if several
  fit (Gents / Ladies …) the bill shows them to choose; if none, it says to add one in
  Master → Assortments. The segment is never guessed from the code.

## Receiving cartons (warehouse, supervisor, admin)

Purchases → Receive: camera, USB/Bluetooth scanner or typed code. Each outer carton label
(article, colour, size range, pack letter, MRP, serial) is matched to the **oldest open bill line**
with the same article, colour, range and pack letter that still expects cartons (a chosen bill
first). One active receipt per carton label.

- Matched + line has an assortment + every size is in the article master → contents enter stock
  at once: +pairs per size, provenance **carton**, movement `receipt`.
- Otherwise the carton is recorded and enters stock automatically when the assortment is chosen
  (or with "Add waiting cartons to stock again" after the article is added).
- Not on any open bill, or more cartons than the bill lists → **Unexpected** (no stock change).
- Label MRP different from the bill → received, with a warning.
- Undo a carton (admin, supervisor, accountant): its stock is reversed; refused if boxes from it
  were already scanned or billed (carton stock would go below zero).

## Carton stock and boxes

- Warehouse scanner: a box whose size has carton stock moves **carton → scanned** (−1 carton,
  +1 scanned) instead of adding a pair; undoing that scan moves it back.
- Billing: a box not scanned in individually comes out of carton stock before hand-counted stock.
- Inventory shows "Carton received" movements; carton stock is valued at the carton label's MRP.

## Screens

Purchases → **Bills** (upload, open/all, progress, overdue, bill detail with lines, assortment
choice, received cartons, undo, cancel bill), **Receive**, **Expected stock** (pairs still to
arrive per article + colour + range), **Unexpected**.

## Performance (AGENTS.md)

| Action | Statements | Notes |
|---|---|---|
| Open Purchases | 2 in parallel | figures + bills |
| Upload a bill | in-memory PDF read + 1 transaction (~6 statements) | ~1–3 s per PDF on development |
| Bill detail | 3 | lines carry progress, assortment and options |
| Receive a carton | 1 transaction, ~14 statements whatever the carton size | ~1–2 s from a laptop to Neon; much less from Vercel |
| Expected stock / receipts | 1 each | |
| Undo a carton | 1 transaction, ~7 statements | |

Not cached; no polling. Receiving refreshes the header figures at most every 2 s.

## Not built yet / open

- **Yahoo mail**: "Check mail" to read new bill PDFs (needs a Yahoo app password and the sender
  address). Upload is the way in until then.
- The final **tax invoice** for goods already on a proforma: format and reference not seen yet.
- Pack letter meaning ("A" on every sample) — used only to match bill lines and labels.
- Flite PU articles and assortments are not in the master yet, so the four sample bills' cartons
  would be recorded but not added to stock until they are.
