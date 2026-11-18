// Migration runner for db/migrations/*.sql.
//
//   npx tsx scripts/db/migrate.ts status --env-file .env.local
//   npx tsx scripts/db/migrate.ts up     --env-file .env.local --confirm <endpoint> [--to 0002]
//   npx tsx scripts/db/migrate.ts up     --env-file .env.local --schema rehearsal_x --confirm <endpoint>
//
// Rules
//  - Files are applied in version order, each inside its own transaction.
//  - Applied files are recorded in schema_migrations with a sha256 checksum; an edited
//    applied file stops the runner.
//  - A file may start with "-- detect: <SQL returning one boolean>". When the tracking
//    table is first created, every migration whose detect query is true is recorded as
//    "adopted" instead of being run. This is how existing databases (built by hand
//    before this runner existed) join the history safely: their real state decides.
//  - "-- requires-backup" in a file makes `up` refuse to run it until a backup taken in
//    the last 2 hours exists under backups/<endpoint>/.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { arg, connect, flag, log, recentBackupExists, requireWriteConfirmation, resolveTarget } from './_connect'

const DIR = path.join(process.cwd(), 'db', 'migrations')

interface Migration { version: string; name: string; file: string; sql: string; checksum: string; detect?: string; requiresBackup: boolean }

function load(): Migration[] {
  return fs.readdirSync(DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8')
      const detect = sql.match(/^--\s*detect:\s*(.+)$/m)?.[1]
      return {
        version: file.slice(0, 4), name: file.slice(5, -4), file, sql,
        checksum: crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
        detect, requiresBackup: /^--\s*requires-backup\s*$/m.test(sql),
      }
    })
}

async function main() {
  const cmd = process.argv[2]
  if (!['status', 'up'].includes(cmd)) throw new Error('Usage: migrate.ts status|up --env-file <file> [--confirm <endpoint>] [--schema <name>] [--to <version>]')
  const t = resolveTarget()
  const schema = arg('schema') || 'public'
  const migrations = load()
  log(`Target ${t.endpoint} schema "${schema}" — ${migrations.length} migration files`)

  if (cmd === 'up') requireWriteConfirmation(t)
  const c = await connect(t, { readOnly: cmd === 'status' })
  try {
    if (cmd === 'up' && schema !== 'public') await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await c.query(`SET search_path TO ${schema}`)

    const hasTable = (await c.query(`select to_regclass('schema_migrations') is not null as ok`)).rows[0].ok as boolean
    let applied = new Map<string, { checksum: string; method: string }>()
    if (hasTable) {
      applied = new Map((await c.query(`select version, checksum, method from schema_migrations`)).rows.map((r) => [r.version, r]))
    }

    if (cmd === 'status') {
      for (const m of migrations) {
        const a = applied.get(m.version)
        let state = a ? `${a.method}${a.checksum === m.checksum ? '' : ' — CHECKSUM CHANGED'}` : 'pending'
        if (!hasTable && m.detect) {
          const row = (await c.query(m.detect)).rows[0]
          state = row && Object.values(row)[0] ? 'present (would be adopted)' : 'pending'
        }
        log(`  ${m.version} ${m.name.padEnd(36)} ${state}`)
      }
      return
    }

    if (!hasTable) {
      await c.query(`CREATE TABLE schema_migrations (
        version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
        method text NOT NULL CHECK (method IN ('applied', 'adopted')),
        applied_at timestamptz NOT NULL DEFAULT now(), execution_ms integer)`)
      // Adopt the leading run of migrations that are already present.
      for (const m of migrations) {
        if (!m.detect) break
        const row = (await c.query(m.detect)).rows[0]
        if (!row || !Object.values(row)[0]) break
        await c.query(`INSERT INTO schema_migrations (version, name, checksum, method) VALUES ($1,$2,$3,'adopted')`, [m.version, m.name, m.checksum])
        applied.set(m.version, { checksum: m.checksum, method: 'adopted' })
        log(`  ${m.version} ${m.name} — already present, adopted`)
      }
    }

    for (const m of migrations) {
      const a = applied.get(m.version)
      if (a && a.checksum !== m.checksum) throw new Error(`${m.file} was changed after it was applied. Add a new migration instead.`)
    }

    const to = arg('to')
    for (const m of migrations) {
      if (applied.has(m.version)) continue
      if (to && m.version > to) break
      if (m.requiresBackup && !flag('skip-backup-check') && !recentBackupExists(t.endpoint, schema)) {
        throw new Error(`${m.file} requires a backup taken in the last 2 hours. Run scripts/db/backup.ts first.`)
      }
      const started = Date.now()
      log(`  ${m.version} ${m.name} — applying…`)
      await c.query('BEGIN')
      try {
        await c.query(`SET LOCAL search_path TO ${schema}`)
        await c.query(m.sql)
        await c.query(`INSERT INTO schema_migrations (version, name, checksum, method, execution_ms) VALUES ($1,$2,$3,'applied',$4)`,
          [m.version, m.name, m.checksum, Date.now() - started])
        await c.query('COMMIT')
        log(`  ${m.version} ${m.name} — applied in ${Date.now() - started} ms`)
      } catch (e) {
        await c.query('ROLLBACK')
        throw new Error(`${m.file} failed and was rolled back: ${e instanceof Error ? e.message : e}`)
      }
    }
    log('Up to date.')
  } finally {
    await c.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
