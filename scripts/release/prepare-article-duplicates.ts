// Release step (production, BEFORE migration 0001): resolve duplicate article code + colour
// code groups so 0001's unique index can be created. Dry run by default.
//
//   npx tsx scripts/release/prepare-article-duplicates.ts --env-file .env [--schema <name>]
//   npx tsx scripts/release/prepare-article-duplicates.ts --env-file .env --apply --confirm <endpoint> [--actor-name "<name>"]
//
// Works on the pre-0001 schema (only id, names, codes, sizes, colours are used).
//
// Per group (same normalised artCode + colorCode):
//   - Sparx rows (article name family SS-, SFG-, SM- …): keep the LOWEST id. The catalogue import
//     then gives it the approved name, colour and full size set. Every other Sparx row is
//     ARCHIVED (row + sizes + colours as JSON, with the kept id) and then removed.
//   - Rows of other brands that carry the code by mistake (e.g. PUG-162 with SC0162G) are KEPT;
//     only their wrong codes are cleared, after archiving the original values.
//   - A group with no Sparx row at all: codes are cleared on every row (nobody guesses which
//     product owns the code); an admin re-enters the right one.
// Refuses to remove a row that anything references (scans, scan events, stock, order lines).
// One transaction; re-checks that no duplicate group remains before committing.

import pg from 'pg'
import { arg, flag, log, poolConfig, recentBackupExists, requireWriteConfirmation, resolveTarget } from '../db/_connect'
import { NORM, decideDuplicates, loadDuplicateRows, type DupRow as Row } from './_duplicates'

const ARCHIVE_DDL = `
CREATE TABLE IF NOT EXISTS article_duplicate_archive (
  id               serial PRIMARY KEY,
  "articleId"      integer NOT NULL,
  action           text NOT NULL CHECK (action IN ('merged', 'codes_cleared')),
  "keptArticleId"  integer,
  "row"            jsonb NOT NULL,
  sizes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  colours          jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason           text NOT NULL,
  "archivedBy"     text NOT NULL DEFAULT '',
  "archivedAt"     timestamptz NOT NULL DEFAULT now()
)`

async function main() {
  const t = resolveTarget()
  const schema = arg('schema') || undefined
  const apply = flag('apply')
  if (apply) {
    requireWriteConfirmation(t)
    if (!flag('skip-backup-check') && !recentBackupExists(t.endpoint, schema ?? 'public')) throw new Error('Needs a backup taken in the last 2 hours.')
  }
  const actorName = arg('actor-name') || 'release script'
  const pool = new pg.Pool(poolConfig(t, schema, 1))
  const c = await pool.connect()
  try {
    const rows = await loadDuplicateRows(c)
    const decisions = decideDuplicates(rows)
    const merge: { row: Row; keep: number }[] = decisions.filter(d => d.action === 'merge').map(d => ({ row: d.row, keep: d.keep! }))
    const clear: { row: Row; reason: string }[] = decisions.filter(d => d.action === 'clear').map(d => ({ row: d.row, reason: d.reason }))
    const groups = new Set(rows.map(r => r.key)).size
    log(`${t.endpoint}${schema ? ` schema ${schema}` : ''}: ${groups} duplicate groups, ${rows.length} rows → keep ${decisions.filter(d => d.action === 'keep').length} Sparx rows, archive+remove ${merge.length}, clear codes on ${clear.length}`)
    for (const m of merge) log(`  merge  #${m.row.id} ${m.row.artName} ${m.row.key} ${m.row.color} → kept #${m.keep}`)
    for (const x of clear) log(`  clear  #${x.row.id} ${x.row.artName} ${x.row.key} — ${x.reason}`)
    if (!apply) { log('Dry run only. Nothing written.'); return }

    await c.query('BEGIN')
    await c.query(`SET LOCAL lock_timeout = '10s'`)
    // References that would make removal unsafe (tables that exist in this schema only).
    const has = async (tname: string) => (await c.query(`select to_regclass($1) is not null as ok`, [tname])).rows[0].ok as boolean
    const ids = merge.map(m => m.row.id)
    if (ids.length) {
      const checks: string[] = []
      if (await has('scan_events')) checks.push(`SELECT 'scan_events' t FROM scan_events WHERE "articleId" = ANY($1::int[])`)
      if (await has('stock_movements')) checks.push(`SELECT 'stock_movements' FROM stock_movements m JOIN article_sizes s ON s.id = m."skuId" WHERE s."articleId" = ANY($1::int[])`)
      if (await has('article_scan_links')) checks.push(`SELECT 'article_scan_links' FROM article_scan_links WHERE "articleId" = ANY($1::int[])`)
      if (checks.length) {
        const used = await c.query(`${checks.join(' UNION ALL ')} LIMIT 1`, [ids])
        if (used.rows.length) throw new Error(`Refusing: a row to be removed is referenced by ${used.rows[0].t}.`)
      }
    }
    await c.query(ARCHIVE_DDL)
    const archive = async (row: Row, action: 'merged' | 'codes_cleared', keep: number | null, reason: string) => {
      await c.query(`
        INSERT INTO article_duplicate_archive ("articleId", action, "keptArticleId", "row", sizes, colours, reason, "archivedBy")
        SELECT a.id, $2, $3, to_jsonb(a),
          coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s."sortOrder") FROM article_sizes s WHERE s."articleId" = a.id), '[]'::jsonb),
          coalesce((SELECT jsonb_agg(to_jsonb(k)) FROM article_colors k WHERE k."articleId" = a.id), '[]'::jsonb),
          $4, $5
        FROM articles a WHERE a.id = $1`, [row.id, action, keep, reason, actorName])
    }
    for (const m of merge) await archive(m.row, 'merged', m.keep, `Duplicate of #${m.keep} (same article code + colour code).`)
    for (const x of clear) await archive(x.row, 'codes_cleared', null, x.reason)
    if (ids.length) {
      await c.query(`DELETE FROM article_sizes WHERE "articleId" = ANY($1::int[])`, [ids])
      await c.query(`DELETE FROM article_colors WHERE "articleId" = ANY($1::int[])`, [ids])
      await c.query(`DELETE FROM articles WHERE id = ANY($1::int[])`, [ids])
    }
    if (clear.length) await c.query(`UPDATE articles SET "artCode" = '', "colorCode" = '' WHERE id = ANY($1::int[])`, [clear.map(x => x.row.id)])
    const left = Number((await c.query(`SELECT count(*) FROM (SELECT 1 FROM articles WHERE btrim("artCode") <> '' AND btrim("colorCode") <> '' GROUP BY ${NORM('"artCode"')}, ${NORM('"colorCode"')} HAVING count(*) > 1) d`)).rows[0].count)
    const archived = Number((await c.query(`SELECT count(*) FROM article_duplicate_archive`)).rows[0].count)
    if (left !== 0) throw new Error(`${left} duplicate group(s) remain; rolled back.`)
    await c.query('COMMIT')
    log(`Done: ${merge.length} rows archived and removed, ${clear.length} rows had codes cleared; ${archived} archive rows in total; 0 duplicate groups remain.`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    c.release()
    await pool.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
