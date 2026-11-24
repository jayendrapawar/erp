# Payments: what retailers owe (party ledger)

Status: built on development, 23–24 Nov 2026 (migration 0017, steps 1–10). Not on production yet.
Owner decisions are in this file; ask the owner before changing any of them.

## Model (after ERPNext's Payment Ledger)

Every movement of money owed is one **ledger row**; a payment settles a bill through an
**allocation** ("against"). Nothing is ever edited or deleted: a mistake is a **reversal** row with a
reason. All money is integer **paise**; dates are business dates in IST.

| Table | What it holds |
| --- | --- |
| `sale_bills` | The frozen amounts of every bill (type, discount, GST, round-off, total), written in the billing transaction. Only status columns change (cancel). |
| `payments` | Money received: cash / UPI / cheque / bank. `clientId` makes a retry record once. Status `pending` (cheque in hand) → `active` (counted) → `bounced` / `reversed`; `pending` → `returned`. |
| `party_ledger_entries` | Append-only. `+` = the party owes more (bill, opening, charge); `−` = owes less (payment, discount, advance). Kinds: opening, bill, payment, charge, discount, adjustment, reversal. |
| `party_allocations` | Which credit pays which debit. Undo = a negative row pointing at the original. A deferred trigger refuses over- or under-allocation at commit. |
| `party_balances` | Balance per party, kept **only** by a trigger on the ledger (like stock). |
| `party_open_items` (view) | Debits with money unpaid; credits not yet used (advance). |

Checks (`npm run db:verify`): `party_balance_mismatches` and `party_open_item_mismatches` must be
empty — balance = sum of entries = unpaid − advance. Every DB test ends with these checks.

Every write locks the party's `retailers` row first, so two writes for one party never set the same
money twice.

## Bills (steps 2a, 2b, rates)

- **Bill types** (owner, 23 Nov): within the state (4.75 % discount + CGST 2.5 + SGST 2.5), outside the
  state (4.75 % + IGST 5), without GST (no 4.75 %, own number series `sale_bill_untaxed`, prefix E),
  walk-in (name only, without GST, typed discount, paid at once, **no ledger entry**).
- The bill type comes from the retailer (`retailers.taxType`, Master → Retailers) and can be changed
  on one bill. The **rates** default from Master → Bill template and can be changed on one bill;
  each bill saves what it used, so a reprint never changes. Round-off to the rupee on new bills.
- Arithmetic: `lib/billing/bill-totals.ts` (one function for screen, saved bill, print, PDF).
- `freezeSaleBill` writes the bill and its ledger entry in one statement; `cancelSaleBill` marks it
  cancelled, frees what was set against it (it becomes advance) and reverses its entries.
- A new party bill takes the party's **advance**, oldest first (`applyAdvance`, called by the billing
  actions — not by `freezeSaleBill`, because Edit bill re-attaches its own payments).
- Billing needs a master retailer (except walk-in). Bills are never deleted: Cancel bill, with a reason.

## Payments (step 4) — `lib/payments/payments.ts`

- **Cash / UPI / bank** count at once: discounts first (each against its bill), then the payment is
  set against bills as typed, else **oldest first**; the rest is advance.
- **Cheque** (owner, 23 Nov): only "cheque received" (pending, no ledger entry, not in the balance)
  until **deposited**; it is counted from the deposit date and set against bills then. Returned
  before deposit = never counted. **Bounced** = its rows reversed (bills unpaid again) + optional
  bounce charge (`charge`, stays owed; advance is not applied to it automatically).
- **Reverse** a counted payment recorded by mistake, with a reason (its discounts come off too).
- **Early-payment discount** (owner, 23 Nov): some parties, own % (`earlyPayDiscountBp`) within own
  days (`earlyPayDays`), on the amount **before GST**. Not a formula ("it's subjective"): the screen
  pre-fills the suggestion (`lib/payments/early-discount.ts`); the accountant changes or unticks it.
  A plain ledger `discount` against the bill; GST on the bill is unchanged. A GST credit note is a
  later step.
- Receipt numbers R1, R2 … (`document_sequences` 'payment_receipt').
- Bank and cheque confirmation from the **bank statement** is a later step (needs a sample statement).

## Opening balances (step 6) — `lib/payments/opening.ts`

