// Fill the HSN of articles that have none, from docs/catalog/relaxo-invoice-hsn.json (article code →
// HSN as printed on Relaxo's proforma invoices). Never overwrites an HSN already set (by hand in
// Master → Articles or from an imported bill). Codes printed with two HSNs are skipped and listed.
// Needs migration 0016 (articles.hsn).
//
//   Preview (read-only):
//     npx tsx scripts/catalog/fill-hsn.ts --env-file .env.local
//   Apply (one transaction, 2 statements; needs a backup from the last 2 hours):
//     npx tsx scripts/catalog/fill-hsn.ts --env-file .env.local --apply --confirm <endpoint>
//   --file <json> uses another list of the same shape.

import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { arg, flag, log, poolConfig, recentBackupExists, requireWriteConfirmation, resolveTarget } from '../db/_connect'

interface HsnFile { source: string; codes: Record<string, string>; twoHsn: Record<string, Array<{ hsn: string; pairs: number; last: string }>> }

async function main() {
  const file = arg('file') || path.join('docs', 'catalog', 'relaxo-invoice-hsn.json')
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as HsnFile
  const entries = Object.entries(list.codes).map(([c, h]) => [c.trim().toUpperCase(), String(h).trim()] as const)
  const bad = entries.filter(([, h]) => !/^\d{4,8}$/.test(h))
  if (bad.length) throw new Error(`Not an HSN: ${bad.slice(0, 5).map(([c, h]) => `${c}=${h}`).join(', ')}`)
  const codes = entries.map(([c]) => c), hsns = entries.map(([, h]) => h)

  const t = resolveTarget()
  const apply = flag('apply')
  if (apply) {
    requireWriteConfirmation(t)
    if (!recentBackupExists(t.endpoint, 'public')) throw new Error(`No backup of ${t.endpoint} from the last 2 hours. Run npm run db:backup first.`)
  }
  log(`Target ${t.endpoint}. ${list.source}`)
  log(`List: ${codes.length} codes with one HSN; ${Object.keys(list.twoHsn).length} with two (skipped).`)

  const pool = new pg.Pool(poolConfig(t))
  try {
    // 1 query: what the fill would do.
    const p = (await pool.query<{ rows: string; filled: string; to_fill: string; to_fill_codes: string; differ: string; differ_eg: string | null }>(`
      WITH l AS (SELECT * FROM unnest($1::text[], $2::text[]) AS x(code, hsn))
      SELECT count(*) AS rows,
             count(*) FILTER (WHERE a.hsn <> '') AS filled,
             count(*) FILTER (WHERE a.hsn = '' AND l.hsn IS NOT NULL) AS to_fill,
             count(DISTINCT l.code) FILTER (WHERE a.hsn = '' AND l.hsn IS NOT NULL) AS to_fill_codes,
             count(*) FILTER (WHERE a.hsn <> '' AND l.hsn IS NOT NULL AND a.hsn <> l.hsn) AS differ,
             string_agg(DISTINCT CASE WHEN a.hsn <> '' AND l.hsn IS NOT NULL AND a.hsn <> l.hsn THEN l.code || ' ' || a.hsn || '≠' || l.hsn END, ', ') AS differ_eg
      FROM articles a LEFT JOIN l ON l.code = upper(btrim(a."artCode"))
      WHERE btrim(a."artCode") <> ''`, [codes, hsns])).rows[0]
    log(`Articles with a code: ${p.rows} · HSN already set ${p.filled} · will be filled ${p.to_fill} (${p.to_fill_codes} codes)`)
    if (Number(p.differ)) log(`Already set but different from the invoices (left as they are): ${p.differ} — ${p.differ_eg}`)
    const two = Object.entries(list.twoHsn)
    if (two.length) log(`Two HSNs on the invoices, not filled: ${two.map(([c, o]) => `${c} (${o.map((x) => x.hsn).join(' / ')})`).join(', ')}`)
    if (!apply) { log('Preview only. Nothing written.'); return }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const r = await client.query(`
        UPDATE articles a SET hsn = l.hsn
        FROM unnest($1::text[], $2::text[]) AS l(code, hsn)
        WHERE upper(btrim(a."artCode")) = l.code AND a.hsn = ''`, [codes, hsns])
      await client.query(`
        INSERT INTO audit_events ("actorUserId", "actorName", action, "entityType", "entityId", after)
        VALUES (NULL, 'HSN from proforma invoices (script)', 'articles.hsn_filled', 'article', 'many', $1::jsonb)`,
        [JSON.stringify({ rows: r.rowCount, codesInList: codes.length, source: list.source })])
      await client.query('COMMIT')
      log(`Applied: HSN filled on ${r.rowCount} article rows.`)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
