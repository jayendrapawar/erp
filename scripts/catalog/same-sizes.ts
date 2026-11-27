// Same sizes in every colour of an article (owner, 24 Nov 2026): for each article code, the colour with
// the MOST sizes sets the sizes of all its other active colours. Mirrors Master → Articles "edit sizes"
// (app/actions/articles.ts saveArticle/syncSizes): missing SKUs are added (or switched back on), sizes not
// in the chosen set are switched off (never deleted), articles.minSize/maxSize follow, catalogue ranges
// that no longer fit are switched off, one audit event per colour.
//
// Never guessed:
//   - two different size sets tied for the most sizes and the most colours → article left as it is, listed;
//   - a size that would be switched off but has stock, scans, bill scans or order lines → that colour left
//     as it is, listed.
//
//   Preview (read-only):
//     npx tsx scripts/catalog/same-sizes.ts --env-file .env.local [--report out.json]
//   Apply (one transaction; needs a backup from the last 2 hours):
//     npx tsx scripts/catalog/same-sizes.ts --env-file .env.local --apply --confirm <endpoint> [--report out.json]

import fs from 'node:fs'
import pg from 'pg'
import { arg, flag, log, poolConfig, recentBackupExists, requireWriteConfirmation, resolveTarget } from '../db/_connect'
import { expandSizeRange, sizeSortOrders, sortSizes } from '../../lib/catalog/sizes'

interface Variant { id: number; code: string; name: string; color: string; colorCode: string; minSize: string; maxSize: string; sizes: string[] | null }
interface Change { id: number; code: string; name: string; color: string; colorCode: string; from: string[]; to: string[]; add: string[]; remove: string[] }
interface Skip { code: string; name: string; reason: string; colours?: string }

const key = (s: string[]) => s.join(',')
const rangeText = (s: string[]) => (s.length ? (s.length === 1 ? s[0] : `${s[0]}–${s[s.length - 1]}`) + (isRun(s) ? '' : ` (${s.join(',')})`) : '(none)')
/** true when the sizes are one unbroken run (6,7,8 or 11,12,13,1,2). */
function isRun(s: string[]): boolean {
  if (s.length < 2) return true
  const r = expandSizeRange(s[0], s[s.length - 1])
  return r.ok && key(r.sizes) === key(s)
}
const colourLabel = (v: { color: string; colorCode: string }) => [v.colorCode, v.color].filter(Boolean).join(' ') || '(no colour)'

