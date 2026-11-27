# Billing takes stock out (Direct Billing + order invoices)

Status: built on development, 18 Nov 2026 (migration 0006). Owner decisions: stock leaves when
the bill is **generated**; a box never scanned into stock is recorded as **Unscanned dispatch**;
both biller tabs (Invoices and Direct Billing) take stock out.

## Flow

Warehouse scanner → stock in (`stocktake_scan`, +1 scanned). Biller scans → stock out when the
bill is generated (`dispatch`, −1). Every box label is unique: one box can be on one active bill.

**Direct Billing** (Home → Orders → Biller, formerly "Emergency"):
- The first scan (or retailer / typed line) creates a draft (`direct_bill_drafts`). Every scan is
  saved at once (`bill_scans`), the retailer, discount and typed lines are saved 0.7 s after a
  change. Leaving the page by mistake keeps the bill; "Saved drafts" lists every open draft
  with Resume / Discard. "Clear All" discards the draft and frees its boxes.
- A scanned box shows "not in stock" when the warehouse never scanned it in.
- A box already on another bill or draft is refused at scan time, with where it is.
- "Generate Bill" creates the order (status billed, `isEmergency` kept as the Direct Bill flag)
  and its lines, and takes the boxes out of stock in one transaction.

**Order invoices** (Invoices tab): saving the bill sets the order billed, replaces its lines and
records + takes out the scanned boxes in one transaction. If a box is already on another bill
the whole save is refused and the scanner stays open with its scans.

## Which stock a billed box leaves

1. The warehouse scanned this exact label in (active stocktake scan, same dedupe key) and the size
   has scanned stock → −1 `scanned` (`stockSource 'scanned'`).
2. Otherwise, the size has hand-counted (unscanned) stock → −1 `unscanned`.
3. Otherwise → no movement, `stockSource 'unscanned_dispatch'`, listed on Inventory →
   "Unscanned dispatch" for checking. Stock never goes below zero from billing.

Typed lines (no box label) are billed but cannot be matched to a size, so they do not change stock.

## Undo

Deleting a Direct Bill, deleting an order (admin), sending an order back for editing, or an admin
moving an order back before "billed" / cancelling it releases its boxes: their movements are
reversed (both lines stay in the ledger) and the boxes can be billed again. An order still
holding boxes cannot be deleted (foreign key), so stock can never silently drift.

## Performance (AGENTS.md)

| Action | Statements | Notes |
|---|---|---|
| Scan into a draft | 1 (insert + checks in one statement) | screen adds the box at once; the server answer only removes it if refused |
| Save retailer / discount / typed lines | 1, debounced 0.7 s | |
| Open drafts list | 1 | on opening the tab and after generate / discard |
| Resume a draft | 2 | |
| Generate Direct Bill | 1 transaction, ~10 statements whatever the number of boxes | SKUs locked in id order (same lock as corrections) |
| Bill an order invoice | 1 transaction, ~12 statements whatever the number of boxes | |
| Delete / send back | 1 transaction, 3 statements | reversal is one INSERT … SELECT |

## Files

`db/migrations/0006_bill_scans.sql`, `lib/billing/bill-stock.ts`, `app/actions/billing.ts`,
`app/actions/orders.ts` (delete / send back / status), `components/billing-scanner-page.tsx`,
`app/orders/biller/biller-dashboard.tsx`, Inventory additions in `lib/inventory/stock-queries.ts`
and `components/inventory/inventory-page.tsx`. Tests: `tests/db/billing-stock.test.ts`.

## Edit bill by scanning (24 Nov 2026)

Biller → open a billed bill → **Edit bill (scan boxes on / off)**. Owner decisions: billers and admins,
only while the bill is `billed` (once dispatched: cancel instead); same bill number **and date**; money
already set against the bill is set against the edited bill again (oldest first, up to the new total,
the rest stays advance); no reason asked (written as "Bill edited: +2 / −1 boxes").

- Screen (`components/billing/edit-bill-dialog.tsx`): **Add** / **Remove** mode (type `+` / `−` in the
  empty Scan box to switch). Each scan is checked on the screen with the server's rules
  (`lib/billing/box-label.ts`, `lib/billing/bill-edit.ts`): not readable, already on the bill, not on
  the bill, no MRP. New lines and total show at once; every change can be undone before saving.
- A box changes the line with the same MRP and article (exact name, else the order's name for that
  code, `articlesMatch`); otherwise it gets a new line under its own code. Typed lines stay as they are.
- Save (`lib/billing/edit-bill.ts`, one transaction): boxes off → their stock movements reversed;
  boxes on → recorded and taken out of stock (same rules as billing); bill lines rewritten (HSN kept);
  old frozen bill cancelled + new one frozen with the same number and date; payments re-attached; audit
  `bill.edited`. A box on another bill refuses the whole save. Refused when the bill has an early-payment
  discount entered (undo it first) or was made before amounts were saved (cancel and bill again).

| Action | Statements |
|---|---|
| Open the edit screen | 1 query |
| Each scan | 0 (checked on the screen) |
| Save | 1 transaction, ~18 statements whatever the number of boxes |

Tests: `tests/bill/bill-edit.test.ts`, `tests/db/bill-edit.test.ts`.

