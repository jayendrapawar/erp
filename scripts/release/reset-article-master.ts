// Start the article master from an empty state (owner decision, 18 Nov 2026: keep only the
// approved Sparx catalogue; other brands and new articles come in through scanning).
//
// Clears every article, size, colour, MRP, catalogue-import and scanning/stock table — and only
// those. Logins, locations, flags, retailers, suppliers, order sets, assortments and the audit
// trail are kept. Works on the production baseline schema (before migrations 0001–0004) and on
// the current schema: tables that do not exist are skipped.
//
//   npx tsx scripts/release/reset-article-master.ts --env-file .env.local                  (dry run)
//   npx tsx scripts/release/reset-article-master.ts --env-file .env.local --apply --confirm <endpoint> [--max-scans 10]
//
// Refuses when: no backup in the last 2 hours; any order line or bill line exists (they name
// articles as text); more scans than --max-scans (default 0); another table references a table
// being cleared. One transaction; TRUNCATE without CASCADE, so Postgres itself refuses anything
// not listed here. Then run the Sparx import (scripts/catalog/import-sparx.ts).

import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { arg, flag, log, poolConfig, recentBackupExists, requireWriteConfirmation, resolveTarget } from '../db/_connect'

/** Article and scanning data. Order matters only for readability; TRUNCATE takes them together. */
export const RESET_TABLES = [
  'article_scan_links', 'scan_events', 'stock_movements', 'stock_balances', 'missing_article_reviews',
  'legacy_scans', 'scans',
  'catalog_review_items', 'catalog_source_rows', 'article_size_ranges', 'article_sizes', 'article_colors',
  'article_mrps', 'articles', 'catalog_articles', 'catalog_import_batches',
  'article_duplicate_review', 'article_duplicate_archive',
] as const

async function main() {
  const t = resolveTarget()
  const schema = arg('schema') || undefined
  const apply = flag('apply')
  const maxScans = Number(arg('max-scans') ?? 0)
  if (apply) {
    requireWriteConfirmation(t)
    if (!flag('skip-backup-check') && !recentBackupExists(t.endpoint, schema ?? 'public')) throw new Error('Needs a backup taken in the last 2 hours (npm run db:backup).')
  }
  const pool = new pg.Pool(poolConfig(t, schema, 1))
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL lock_timeout = '10s'`)
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('catalog_import'))`)
    const present: string[] = []
    for (const name of RESET_TABLES) if ((await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).rows[0].ok) present.push(name)
    const counts: Record<string, number> = {}
    for (const name of present) counts[name] = Number((await c.query(`SELECT count(*)::int AS n FROM "${name}"`)).rows[0].n)

    const blockers: string[] = []
    for (const name of ['order_items', 'bill_lines']) {
      if (!(await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).rows[0].ok) continue
      const n = Number((await c.query(`SELECT count(*)::int AS n FROM "${name}"`)).rows[0].n)
      if (n > 0) blockers.push(`${name} has ${n} rows (orders name articles as text; clearing articles would orphan them)`)
    }
    const scans = (counts.scan_events ?? 0) + (counts.scans ?? 0) + (counts.legacy_scans ?? 0)
    if (scans > maxScans) blockers.push(`${scans} scans exist, more than --max-scans ${maxScans}`)
    const outside = (await c.query(`
      SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
      FROM pg_constraint
      WHERE contype = 'f' AND confrelid = ANY($1::regclass[]) AND NOT (conrelid = ANY($1::regclass[]))`, [present])).rows
    for (const r of outside) blockers.push(`${r.child} references ${r.parent}`)

    log(`${t.endpoint}${schema ? ` schema ${schema}` : ''}: tables to clear`)
    for (const name of present) log(`  ${name.padEnd(26)} ${counts[name]}`)
    if (blockers.length) { await c.query('ROLLBACK'); throw new Error(`Refusing:\n  ${blockers.join('\n  ')}`) }
    if (!apply) { await c.query('ROLLBACK'); log('Dry run only. Nothing written.'); return }

    // The stock ledger refuses TRUNCATE unless the restore switch is on (migration 0002). It is
    // set for this transaction only; the ledger and balances are cleared together.
    await c.query(`SET LOCAL shayona.restore = 'on'`)
    await c.query(`TRUNCATE ${present.map(n => `"${n}"`).join(', ')} RESTART IDENTITY`)
    if ((await c.query(`SELECT to_regclass('audit_events') IS NOT NULL AS ok`)).rows[0].ok) {
      const actor = arg('actor-name') || 'release script'
      await c.query(`INSERT INTO audit_events ("actorName", action, "entityType", "entityId", before, after)
        VALUES ($1, 'article_master.reset', 'article_master', 'all', $2::jsonb, '{}'::jsonb)`, [actor, JSON.stringify(counts)])
    }
    await c.query('COMMIT')
    // Also kept next to the backups: the production baseline has no audit_events table yet.
    const dir = path.join(process.cwd(), 'backups', t.endpoint)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `reset-${new Date().toISOString().replace(/[:.]/g, '-')}${schema ? `-${schema}` : ''}.json`)
    fs.writeFileSync(file, JSON.stringify({ endpoint: t.endpoint, schema: schema ?? 'public', resetAt: new Date().toISOString(), cleared: counts }, null, 2))
    log(`Record: ${file}`)
    log(`Cleared ${present.length} tables. Next: npm run catalog:import-sparx -- --file "<workbook>" ... --trust-source`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
    await pool.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
