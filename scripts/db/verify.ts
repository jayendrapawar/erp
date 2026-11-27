// Post-migration verification (read-only).
//
//   npx tsx scripts/db/verify.ts --env-file .env.local [--against backups/<endpoint>/<stamp> [--after-reset]]
//
// --after-reset: the article master was cleared after the backup (reset-article-master.ts), so
// article rows must equal what imports created since, and scans start from zero.
//
// Checks: migration history, ledger = balances, every resolved scan posted exactly once,
// no voided scan left un-reversed, legacy quantity = imported quantity, and (with
// --against) that master-data row counts did not change versus the backup.

import fs from 'node:fs'
import path from 'node:path'
import { arg, connect, flag, log, resolveTarget } from './_connect'

async function main() {
  const t = resolveTarget()
  const c = await connect(t, { readOnly: true, schema: arg('schema') || undefined })
  let failures = 0
  const check = (ok: boolean, label: string, detail = '') => {
    if (!ok) failures++
    log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  }
  const one = async (q: string) => Object.values((await c.query(q)).rows[0] ?? {})[0]
  try {
    const migrations = (await c.query(`select version, method from schema_migrations order by version`)).rows
    check(migrations.length >= 3, 'migration history recorded', migrations.map((m) => `${m.version}:${m.method}`).join(', '))
    check(Number(await one(`select count(*) from stock_balance_mismatches`)) === 0, 'stock_balances equal the ledger')
    check(Number(await one(`select count(*) from scan_events e where e.status='active' and e.resolution='resolved'
      and (select count(*) from stock_movements m where m."idempotencyKey" = 'scan_event:'||e.id||':post') <> 1`)) === 0, 'every resolved active scan posted exactly once')
    check(Number(await one(`select count(*) from scan_events e where e.resolution <> 'resolved'
      and exists (select 1 from stock_movements m where m."sourceType"='scan_event' and m."sourceId"=e.id::text)`)) === 0, 'unresolved scans have no stock')
    check(Number(await one(`select count(*) from scan_events e where e.status='voided'
      and exists (select 1 from stock_movements m where m."idempotencyKey"='scan_event:'||e.id||':post')
      and not exists (select 1 from stock_movements m where m."idempotencyKey"='scan_event:'||e.id||':void')`)) === 0, 'every voided scan is reversed')
    const legacyQty = Number(await one(`select coalesce(sum(quantity),0) from legacy_scans`))
    const importedQty = Number(await one(`select coalesce(sum(quantity),0) from scan_events where source='legacy_import'`))
    check(legacyQty === importedQty, 'legacy quantity fully imported', `${legacyQty} legacy vs ${importedQty} imported (differences are listed by the import script)`)
    check(Number(await one(`select count(*) from (select 1 from scan_events where status='active' and "dedupeKey" is not null group by purpose, "dedupeKey" having count(*)>1) d`)) === 0, 'no label has two active scans')

    // Party ledger (migration 0017; docs/architecture/payments.md)
    if (await one(`select to_regclass('party_ledger_entries') is not null`)) {
      check(Number(await one(`select count(*) from party_balance_mismatches`)) === 0, 'party_balances equal the ledger')
      check(Number(await one(`select count(*) from party_open_item_mismatches`)) === 0, 'per party: unpaid − advance = balance')
      check(Number(await one(`select count(*) from sale_bills b where b."retailerId" is not null and (
        -- Backfilled old bills have no entry unless posted with --ledger (the opening balance covers them).
        (b.status = 'active' and b.source <> 'backfill' and not exists (select 1 from party_ledger_entries e where e.kind = 'bill' and e."saleBillId" = b.id
           and not exists (select 1 from party_ledger_entries r where r."reversalOfId" = e.id)))
        or (b.status = 'cancelled' and exists (select 1 from party_ledger_entries e where e.kind = 'bill' and e."saleBillId" = b.id
           and not exists (select 1 from party_ledger_entries r where r."reversalOfId" = e.id))))`)) === 0,
        'every active party bill is in the ledger once; every cancelled one is reversed')
      check(Number(await one(`select count(*) from sale_bills b where b."retailerId" is null
        and exists (select 1 from party_ledger_entries e where e."saleBillId" = b.id)`)) === 0, 'walk-in bills have no ledger entry')
      // Credit notes (migration 0018): an active note is in the ledger once; a cancelled one is reversed.
      if (await one(`select to_regclass('credit_notes') is not null`)) {
        check(Number(await one(`select count(*) from credit_notes n where
          (select count(*) from party_ledger_entries e where e.kind = 'credit_note' and e."creditNoteId" = n.id
             and not exists (select 1 from party_ledger_entries r where r."reversalOfId" = e.id)) <> (case when n.status = 'active' then 1 else 0 end)`)) === 0,
          'every active credit note is in the ledger once; every cancelled one is reversed')
      }
      check(Number(await one(`select count(*) from payments p where
        (select count(*) from party_ledger_entries e where e.kind = 'payment' and e."paymentId" = p.id) <> (case when p.status in ('pending', 'returned') then 0 else 1 end)
        or (p.status in ('bounced', 'reversed')) <> exists (select 1 from party_ledger_entries e join party_ledger_entries r on r."reversalOfId" = e.id
           where e.kind = 'payment' and e."paymentId" = p.id)`)) === 0,
        'cheques in hand are not counted; counted payments are in the ledger once; bounced / reversed ones are reversed')
    }

    // Article catalogue (migration 0003 + catalogue imports)
    if (await one(`select to_regclass('catalog_articles') is not null`)) {
      check(Number(await one(`select count(*) from articles a join catalog_articles c on c.id = a."catalogArticleId" where a."artCode" <> c."artCode"`)) === 0, 'every variant matches its article code record')
      check(Number(await one(`select count(*) from articles a where a.active and a."catalogArticleId" is not null
        and not exists (select 1 from article_sizes s where s."articleId" = a.id and s.active)`)) === 0, 'every active catalogue variant has sizes')
      check(Number(await one(`select count(*) from articles where not active and "retiredAt" is null and "retiredReason" is not null`)) === 0, 'retired variants carry a retirement time')
      check(Number(await one(`select count(*) from article_size_ranges r join articles a on a.id = r."articleId"
        where r.active and exists (select 1 from unnest(r.sizes) z where not exists (select 1 from article_sizes s where s."articleId" = a.id and s."sizeLabel" = z and s.active))`)) === 0,
        'every size in an active range is an active SKU')
      const batches = (await c.query(`select b.id, b."rowCount", (select count(*) from catalog_source_rows r where r."batchId" = b.id)::int as kept from catalog_import_batches b`)).rows
      check(batches.every((b) => Number(b.rowCount) === Number(b.kept)), 'every imported workbook row is kept verbatim', batches.map((b) => `batch ${b.id}: ${b.kept}/${b.rowCount}`).join(', ') || 'no batches')
      const open = await one(`select count(*) from catalog_review_items where status = 'open'`)
      log(`Catalogue: ${await one(`select count(*) from articles where active and "catalogArticleId" is not null`)} active catalogue variants, ${await one(`select count(*) from articles where not active`)} retired, ${open} open review items`)
    }

    const against = arg('against')
    if (against) {
      const man = JSON.parse(fs.readFileSync(path.join(against, 'manifest.json'), 'utf8'))
      const afterReset = flag('after-reset')
      if (afterReset) {
        const n = Number((await c.query(`select count(*)::int as n from audit_events where action = 'article_master.reset' and "occurredAt" >= $1`, [man.takenAt])).rows[0].n)
        log(`INFO  article master reset after the backup: ${n ? 'recorded in audit_events' : 'not in audit_events (expected when the reset ran on the baseline schema; see backups/<endpoint>/reset-*.json)'}`)
      }
      const same: Array<[string, string]> = [['vendors', 'retailers'], ['scans', 'legacy_scans'], ['user', 'user'], ['orders', 'orders'], ['order_items', 'order_items'], ['bill_lines', 'bill_lines']]
      for (const [before, after] of same) {
        if (!man.tables[before]) continue
        const now = Number(await one(`select count(*) from "${after}"`))
        if (afterReset && after === 'legacy_scans') { check(now === 0, 'legacy_scans cleared by the reset', `found ${now}`); continue }
        check(now === man.tables[before].rows, `${after} row count unchanged`, `${man.tables[before].rows} → ${now}`)
      }
      // Article tables change on purpose (duplicate clean-up, catalogue import). Every row must be
      // accounted for: after = before − archived-and-removed + created by an import after the backup.
      const has = async (tname: string) => Boolean(await one(`select to_regclass('${tname}') is not null`))
      const archived = (await has('article_duplicate_archive'))
        ? (await c.query(`select count(*)::int as rows, coalesce(sum(jsonb_array_length(sizes)), 0)::int as sizes, coalesce(sum(jsonb_array_length(colours)), 0)::int as colours
                          from article_duplicate_archive where action = 'merged' and "archivedAt" >= $1`, [man.takenAt])).rows[0]
        : { rows: 0, sizes: 0, colours: 0 }
      const created = (await has('catalog_import_batches'))
        ? (await c.query(`select coalesce(sum((summary->>'variantsCreated')::int), 0)::int as rows, coalesce(sum((summary->>'skusCreated')::int), 0)::int as sizes,
                          coalesce(sum((summary->>'coloursInserted')::int), 0)::int as colours from catalog_import_batches where "appliedAt" >= $1`, [man.takenAt])).rows[0]
        : { rows: 0, sizes: 0, colours: 0 }
      for (const [table, key] of [['articles', 'rows'], ['article_sizes', 'sizes'], ['article_colors', 'colours']] as const) {
        if (!man.tables[table]) continue
        const before = afterReset ? 0 : man.tables[table].rows as number
        const expected = before - Number(archived[key]) + Number(created[key])
        const now = Number(await one(`select count(*) from "${table}"`))
        check(now === expected, `${table} rows accounted for`, `${afterReset ? 'reset → 0' : before} − ${archived[key]} archived + ${created[key]} imported = ${expected}; found ${now}`)
      }
    }
    const totals = (await c.query(`select provenance, sum(quantity)::int q from stock_balances group by 1 order by 1`)).rows
    log(`Stock by provenance: ${totals.map((r) => `${r.provenance}=${r.q}`).join(', ') || 'none'}`)
  } finally {
    await c.end()
  }
  if (failures) { log(`${failures} check(s) failed.`); process.exit(1) }
  log('All checks passed.')
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
