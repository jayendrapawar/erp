# Production release: inventory foundation + Sparx article catalogue

**Do not start without the owner's written approval to release.** Migration 0002 renames
tables the currently deployed code uses (`vendors` → `retailers`, `scans` → `legacy_scans`),
so the database steps and the code deployment happen together in one maintenance window.

| | |
|---|---|
| Production database | Neon endpoint `ep-royal-tooth-b3ub6jie` (`.env`) — **confirm it equals the Vercel production `DATABASE_URL` host before step 1** |
| Development database | `ep-damp-scene-b3i40jjo` (`.env.local`) |
| Code | `development` branch at the commit the owner approves |
| Catalogue source | `sparx_article_list_filled (2).xlsx`, sheet `Articles`, SHA-256 `aebae679ab501f3a…` (full hash in the import report) |
| Rehearsed | 18 Nov 2026 on a copy of production (backup `2026-11-18T11-20-02-732Z`) restored into a scratch schema of the development database |

## Production on 18 Nov 2026 (read-only inspection)

- Schema = `db/migrations/0000_baseline.sql` exactly. No migration tracking table, no
  drizzle journal. Feature 01 migrations (legacy 0011–0014) were **never applied**.
- 2,759 articles, 15,398 sizes, 2,759 colours; 0 scans, 0 orders, 0 order lines, 0 vendors;
  4 users; 2 flags.
- 83 duplicate article code + colour groups (193 rows) — they block 0001's unique index.
  Analysis: `docs/release/duplicate-groups.md`. 82 groups contain Sparx rows (81 are in the
  approved workbook); most are one variant split into one row per size range. Nothing
  references any of them (0 scans, 0 order lines).
- Full schema difference: `docs/release/schema-diff.md`. After the rehearsed steps the
  production schema equals development's (`docs/release/schema-diff-rehearsal-vs-dev.md`);
  the only extra table on development is the legacy `article_duplicate_review` (110 rows of
  the earlier manual clean-up), kept as history.

## Final sequence (each command prints the endpoint it touches; writes need `--confirm`)

Measured rehearsal timings in brackets. Database work ≈ 1 minute; plan a **20-minute window**
including deployment and smoke tests.

| # | Step | Command / action |
|---|---|---|
| 0 | Approval & window | Owner has signed off `docs/release/production-duplicate-review.xlsx` (regenerate it just before: `npx tsx scripts/release/export-duplicate-review.ts --env-file .env --file "<workbook>"` — it must show the same 82 / 105 / 6), approves the commit and the time. Tell staff not to use the app. |
| 1 | Backup [9 s] | `npm run db:backup -- --env-file .env` — keep the printed folder. Note the time for Neon point-in-time restore (second safety net). |
| 2 | Start tracking [4 s] | `npm run db:migrate -- --env-file .env --to 0000 --confirm ep-royal-tooth-b3ub6jie` → 0000 is **adopted** (nothing changes, `schema_migrations` is created). |
| 3 | Duplicates, dry run | `npx tsx scripts/release/prepare-article-duplicates.ts --env-file .env` — must say 83 groups, keep 82, archive+remove 105, clear codes on 6. Stop if different. |
| 4 | Duplicates [16 s] | same command `--apply --confirm ep-royal-tooth-b3ub6jie --actor-name "<your name>"`. One transaction; refuses if anything references a row; commits only if 0 groups remain. Every changed row is copied to `article_duplicate_archive` first. |
| 5 | Migrations [6 s] | `npm run db:migrate -- --env-file .env --confirm ep-royal-tooth-b3ub6jie` → 0001, 0002, 0003, 0004, each in its own transaction. |
| 6 | Catalogue, dry run | `npm run catalog:import-sparx -- --file "<workbook>" --env-file .env --trust-source --report-dir docs/release/prod-import/details` — expect 533 matched, 118 new, 273 retired, 6 review items (other-brand rows with Sparx codes). `--trust-source` applies the owner's decision that the workbook is correct. Stop if materially different. |
| 7 | Catalogue [10 s] | same command (with `--trust-source`) `--apply --confirm ep-royal-tooth-b3ub6jie --actor <admin email>`. One transaction. Re-running must report NO CHANGES. |
| 8 | Legacy scans | `npm run db:import-legacy-scans -- --env-file .env --apply --confirm ep-royal-tooth-b3ub6jie` (0 rows today; harmless). |
| 9 | Verify [5 s] | `npm run db:verify -- --env-file .env --against <backup folder>` — every line PASS (article rows are reconciled: before − archived + imported). Then `npx tsx scripts/catalog/validate.ts --env-file .env --out docs/release/prod-validation.md`. |
| 10 | Deploy | Deploy the approved `development` commit to Vercel production (owner approval). |
| 11 | Smoke test | Admin account: Master → Articles shows the Catalogue review panel and no retired rows; search "SK-1016" → sizes 11 12 13 1 2 3 4 5; scan one Sparx box (stock +1), scan it again (duplicate warning), undo with a reason (stock −1); scan a carton (refused, no stock); Orders → book screen lists SS-/SFG-/SM- articles; Dashboard opens. |
| 12 | Roles | Assign roles to the two accounts that have none, if they are staff. |

## Rollback

Decide by where the failure happened. All database steps before 10 leave the live site
broken only from step 5 (tables renamed), so keep the window closed until step 11 passes.

- **Step 3, 6 (dry runs)**: nothing written; stop and investigate.
- **Step 4, 5, 7 fail**: each runs in one transaction and rolls itself back. Then either fix
  and continue, or restore everything: `npm run db:restore -- --env-file .env --from <backup> --confirm ep-royal-tooth-b3ub6jie`
  and drop the tables the migrations created (or use Neon point-in-time restore to the time
  noted in step 1 — simplest and complete).
- **Step 9 fails**: do not deploy. Restore as above.
- **After step 10**: redeploy the previous Vercel deployment first, then restore the
  database as above. Data entered after step 10 (scans) would be lost by a restore — export
  `scan_events` first if the site was used.
- Targeted undo (rarely needed): `db/migrations/0003_article_catalog.down.sql`,
  `0002_inventory_foundation.down.sql`; archived duplicate rows can be re-inserted from
  `article_duplicate_archive.row` / `sizes` / `colours`.

## Operational impact

- App unavailable for the window (≈20 min). No business data exists yet (0 scans/orders).
- 105 duplicate article rows are archived and removed; 6 other-brand rows keep their name
  and sizes but lose a wrong Sparx code (archived). 273 Sparx rows absent from the approved
  workbook become *retired* (hidden from booking/scanning, not deleted).
- Other brands (Flite, PU, Bahamas …, ≈1,850 rows) are untouched and still have **no article
  codes**, so their boxes are saved as Missing Articles until a catalogue for those brands is
  approved.

## Assumptions and open risks

- `.env` is production — confirm against Vercel (step 0).
- Neon free plan: compute suspends when idle; the first command may take a few seconds to wake.
- 21 catalogue review items (colour-name conflicts, overlapping ranges, name/code
  mismatches, other-brand rows with Sparx codes) need an admin decision after the release;
  none blocks it.
- Order lines still store article name / colour / size as text, not SKU ids. Two codes of one
  design (e.g. SS0702B and SS0702C, both "SS-702") can share a colour name and size, so an
  order line cannot always say which code was meant. Planned fix: store `skuId` on order lines
  (orders module work).