## Not covered yet

- Returns (a sold box coming back) — no flow yet; deleting the bill is the only way back.
- If the warehouse scans a box that was already sold as Unscanned dispatch, the stocktake scan is
  accepted (it adds stock). Planned: warn in the warehouse scanner when a label is on a bill.

## Direct Billing screen (redesign, 20 Nov 2026)

Designed for the biller (owner: "assume you are a biller"). `components/billing-scanner-page.tsx`.

- **Scan box** keeps the cursor (on computers; again whenever the panel becomes visible, and after
  choosing the retailer, adding by hand, generating or closing a dialog). USB / Bluetooth scanners
  type the code + Enter (Tab also accepted). Keys typed while no text box has the cursor are sent to
  the Scan box, so a scan is never lost (the old listener ignored scans whenever any box had the
  cursor and dropped codes when the scanner paused > 120 ms between characters).
- The bill is always in view (two columns on computers; on phones a bottom bar with boxes, amount
  and Generate). Each line: −1 box (a hand-added box first, else the last scanned box, freed on
  the server) and remove. The last scan result stays on screen; **Undo last scan** while that box is
  on the bill. Box without QR: fold-out form. No tabs.
- Checked in a browser on development with a simulated scanner: scans land in the bill with the
  cursor in the Scan box and with nothing focused; repeat scans are refused; −1 and Clear all free
  the boxes.

## Sale bill template (20 Nov 2026)

`lib/bill-html.ts` builds the printed bill: compact layout, no filler rows; A4 / A5; city (CGST + SGST) or outside city
(IGST + transport). Shop, bank, UPI QR, terms, footer, Hindi retailer name and default paper come
from **Master → Bill template** (admin; `lib/bill-template.ts`, app_settings key `bill.template`,
audited; live preview). Discount 4.75 % and GST rates stay fixed (`BILL_RATES`): bills do not store
their rates, so making them editable first needs the rates saved on each bill.

Pages work like the old ERP bill: a small script inside the bill (`PAGINATE_JS`) measures the real
heights for the paper size and fills each page with as many lines as fit (about 35 on A4, 28 on A5).
Every page repeats the shop header, party, bill no. with "Page x of y" and the column headings;
non-last pages end "Continued on page n". The totals block prints once on the last page; when it does
not fit under the last lines, the lines stay and the totals go to the next page. The first line on a
page repeats its article name. Without scripts the browser paginates instead.
 The bill number
printed is the order / bill number (was a time stamp).

## Bills by email (21 Nov 2026, migration 0014)

Biller → Receipts: tick bills → **Mail** → receiver's email (prefilled from the retailer; "save
this email" stores it on `retailers.email`, comma-separated list allowed) → each bill is attached
as a PDF (`lib/bill-pdf.ts`, pdf-lib, standard fonts: "Rs." instead of ₹, no Hindi name; same
lines, saved discount, pages and totals as the printed bill).

Sender: Master → Bill template → **Bill email** (admin): Gmail address + Gmail **App Password**
(Google account → Security → 2-Step Verification → App passwords). Stored in app setting
`billEmail.sender`, password encrypted with AES-256-GCM (`lib/secret-box.ts`, key derived from
BETTER_AUTH_SECRET); never sent to the browser, audit rows show "(hidden)". "Send test" checks it.
Sending: nodemailer over smtp.gmail.com:465 (`lib/bill-email.ts`), at most 20 bills and 5
addresses per email; Gmail allows about 500 emails a day. Each send is audited (`bill.emailed`).
Queries per send: settings 1 + bills with lines 1 (json_agg) + remember 0–1 + audit 1.

Receipts also: clicking a bill opens a full preview (`components/bill-preview-dialog.tsx`, the
printed bill in a frame, Big/Small, print icon — prints from the frame, no pop-up).

## Bill numbers and HSN (22 Nov 2026, migration 0016)

Every sale bill gets an official number when it is billed (`lib/billing/bill-number.ts`): one locked
`UPDATE document_sequences … RETURNING` inside the billing transaction, so two bills never share a
number and a failed bill gives its number back (no gaps). A bill sent back and billed again keeps
its number (`orders.billNo`, unique). Master → Bill template → **Bill numbers** (admin): prefix,
next number, digits; "next" must be above the highest number already used. At go-live the owner
sets "next" to the old software's next bill number so both systems continue the same series.

HSN prints on the big (A4) bill only. It is copied from the article (`articles.hsn`, one per code,
all colours) onto `bill_lines.hsn` when billed, so later master edits do not change old bills.
Sources: Master → Articles → HSN (by hand, applies to all colours of the code); each imported
Relaxo bill fills articles that have none; and the one-off list from Relaxo's proforma invoices:

    npx tsx scripts/catalog/fill-hsn.ts --env-file <file>                  # preview
    npx tsx scripts/catalog/fill-hsn.ts --env-file <file> --apply --confirm <endpoint>

`docs/catalog/relaxo-invoice-hsn.json` (582 invoices, 17 Jun – 21 Nov 2026): 336 codes with one
HSN; 10 codes printed with two HSNs are not filled (owner decides). It never overwrites an HSN that
is already set. Dev filled 22 Nov 2026 (525 rows). Live: run after migration 0016, with a backup.
