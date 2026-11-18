# Purchases: expected stock, carton receiving, verification

Status: built on development, 18–19 Nov 2026 (migrations 0007, 0008). Home → Purchases.
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
- **Division** is not printed on the bill: suggested from the article codes by majority, with the
  owner's rule (19 Nov 2026, "mostly"): S… → Sparx, P… → Flite PU, F… → Flite EVA, anything else
  (BH, CU Cushion, HL Hi-Lite …) → Bahamas (`lib/qr-config.ts`). Changeable on the bill.
- **Carton assortment per line**: the single active assortment with the bill's division, the
  line's pairs per carton and size range (code 0810 → `810`) is chosen automatically; if several
  fit (Gents / Ladies …) the bill shows them to choose; if none, it says to add one in
  Master → Assortments. The segment is never guessed from the code.

## Bills by mail (Check mail)

Relaxo mails every bill from `sys_admin@relaxofootwear.com` to the shop's Yahoo mailbox, one PDF per
mail, subject "Performa Invoice No <ref>". **Check mail** (admin, accountant) reads mails from that
sender in INBOX and the "Relaxo" folder (IMAP, read-only: nothing is moved or marked) and imports the
PDFs exactly like an upload (`lib/purchases/mail.ts`, `POST /api/purchases/check-mail`).

- Which mails: since one day before the newest mail already looked at (or the oldest mail that
  failed), the last 7 days on the first check, or from a date chosen on the screen. Up to 15 mails per
  press (time limit); the screen says when more are left.
- Each mail is recorded in `bill_mail_messages` (migration 0008) and never imported twice; failed
  mails are retried. A bill already uploaded by hand is recognised (same reference) and skipped.
- Attachments are fetched whole in one request: chunked downloads from Yahoo sometimes arrived cut
  short (48 KB of a 519 KB PDF) and were unreadable.
- Settings (env, never committed): `BILL_MAIL_IMAP_HOST`, `BILL_MAIL_USER`, `BILL_MAIL_PASSWORD` (a Yahoo
  **app password**), `BILL_MAIL_FROM`, and **`BILL_MAIL_START`** (yyyy-mm-dd). Without `BILL_MAIL_START` Check
  mail is off and hidden; mails before it are never imported (not even with an earlier date chosen).
  **Live site:** set `BILL_MAIL_START` only when the owner says — after the stocktake of the whole
  warehouse (owner, 19 Nov 2026). Development uses 2026-08-01. On demand only — no polling.
- Checked 19 Nov 2026 on development: 7 bill mails of the last week → 7 bills (Sparx and Bahamas),
  matching the PDFs in Downloads byte for byte.

## Receiving cartons (warehouse, supervisor, admin)

Purchases → Receive: camera, USB/Bluetooth scanner or typed code. Each outer carton label
(article, colour, size range, pack letter, MRP, serial) is matched to the **oldest open bill line**
with the same article, colour, range and pack letter that still expects cartons (a chosen bill
first). One active receipt per carton label.

- Matched + its contents are known + every size is in the article master → contents enter stock
  at once: +pairs per size, provenance **carton**, movement `receipt`. Contents are known when the
  line has a carton assortment, or the line is a **single-size carton** (bill code `00`+size, e.g.
  `SF0192G-GFSL0007` = 24 pairs of size 7; the carton label reads `0007` too).
- Otherwise the carton is **checked against the bill only**; its stock comes from scanning the boxes
  inside with the warehouse scanner. It is never added later (its boxes may already have been
  scanned — that would count the pairs twice). Choosing an assortment affects cartons received after.
- Not on any open bill, or more cartons than the bill lists → **Unexpected** (no stock change).
- Label MRP different from the bill → received, with a warning.
- Undo a carton (admin, supervisor, accountant): its stock is reversed; refused if boxes from it
  were already scanned or billed (carton stock would go below zero).

## What the bills show (analysis, 19 Nov 2026, 63 bills 27 Aug – 17 Nov, 13,032 pairs)

- Packing (pairs per carton) is the same for an article + size range on every bill: the bill is a
  reliable source of packing per article. Sparx 12 or 24; Flite EVA 24/30/36; Flite PU 12–48; Bahamas 36.
- Every line has pack letter A. Single-size cartons appear on Sparx bills (5 lines).
- Flite EVA: 31 of 35 lines matched an assortment automatically. Sparx: no assortments yet
  (company list awaited); 84 of 118 Sparx lines are article + colour codes already in the master.
- One bill was Cushion (CU) and Hi-Lite (HL) articles: no division suggested.
- The bill does not give the split by size inside a carton — that only comes from the assortment.

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

- Every bill seen so far (8 samples, 7 mails) is a "PERFORMA INVOICE"; the owner treats these as the
  actual bills. A separate tax invoice, if one ever comes, is not handled yet.
- Pack letter: "A" on every sample; owner's guess (19 Nov 2026): another letter such as "B" may be
  factory seconds. Used to match bill lines and labels; a carton with a letter other than A gets a warning.
- Flite PU articles and assortments are not in the master yet, so the four sample bills' cartons
  would be recorded but not added to stock until they are.
