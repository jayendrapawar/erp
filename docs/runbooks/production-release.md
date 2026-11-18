# Production release: inventory foundation, Sparx article master, carton assortments

**Do not start without the owner's written approval to release.** Migration 0002 renames
tables the currently deployed code uses (`vendors` → `retailers`, `scans` → `legacy_scans`),
so the database steps and the code deployment happen together in one maintenance window.

| | |
|---|---|
| Production database | Neon endpoint `ep-royal-tooth-b3ub6jie` (`.env`). Owner confirmed 18 Nov 2026 that the Vercel production `DATABASE_URL` points at it. |
| Development database | `ep-damp-scene-b3i40jjo` (`.env.local`) |
| Code | `development` branch at the commit the owner approves |
| Article master | `sparx_article_list_filled (2).xlsx`, sheet `Articles`, SHA-256 `aebae679ab501f3a…` (full hash in the import report) |
| Assortments | `docs/catalog/eva/flite-eva-assortments.xlsx` (32 Flite EVA assortments, converted from `eva assortment.xlsx`, row 44 ignored) |
| Rehearsed | 18 Nov 2026, on a copy of production (backup `2026-11-18T11-20-02-732Z`) restored into a scratch schema of the development database. All checks passed; the resulting schema equals development exactly (`docs/release/schema-diff-rehearsal-vs-dev.md`). |

## Owner decision (18 Nov 2026): start the article master from the Sparx list only

The 2,759 old production article rows were entered by hand, contain wrong codes (e.g. SM-375
sizes 11–12 under SX0375G instead of SX0375S) and 83 duplicate groups. Nothing references them
(0 scans, 0 orders, 0 stock). They are **cleared** and the approved Sparx list is loaded fresh.
Other brands and articles not in the list come in through scanning (Missing Articles →
admin confirms name, colour and sizes). The old rows stay in the step-1 backup and in Neon's
point-in-time history.

This replaces the earlier duplicate-review plan; its scripts were removed. Migration 0004
(`article_duplicate_archive`) stays because development already recorded it; on production it
creates an empty table.

## Production on 18 Nov 2026 (read-only inspection)

- Schema = `db/migrations/0000_baseline.sql` exactly. No migration tracking table.
- 2,759 articles, 15,398 sizes, 2,759 colours; 0 scans, 0 orders, 0 order lines, 0 vendors;
  4 users; 2 flags.

## Final sequence (each command prints the endpoint it touches; writes need `--confirm`)

Rehearsal timings in brackets. Database work ≈ 1 minute; plan a **20-minute window**
including deployment and smoke tests. `W` = path of the Sparx workbook.

| # | Step | Command / action |
|---|---|---|
| 0 | Approval & window | Owner approves the commit and the time. The app is not live yet (owner, 18 Nov 2026), so downtime affects no one. |
| 1 | Backup [10 s] | `npm run db:backup -- --env-file .env` — keep the printed folder. Note the time for Neon point-in-time restore (second safety net). |
| 2 | Start tracking [3 s] | `npm run db:migrate -- --env-file .env --to 0000 --confirm ep-royal-tooth-b3ub6jie` → 0000 is **adopted** (nothing changes, `schema_migrations` is created). |
| 3 | Reset, dry run [6 s] | `npx tsx scripts/release/reset-article-master.ts --env-file .env` — must list `scans 0`, `article_sizes 15398`, `article_colors 2759`, `articles 2759` and no refusal. Stop if different (e.g. someone scanned or booked an order). |
| 4 | Reset [5 s] | same command `--apply --confirm ep-royal-tooth-b3ub6jie --actor-name "<your name>"`. One transaction. Writes a record to `backups/ep-royal-tooth-b3ub6jie/reset-*.json`. |
| 5 | Migrations [5 s] | `npm run db:migrate -- --env-file .env --confirm ep-royal-tooth-b3ub6jie` → 0001 … 0007, each in its own transaction. |
| 6 | Article master, dry run [4 s] | `npm run catalog:import-sparx -- --file "$W" --env-file .env --trust-source --report-dir docs/release/prod-import` — expect **651 new, 0 matched, 0 retired, SKUs +3120, 0 review items**. Stop if different. |
| 7 | Article master [7 s] | same command `--apply --confirm ep-royal-tooth-b3ub6jie --actor <admin email>`. Re-running must report NO CHANGES. |
| 8 | Assortments [3 s] | `npx tsx scripts/catalog/import-assortments.ts --file docs/catalog/eva/flite-eva-assortments.xlsx --env-file .env --apply --confirm ep-royal-tooth-b3ub6jie` → 32 new. (Or upload it in Master → Assortments after deployment.) |
| 9 | Verify [5 s] | `npm run db:verify -- --env-file .env --against <backup folder> --after-reset` — every line PASS (articles 651, sizes 3120, colours 651; users and orders unchanged). Then `npx tsx scripts/catalog/validate.ts --env-file .env --out docs/release/prod-validation.md`. |
| 10 | Deploy | Deploy the approved `development` commit to Vercel production (owner approval). |
| 11 | Smoke test | Admin account: Master → Articles shows 651 Sparx articles; search "SK-1016" → sizes 11 12 13 1 2 3 4 5; Master → Assortments shows 32 Flite EVA rows, Download Excel works; Orders → Biller → Direct Billing: scan the same Sparx box (shows in stock), leave the page, come back → draft is listed, Resume, Generate → Inventory shows −1 and a Billed movement; delete that bill → stock back; scan one Sparx box (stock +1), scan it again (duplicate warning), undo with a reason (stock −1); scan a Flite box → saved under Missing Articles; Orders → book screen lists SS-/SFG-/SM- articles; Dashboard opens. |
| 12 | Roles | Assign roles to the two accounts that have none, if they are staff. |

## Rollback

All database steps before 10 leave the live site broken from step 5 (tables renamed), so keep
the window closed until step 11 passes.

- **Step 3, 6 (dry runs)**: nothing written; stop and investigate.
- **Step 4, 5, 7, 8 fail**: each runs in one transaction and rolls itself back. Then either fix
  and continue, or go back to the start: **Neon point-in-time restore** to the time noted in
  step 1 (simplest and complete), or `npm run db:restore -- --env-file .env --from <backup> --confirm ep-royal-tooth-b3ub6jie`
  after dropping the tables the migrations created.
- **Step 9 fails**: do not deploy. Restore as above.
- **After step 10**: redeploy the previous Vercel deployment first, then restore the database as
  above. Scans made after step 10 would be lost by a restore — export `scan_events` first if
  the site was used.

## Operational impact

- App unavailable for the window (≈20 min) — acceptable: the app is not in use yet. No business data exists (0 scans/orders/stock).
- All 2,759 old article rows are removed (kept in the backup). The article master then holds the
  651 approved Sparx variants (267 article codes, 3,120 sizes).
- Flite, PU, Bahamas and any Sparx article not in the list: their boxes are saved as Missing
  Articles when scanned; an admin confirms them once and the waiting scans go into stock.
- Booking (Orders) only offers the 651 Sparx variants until other articles are confirmed.

## Assumptions and open risks

- Neon free plan: compute suspends when idle; the first command may take a few seconds to wake.
- Order lines still store article name / colour / size as text, not SKU ids. Two codes of one
  design (e.g. SS0702B and SS0702C, both "SS-702") can share a colour name and size. Planned fix:
  store `skuId` on order lines (orders module work).
- Flite EVA assortments: 16 range-and-packing combinations of the price list have no assortment
  yet (`docs/catalog/eva-analysis.md`); add them in Master → Assortments when known.
