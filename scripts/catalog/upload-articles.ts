// Load an article list workbook the same way Master → Articles → Upload does (add-only).
//
//   Preview (read-only):
//     npx tsx scripts/catalog/upload-articles.ts --file <list.xlsx> --env-file .env.local
//   Apply (one transaction; needs a backup from the last 2 hours):
//     npx tsx scripts/catalog/upload-articles.ts --file <list.xlsx> --env-file .env.local --apply --confirm <endpoint> [--actor <user email>]
//   --skip-name "<artName>" leaves out rows with that article name (e.g. test articles).

import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../../lib/db/schema'
import type { Actor, Db } from '../../lib/db/types'
import { applyArticleUpload, parseArticleSheet, planArticleUpload, summarise, xlsxToCells } from '../../lib/catalog/article-upload'
import { arg, flag, log, poolConfig, recentBackupExists, requireWriteConfirmation, resolveTarget } from '../db/_connect'

async function main() {
  const file = arg('file')
  if (!file) throw new Error('Pass --file <workbook.xlsx>.')
  const t = resolveTarget()
  const apply = flag('apply')
  if (apply) {
    requireWriteConfirmation(t)
    if (!recentBackupExists(t.endpoint, 'public')) throw new Error(`No backup of ${t.endpoint} from the last 2 hours. Run npm run db:backup first.`)
  }
  const buf = fs.readFileSync(file)
  const parsed = parseArticleSheet(await xlsxToCells(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer))
  if (parsed.missingColumns.length) throw new Error(`Missing column(s): ${parsed.missingColumns.join(', ')}`)
  const skip = arg('skip-name')
  if (skip) {
    const before = parsed.rows.length
    parsed.rows = parsed.rows.filter((r) => r.artName.toUpperCase() !== skip.toUpperCase())
    log(`Left out ${before - parsed.rows.length} row(s) named "${skip}".`)
  }
  log(`Target ${t.endpoint}. File ${path.basename(file)}.`)
  const pool = new pg.Pool(poolConfig(t))
  const db = drizzle(pool, { schema }) as unknown as Db
  try {
    const plan = await planArticleUpload(db, parsed.rows)
    const s = summarise(parsed, plan)
    log(`Rows read ${s.rowsRead}, article codes ${s.articleCodes}`)
    log(`New with colour code ${s.added}; new without colour code ${s.addedPending}; colour codes filled ${s.filled}; already in master ${s.alreadyThere}; unreadable rows ${s.problems.length}`)
    const byDivision = new Map<string, number>()
    for (const v of [...plan.add, ...plan.addPending]) byDivision.set(v.division ?? '(none)', (byDivision.get(v.division ?? '(none)') ?? 0) + 1)
    log(`New by division: ${[...byDivision].map(([d, n]) => `${d} ${n}`).join(', ')}`)
    for (const p of s.problems.slice(0, 30)) log(`  ${p.message}`)
    if (!apply) { log('Preview only. Nothing written.'); return }
    let actor: Actor = { id: null, name: 'Article list upload (script)' }
    const email = arg('actor')
    if (email) {
      const u = (await db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM "user" WHERE email = ${email}`)).rows[0]
      if (!u) throw new Error(`No user ${email}`)
      actor = { id: u.id, name: u.name }
    }
    const res = await applyArticleUpload(db, actor, plan, { fileName: path.basename(file), rowsRead: s.rowsRead })
    log(`Applied. Waiting box scans moved into stock: ${res.resolvedScans}.`)
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
