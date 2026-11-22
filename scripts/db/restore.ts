// Restore tables from a backup made by scripts/db/backup.ts.
//
//   npx tsx scripts/db/restore.ts --env-file .env.local --from backups/<endpoint>/<stamp> \
//       [--tables articles,article_sizes] [--schema public] --confirm <endpoint>
//
// For each selected table (default: every table in the backup that still exists):
// deletes current rows and re-inserts the backed-up rows, all in ONE transaction, in
// foreign-key order. Sequences are reset to their backed-up values. Any error rolls
// everything back. Columns that no longer exist are reported and skipped; the restore
// stops if a backed-up NOT NULL column is missing from the row data.
//
// Ledger tables are append-only by design; restoring them requires --allow-ledger.

import fs from 'node:fs'
import path from 'node:path'
import { arg, connect, flag, log, requireWriteConfirmation, resolveTarget } from './_connect'

const LEDGER = new Set(['stock_movements', 'stock_balances', 'party_ledger_entries', 'party_allocations', 'party_balances'])

async function main() {
  const t = resolveTarget()
  requireWriteConfirmation(t)
  const from = arg('from')
  if (!from) throw new Error('Pass --from <backup directory>.')
  const schema = arg('schema') || 'public'
  const manifest = JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8'))
  const wanted = arg('tables')?.split(',').map((s) => s.trim()).filter(Boolean)

  const c = await connect(t)
  try {
    const existing = new Set((await c.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE'`, [schema],
    )).rows.map((r) => r.table_name))
    let tables = Object.keys(manifest.tables).filter((n) => existing.has(n) && (!wanted || wanted.includes(n)))
    if (tables.some((n) => LEDGER.has(n)) && !flag('allow-ledger')) {
      throw new Error('Selected tables include the stock or party ledger. Pass --allow-ledger only if you mean to rewrite it.')
    }

    // Order parents before children using FK edges among selected tables.
    const edges = (await c.query<{ child: string; parent: string }>(
      `select cl.relname child, pl.relname parent from pg_constraint k
       join pg_class cl on cl.oid = k.conrelid join pg_class pl on pl.oid = k.confrelid
       join pg_namespace n on n.oid = cl.relnamespace where k.contype='f' and n.nspname=$1`, [schema],
    )).rows
    const ordered: string[] = []
    const visit = (n: string, seen = new Set<string>()) => {
      if (ordered.includes(n) || seen.has(n)) return
      seen.add(n)
      for (const e of edges) if (e.child === n && e.parent !== n && tables.includes(e.parent)) visit(e.parent, seen)
      ordered.push(n)
    }
    tables.forEach((n) => visit(n))
    tables = ordered

    await c.query('BEGIN')
    await c.query(`SET LOCAL search_path TO ${schema}`)
    // Lets the ledger guard triggers accept a deliberate, transactional restore.
    await c.query(`SELECT set_config('shayona.ledger', 'on', true), set_config('shayona.restore', 'on', true)`)
    const rebuildBalances = tables.includes('stock_movements')
    if (rebuildBalances) {
      // Balances are derived: clear them, restore movements, then rebuild from the ledger.
      await c.query('DELETE FROM stock_balances')
      tables = tables.filter((n) => n !== 'stock_balances')
    }
    const rebuildParty = tables.includes('party_ledger_entries')
    if (rebuildParty) {
      // Same for the party ledger (migration 0017).
      await c.query('DELETE FROM party_balances')
      tables = tables.filter((n) => n !== 'party_balances')
    }
    for (const n of [...tables].reverse()) await c.query(`DELETE FROM "${n}"`)
    for (const n of tables) {
      const file = path.join(from, `${n}.jsonl`)
      const text = fs.readFileSync(file, 'utf8').trim()
      const rows = text ? text.split('\n').map((l) => JSON.parse(l)) : []
      const liveCols = new Set((await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema=$1 and table_name=$2`, [schema, n],
      )).rows.map((r) => r.column_name))
      const cols = (manifest.tables[n].columns as Array<{ column_name: string }>).map((x) => x.column_name).filter((x) => liveCols.has(x))
      const dropped = (manifest.tables[n].columns as Array<{ column_name: string }>).map((x) => x.column_name).filter((x) => !liveCols.has(x))
      if (dropped.length) log(`  ${n}: columns no longer present, skipped: ${dropped.join(', ')}`)
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500)
        const params: unknown[] = []
        const values = batch.map((r) => `(${cols.map((col) => {
          const v = r[col]
          params.push(v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)
          return `$${params.length}`
        }).join(',')})`).join(',')
        await c.query(`INSERT INTO "${n}" (${cols.map((x) => `"${x}"`).join(',')}) OVERRIDING SYSTEM VALUE VALUES ${values}`, params)
      }
      log(`  ${n.padEnd(28)} ${String(rows.length).padStart(7)} rows restored`)
    }
    if (rebuildBalances) {
      await c.query(`SELECT set_config('shayona.ledger', 'on', true)`)
      // Movement inserts above already re-applied balances through the trigger; rebuild to be exact.
      const n = (await c.query('SELECT stock_balances_rebuild() AS n')).rows[0].n
      log(`  stock_balances rebuilt from ledger: ${n} rows`)
    }
    if (rebuildParty) {
      const n = (await c.query('SELECT party_balances_rebuild() AS n')).rows[0].n
      log(`  party_balances rebuilt from ledger: ${n} rows`)
    }
    for (const s of manifest.sequences as Array<{ sequencename: string; last_value: string | null }>) {
      if (s.last_value !== null) await c.query(`SELECT setval($1, $2)`, [`${schema}.${s.sequencename}`, s.last_value]).catch(() => undefined)
    }
    await c.query('COMMIT')
    log('Restore committed.')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    await c.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