What parties owed (or had paid in advance) before the app, as of go-live: one row per party or per
old bill (kind `opening`, `+` owes / `−` advance). One at a time, or Excel / CSV upload with a
preview (party by name or code; DD/MM/YYYY; Dr/Cr or a minus amount = advance). The ledger key is
party + date + bill no. + amount, so the same file twice adds nothing; a row re-entered after its
reversal gets `…:r2`. After saving, each party's dues and advance are matched oldest first
(`settleParties`, one statement). Production has nothing before go-live to backfill.

`scripts/billing/backfill-sale-bills.ts` saves amounts for bills made before migration 0017 (dry run
by default; `--apply` on the development database only; no ledger entry unless `--ledger`). Run on
dev 24 Nov: 1 bill.

## Credit notes (24 Nov 2026, migration 0018) — `lib/payments/credit-notes.ts`

Owner: both kinds; against a bill or none; amount typed before GST; own series CN1, CN2 … (Master →
Bill template → Credit note numbers).
- **Money** (discount / rate difference): amount before GST; GST added at the bill's saved rates, or —
  no bill — at the chosen bill type's Master rates (`lib/payments/credit-note-math.ts`); total
  rounded to the rupee. Can be cancelled with a reason (ledger reversed; the number stays used).
- **Goods returned**: needs the bill; each box of that bill is scanned; its stock-out is reversed (back
  in stock) and the box is marked `returned` on the bill (`bill_scans.creditNoteId`). The amount is
  what those boxes were billed at. Cannot be cancelled (bill the boxes again).
- Ledger: one `credit_note` entry (−), set against its bill first, then the oldest unpaid bills; the
  rest is advance. Printed as "CREDIT NOTE (GST)" with the original bill no. and date.
- Saving: 1 transaction, ~9 statements + audit (+1 query per scanned box while scanning).

## Credit hold and terms (steps 7–9) — `lib/payments/credit.ts`

- A party with anything unpaid longer than its **credit days** (`retailers.creditDays`, default 90)
  cannot get a **new order** or a **Direct bill**; an admin can tick "Allow anyway" (audited:
  `order.credit_override`, `direct_bill.credit_override`). Retailer shop orders are not checked.
  Billing an order already taken is not blocked. The **credit limit** only warns.
- The order form and Direct bill show the party's balance / hold when the party is chosen.
- Receipts and bill details show **Paid / Part-paid / Unpaid**.
- Master → Retailers: bill type, credit days, credit limit, early-payment discount % and days.

## Screens — `/payments` (`payments.view`: admin, accountant, salesman; record: admin, accountant)

| Tab | What |
| --- | --- |
| Outstanding | Who owes what, by age 0–30 / 31–60 / 61–90 / 90+, totals, search, sort, 50 a page. |
| Payments & cheques | Cheques to deposit (Deposit / Return); last 60 days (Bounced / Reverse). |
| Party statement | Opening, entries with running balance, closing, unpaid now; Print, WhatsApp. |
| Credit notes | New credit note (money / goods returned), list, Print, Cancel (money only). |
| Opening balances | Add one, upload with preview, list with Reverse. |

Record payment: `n` (or the button) → party → amount → mode (← →) → Ctrl+Enter; receipt Print /
WhatsApp. `g y` opens Payments.

## Cost per action (AGENTS.md)

| Action | Database work |
| --- | --- |
| Open Payments | 2 queries in parallel (outstanding page, party list) |
| Outstanding page / search / statement / payments list / openings list | 1 query each (GET `/api/payments`) |
| Choose a party (Record payment) | 1 query (`getPartyForPayment`) |
| Record payment | 1 transaction, ~7 statements + audit |
| Deposit / bounce / reverse / return | 1 transaction, 3–6 statements + audit |
| Opening upload | preview 2 queries; save 1 transaction (lock, 1 insert, 1 matching statement, audit) |
| Credit check (order form, Direct bill) | 1 query when the party is chosen; 1 query in the save |
| Bill with advance | +2 statements in the billing transaction (none applied when no advance) |

## Tests

`tests/db/payments.test.ts` (part payment, oldest first, chosen bills, advance → next bill, cancelled
bill frees money, idempotent retry, cheque pending → deposit → bounce + charge, return, early
discount, reverse, outstanding ageing, statement running balance, opening balances, credit hold),
`tests/db/sale-bills.test.ts`, `tests/bill/bill-totals.test.ts`, `tests/payments/*.test.ts`.

## Later (not built; room left in the design)

Bank-statement import to confirm UPI / bank /
cheque deposits; supplier side (what we owe Relaxo) in its own `supplier_*` tables; salesman app
collections (`payments.source = 'salesman'`, `collectedBy`, pending).
