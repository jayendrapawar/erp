# Inventory foundation

Status: implemented on the `development` branch and applied to the development database
(ep-damp-scene) on 18 Nov 2026. Not yet applied to production; see
`docs/runbooks/production-release.md`.

## Why it changed

Before migration 0002 the `scans` table was both the count sheet and the stock balance.
Boxes were merged into one row per article/colour/size/MRP/month, quantities were edited
in place, rows were hard-deleted, and nothing linked a stock change to its cause. That
cannot support scanned/unscanned stock, locations, receipts, dispatch or ERP
reconciliation without double counting.

## Model

```
article (articles row: article code + colour code)        ← master, reviewStatus / active
  └─ SKU (article_sizes row: + size)                       ← ids never deleted, only deactivated

locations (warehouse → section → rack → shelf / zone)      ← seeded with MAIN

scan_events          one row per physical box scan (or one manual count line)
  │  clientEventId   UUID made on the device → idempotent retries
  │  dedupeKey       normalised label; unique among ACTIVE stocktake scans
  │  resolution      resolved | missing_article | missing_size
  ▼
stock_movements      append-only ledger: SKU, location, provenance, ±quantity,
  │                  movementType, source document, idempotencyKey, reversalOf
  ▼ (trigger)
stock_balances       (SKU, location, provenance) → quantity. Written only by the trigger.

audit_events         who / what / before / after / why, written in the same transaction
missing_article_reviews  admin review state for unknown codes
suppliers            companies we buy from (Phase 2 extends this table)
retailers            parties we sell to (was `vendors`); orders.retailerId links them
legacy_scans         old merged rows, read-only, imported into scan_events
```

### Provenance (verification category, not a place)

| Provenance | Meaning | Posted by |
|---|---|---|
| `scanned` | individually verified by a box QR scan | stocktake scans, later dispatch/receipt scans |
| `unscanned` | physically present, counted without a QR scan | manual counts, legacy manual rows |
| `carton` | expected from a confirmed carton receipt and an approved assortment | future carton receiving |

Total stock = sum of all three. Converting unscanned → scanned is a pair of movements
(`provenance_transfer`) with zero net effect.

## Decisions

1. **Ledger + trigger-maintained balance.** The ledger is the source of truth; the balance
   table makes reads (dispatch allocation, dashboards) a primary-key lookup instead of a sum
   over every movement. A database trigger updates the balance on every ledger insert, so no
   code path can forget. `stock_balance_mismatches` (a view) must always be empty;
   `stock_balances_rebuild()` repairs it if it ever is not. Chosen over a pure ledger (slow
   reads as volume grows) and over application-maintained balances (drift risk).
2. **Append-only enforcement in the database.** Triggers reject UPDATE/DELETE/TRUNCATE on
   `stock_movements` and any direct write to `stock_balances`. Corrections are reversals.
3. **Scan events are separate from stock movements.** A scan is evidence; a movement is the
   accounting effect. Unknown-article scans are kept as evidence with no movement and are
   posted automatically when an admin links the article — nobody rescans.
4. **Duplicate rule by label identity.** Individual-box labels carry a unique serial
   (confirmed by Shayona; see `docs/qr-parser-report.md`). The key is the normalised payload,
   so a URL-wrapped phone scan and a plain scan of one box collide. Undo voids the scan, so
   the label can be counted again.
5. **Idempotency on two levels.** `scan_events.clientEventId` (per device scan) and
   `stock_movements.idempotencyKey` (per accounting effect). Offline queue entries reuse
   their existing `tempId` as the event id.
6. **SKU = existing `article_sizes` row.** No new SKU table: the rows already exist (15,372)
   with ids. They gained `active` and a unique (article, size) constraint; saving an article
   now deactivates removed sizes instead of deleting and re-creating every row.
7. **Article master is "unverified" until reviewed.** All 2,660 existing rows start
   `unverified` (usable, but flagged). Saving through Master marks a row `approved`.
   `article_quality_issues` lists missing codes, missing colour codes, missing sizes,
   duplicate name+colour and codes used under several names. Nothing merges automatically.
8. **Division comes from the master, never the QR.** The parser only reports the code prefix;
   the new-article dialog shows a labelled hint.
9. **Permissions in one map** (`lib/permissions.ts`), checked by one helper (`lib/authz.ts`).
   The `user` role (first sign-in) has no access. New roles: supervisor, warehouse helper.

## Behaviour by role

| Action | Who |
|---|---|
| Scan boxes / manual count | admin, supervisor, warehouse, accountant, salesman, picker, biller, dispatcher |
| Undo own scan (24 h) | same |
| Undo any scan | admin, supervisor |
| Create / link article from a scan | admin |
| Edit articles, retailers, suppliers | admin, accountant |
| Delete article (deactivates if referenced) | admin |
| Assign roles | admin |

## Migration plan and affected data

| Step | Development (done 18 Nov) | Production (pending approval of the release) |
|---|---|---|
| Backup | `backups/ep-damp-scene…/2026-11-18T09-06-41Z`, verified | required by the runner |
| 0000 baseline | adopted (already present) | adopted |
| 0001 Feature 01 | adopted (already present) | **blocked** until 83 duplicate code+colour groups (193 rows) are reviewed and merged |
| 0002 foundation | applied | apply after 0001 |
| Legacy scan import | 10 rows → 10 scan events, all resolved | 0 rows |
| Verification | `npm run db:verify` — all checks pass | same |

Row counts of articles, sizes, colours, retailers, users, orders and bill lines were
unchanged by 0002 (checked by `scripts/db/verify.ts --against <backup>`).

## Tests

- `npm test` — QR parser regression corpus (13 tests, every supplied sample).
- `TEST_DB_ENV_FILE=.env.local npm run test:db` — builds a throw-away schema in the
  development database from the real migrations and checks: scan posts stock; retry is a
  no-op; duplicate refused and audited; wrapped duplicate caught; two devices scanning one
  box at once save it once; cartons refused; unknown article/size saved without stock and
  posted exactly once when linked; manual counts post unscanned stock idempotently; undo
  reverses and allows a rescan; ledger append-only; balances equal ledger. 11 tests.

## Rollback

- Code: the branch is uncommitted; revert the working tree.
- Database: `db/migrations/0002_inventory_foundation.down.sql` restores the previous table
  names (new tables are dropped), or restore the backup with `npm run db:restore`, or use
  Neon point-in-time restore. `legacy_scans` is never modified, so old data is intact.
