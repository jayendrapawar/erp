// Logical backup of every table in a schema (default: public).
//
//   npx tsx scripts/db/backup.ts --env-file .env.local [--schema public] [--out backups]
//
// Writes backups/<endpoint>/<timestamp>/ containing:
//   manifest.json  – tables, row counts, column definitions, sequences, sha256 of each file
//   <table>.jsonl  – one JSON object per row, in primary-key order
//
// Read-only. Verifies each file after writing by re-reading and re-counting rows.
// Restore with scripts/db/restore.ts. Neon point-in-time restore remains the first
// recovery option; this backup is the independent, inspectable copy.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { arg, connect, log, resolveTarget } from './_connect'

async function main() {
  const t = resolveTarget()
  const schema = arg('schema') || 'public'
  const outRoot = arg('out') || 'backups'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(outRoot, t.endpoint, `${stamp}${schema === 'public' ? '' : `-${schema}`}`)
  fs.mkdirSync(dir, { recursive: true })
  log(`Backing up ${t.endpoint} schema "${schema}" to ${dir}`)

  const c = await connect(t, { readOnly: true })
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') // one consistent snapshot
    const tables = (await c.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`, [schema],
    )).rows.map((r) => r.table_name)

    const manifest: Record<string, unknown> = { endpoint: t.endpoint, schema, takenAt: new Date().toISOString(), tables: {} as Record<string, unknown> }
    for (const table of tables) {
      const cols = (await c.query(
        `select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`, [schema, table],
      )).rows
      const pk = (await c.query<{ attname: string }>(
        `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = $1::regclass and i.indisprimary order by a.attnum`, [`"${schema}"."${table}"`],
      )).rows.map((r) => r.attname)
      const order = pk.length ? pk.map((k) => `"${k}"`).join(', ') : '1'
      const rows = (await c.query(`select * from "${schema}"."${table}" order by ${order}`)).rows
      const file = path.join(dir, `${table}.jsonl`)
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
      const written = fs.readFileSync(file, 'utf8')
      const reread = written ? written.trimEnd().split('\n').length : 0
      if (reread !== rows.length) throw new Error(`Verification failed for ${table}: wrote ${rows.length}, re-read ${reread}`)
      ;(manifest.tables as Record<string, unknown>)[table] = {
        rows: rows.length, primaryKey: pk, columns: cols,
        sha256: crypto.createHash('sha256').update(written).digest('hex'),
      }
      log(`  ${table.padEnd(28)} ${String(rows.length).padStart(7)} rows`)
    }
    const seqs = (await c.query(
      `select sequencename, last_value from pg_sequences where schemaname = $1 order by 1`, [schema],
    )).rows
    manifest.sequences = seqs
    await c.query('COMMIT')
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    log(`Backup complete and verified: ${dir}`)
  } finally {
    await c.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
