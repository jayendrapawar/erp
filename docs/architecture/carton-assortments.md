# Carton assortments

Status: built on development (migration 0005, 18 Nov 2026). 32 Flite EVA assortments loaded.
Production: in the release runbook, step 8.

## What it is

An assortment says how many pairs of each size one carton holds:

| Division | Segment | Pairs per carton | Code | Pairs per size |
|---|---|---|---|---|
| Flite EVA | Gents | 30 | 608 | 6×12 7×10 8×8 |
| Flite EVA | Kids | 36 | 1101 | 11×9 12×9 13×9 1×9 |

- **Key** = division + segment + pairs per carton + code. The segment is part of the key:
  Gents 30/608 and Ladies 30/608 hold different quantities.
- **Code** reads as a size range (608 = 6–8, 1101 = 11–1). Filled sizes must lie inside it.
  Codes that are not ranges are accepted with a warning.
- **Separate from article packing.** The price list says how many pairs an article size row
  ships per carton; the assortment says how those pairs split by size. A carton's expected
  contents need both plus the carton's own size range from its label. The carton receiving
  module (not built yet) will look up an assortment by key.
- Divisions: Sparx, Flite EVA, Flite PU, Bahamas (`lib/catalog/assortments.ts`). An admin can add
  a new division from the Add form; once it holds an assortment, uploads accept it too.
  Segments: Gents, Ladies, Boys, Girls, Kids, Baby.

## Versioning

Rows are never edited or deleted. Saving a change retires the active row (`active = false`,
`retiredAt`, `replacedById`) and inserts the next `version`. A carton received against v1 keeps
pointing at v1. Removing an assortment retires it with a reason. A partial unique index allows
one active row per key. Every change has an `audit_events` row.

## Screen (Master → Assortments)

Filter by division (chips) and segment; search by code or pairs. Admin and accountant can add,
edit (sizes and note only — key fields are fixed) and remove. **Download Excel** gives the
current list (or one division) in the upload format; **Upload Excel** shows every row as New /
New version / No change / Error before anything is saved, and saves nothing if any row has an
error. Rows missing from a file are left alone.

## Excel format (sheet "Assortments", one row per assortment)

`Division | Segment | Pairs per carton | Assortment code | 1 | 2 | … | 13 | Total | Note`

Size cells hold pairs (blank = none). Total is a formula in the template and must equal Pairs per
carton. Columns are found by header name, so their order may change. The template has drop-down
lists for Division and Segment and a "How to fill" sheet. Example:
`docs/catalog/eva/flite-eva-assortments.xlsx`.

## Performance (AGENTS.md)

| Action | Queries | Expected time | Notes |
|---|---|---|---|
| Master page load | +1 select (active rows, a few hundred at most) in the existing parallel batch | +~20 ms | no extra round trip |
| Add | 1 transaction: lock, read active, insert, audit | <300 ms | |
| Edit (new version) | 1 transaction: lock, read, retire, insert, link, audit | <400 ms | unchanged edit writes nothing |
| Remove | 1 transaction: update, audit | <200 ms | |
| Upload preview | parse in memory + 1 select | <1 s | writes nothing |
| Upload apply | 1 transaction: lock, 1 read, ≤4 set-based writes, audits | <1 s for hundreds of rows | plan recomputed under the lock |
| Download Excel | 1 select | <1 s | route `GET /api/assortments/export`, no cache |

Consistency: an advisory lock serialises assortment writes; the upload re-checks every row on
the server before writing, so a stale preview cannot overwrite a newer version blindly (it
would become another new version, visible in the audit trail).

## Files

`db/migrations/0005_carton_assortments.sql`, `lib/catalog/assortments.ts` (rules, parsing; pure),
`lib/catalog/assortment-store.ts` (database), `lib/catalog/assortment-excel.ts` (workbook),
`app/actions/assortments.ts`, `app/api/assortments/export/route.ts`, `app/master/assortments-tab.tsx`,
`scripts/catalog/import-assortments.ts` (EVA conversion and command-line load),
tests `tests/catalog/assortments.test.ts`, `tests/db/assortments.test.ts`.