async function main() {
  const t = resolveTarget()
  const apply = flag('apply')
  const reportFile = arg('report')
  if (apply) {
    requireWriteConfirmation(t)
    if (!recentBackupExists(t.endpoint, 'public')) throw new Error(`No backup of ${t.endpoint} from the last 2 hours. Run npm run db:backup first.`)
  }
  log(`Target ${t.endpoint}.`)
  const pool = new pg.Pool(poolConfig(t))
  try {
    // 1 query: active colours with their active sizes (SKUs) in size order.
    const vars = (await pool.query<Variant>(`
      SELECT a.id, upper(btrim(a."artCode")) AS code, a."artName" AS name, a.color, a."colorCode", a."minSize", a."maxSize",
             (SELECT array_agg(s."sizeLabel" ORDER BY s."sortOrder") FROM article_sizes s WHERE s."articleId" = a.id AND s.active) AS sizes
      FROM articles a
      WHERE a.active AND btrim(a."artCode") <> ''`)).rows
    let fromRange = 0
    const byCode = new Map<string, Array<Variant & { set: string[] }>>()
    for (const v of vars) {
      let set = sortSizes(v.sizes ?? [])
      if (!set.length) { const r = expandSizeRange(v.minSize, v.maxSize); if (r.ok) { set = r.sizes; fromRange++ } }
      byCode.set(v.code, [...(byCode.get(v.code) ?? []), { ...v, set }])
    }

    const changes: Change[] = [], skips: Skip[] = []
    let differing = 0
    for (const [code, vs] of byCode) {
      if (vs.length < 2 || new Set(vs.map((v) => key(v.set))).size < 2) continue
      differing++
      const most = Math.max(...vs.map((v) => v.set.length))
      const tally = new Map<string, { set: string[]; n: number }>()
      for (const v of vs) if (v.set.length === most) { const k = key(v.set); tally.set(k, { set: v.set, n: (tally.get(k)?.n ?? 0) + 1 }) }
      const ranked = [...tally.values()].sort((a, b) => b.n - a.n)
      if (ranked.length > 1 && ranked[0].n === ranked[1].n) {
        skips.push({ code, name: vs[0].name, reason: `Tie: ${ranked.filter((r) => r.n === ranked[0].n).map((r) => `${rangeText(r.set)} ×${r.n}`).join(' vs ')}`, colours: vs.map((v) => `${colourLabel(v)}: ${rangeText(v.set)}`).join(' · ') })
        continue
      }
      const target = ranked[0].set
      for (const v of vs) {
        if (key(v.set) === key(target)) continue
        changes.push({ id: v.id, code, name: v.name, color: v.color, colorCode: v.colorCode, from: v.set, to: target, add: target.filter((s) => !v.set.includes(s)), remove: v.set.filter((s) => !target.includes(s)) })
      }
    }

    // 1 query: sizes that would be switched off but are in use (stock, scans, bill scans, order lines).
    const removals = changes.flatMap((c) => c.remove.map((size) => ({ id: c.id, size })))
    const used = new Set<string>()
    if (removals.length) {
      const r = await pool.query<{ id: number; size: string }>(`
        WITH x AS (SELECT * FROM json_to_recordset($1::json) AS x(id int, size text)),
        sku AS (SELECT x.id, x.size, s.id AS sku FROM x JOIN article_sizes s ON s."articleId" = x.id AND s."sizeLabel" = x.size)
        SELECT DISTINCT x.id, x.size FROM x JOIN articles a ON a.id = x.id
        WHERE EXISTS (SELECT 1 FROM sku WHERE sku.id = x.id AND sku.size = x.size AND (
                 EXISTS (SELECT 1 FROM stock_movements m WHERE m."skuId" = sku.sku)
              OR EXISTS (SELECT 1 FROM stock_balances b WHERE b."skuId" = sku.sku)
              OR EXISTS (SELECT 1 FROM scan_events e WHERE e."skuId" = sku.sku)
              OR EXISTS (SELECT 1 FROM bill_scans bs WHERE bs."skuId" = sku.sku)))
           OR EXISTS (SELECT 1 FROM order_items oi
                      WHERE btrim(oi."sizeNumber") = x.size
                        AND (upper(btrim(oi."artCode")) = upper(btrim(a."artCode"))
                             OR (oi."artCode" IS NULL AND upper(btrim(oi."artNumber")) = upper(btrim(a."artName"))))
                        AND upper(btrim(coalesce(oi."colorNumber", ''))) IN (upper(btrim(a.color)), upper(btrim(a."colorCode"))))`,
        [JSON.stringify(removals)])
      for (const row of r.rows) used.add(`${row.id}|${row.size}`)
    }
    const blocked = changes.filter((c) => c.remove.some((s) => used.has(`${c.id}|${s}`)))
    for (const c of blocked) skips.push({ code: c.code, name: c.name, reason: `Colour ${colourLabel(c)} kept at ${rangeText(c.from)}: size ${c.remove.filter((s) => used.has(`${c.id}|${s}`)).join(', ')} has stock, scans or orders (would become ${rangeText(c.to)})` })
    const todo = changes.filter((c) => !blocked.includes(c))

    log(`Active colours ${vars.length} (sizes taken from the range for ${fromRange} with no size rows) · article codes ${byCode.size} · codes whose colours differ ${differing}`)
    log(`Will change ${todo.length} colours of ${new Set(todo.map((c) => c.code)).size} articles · sizes added ${todo.reduce((n, c) => n + c.add.length, 0)}, switched off ${todo.reduce((n, c) => n + c.remove.length, 0)}`)
    log(`Left as they are: ${skips.filter((s) => s.reason.startsWith('Tie')).length} tied articles, ${blocked.length} colours with a size in use`)
    for (const c of todo.slice(0, 8)) log(`  ${c.code} ${colourLabel(c)}: ${rangeText(c.from)} → ${rangeText(c.to)}`)
    if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ endpoint: t.endpoint, applied: apply, changes: todo, skips }, null, 1))
    if (!apply) { log('Preview only. Nothing written.'); return }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const payload = JSON.stringify(todo.map((c) => {
        const order = sizeSortOrders(c.to)
        return { id: c.id, to: c.to, orders: c.to.map((s) => order.get(s)!), min: c.to[0], max: c.to[c.to.length - 1], from: c.from }
      }))
      // SKUs: add missing, switch on / re-sort the chosen sizes, switch off the rest.
      const added = await client.query(`
        WITH x AS (SELECT p.id, s.size, s.ord FROM json_to_recordset($1::json) AS p(id int, "to" json, orders json),
                     LATERAL (SELECT t.value AS size, (o.value)::int AS ord FROM json_array_elements_text(p."to") WITH ORDINALITY t(value, i)
                              JOIN json_array_elements_text(p.orders) WITH ORDINALITY o(value, j) ON o.j = t.i) s)
        INSERT INTO article_sizes ("articleId", "sizeLabel", "sortOrder")
        SELECT id, size, ord FROM x
        ON CONFLICT ("articleId", "sizeLabel") DO UPDATE SET active = true, "sortOrder" = EXCLUDED."sortOrder"`, [payload])
      const off = await client.query(`
        UPDATE article_sizes s SET active = false
        FROM json_to_recordset($1::json) AS p(id int, "to" json)
        WHERE s."articleId" = p.id AND s.active
          AND s."sizeLabel" NOT IN (SELECT json_array_elements_text(p."to"))`, [payload])
      await client.query(`
        UPDATE articles a SET "minSize" = p.min, "maxSize" = p.max
        FROM json_to_recordset($1::json) AS p(id int, min text, max text) WHERE a.id = p.id`, [payload])
      const ranges = await client.query(`
        UPDATE article_size_ranges r SET active = false
        FROM json_to_recordset($1::json) AS p(id int, "to" json)
        WHERE r."articleId" = p.id AND r.active AND NOT (r.sizes <@ ARRAY(SELECT json_array_elements_text(p."to")))`, [payload])
      await client.query(`
        INSERT INTO audit_events ("actorUserId", "actorName", action, "entityType", "entityId", before, after, reason)
        SELECT NULL, 'Same sizes in all colours (script)', 'article.sizes_aligned', 'article', p.id::text,
               json_build_object('sizes', p."from")::jsonb, json_build_object('sizes', p."to", 'minSize', p.min, 'maxSize', p.max)::jsonb,
               'Owner 24 Nov 2026: all colours of an article get the sizes of the colour with the most sizes'
        FROM json_to_recordset($1::json) AS p(id int, "to" json, "from" json, min text, max text)`, [payload])
      await client.query('COMMIT')
      log(`Applied: ${todo.length} colours · size rows set (added, switched on or re-sorted) ${added.rowCount}, switched off ${off.rowCount} · catalogue ranges switched off ${ranges.rowCount}.`)
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
