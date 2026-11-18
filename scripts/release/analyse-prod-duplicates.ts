// Read-only analysis of duplicate article code + colour code groups (they block the
// Feature 01 unique index in migration 0001) against the approved Sparx workbook.
//
//   npx tsx scripts/release/analyse-prod-duplicates.ts --env-file .env --file <sparx workbook.xlsx> [--out docs/release/duplicate-groups.md]

import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import ExcelJS from 'exceljs'
import { buildWorkbookModel, isSparxScope, rowsFromSheet, colourKey } from '../../lib/catalog/sparx-workbook'
import { arg, log, resolveTarget } from '../db/_connect'

const N = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase()

async function main() {
  const t = resolveTarget()
  const out = arg('out') || 'docs/release/duplicate-groups.md'
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(arg('file')!)
  const cells: { rowNumber: number; values: unknown[] }[] = []
  wb.getWorksheet('Articles')!.eachRow((row, n) => { const v: unknown[] = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value }); cells.push({ rowNumber: n, values: v }) })
  const model = buildWorkbookModel(rowsFromSheet(cells))
  const wbVariant = new Map(model.variants.map(v => [v.key, v]))
  const wbName = new Map(model.articles.map(a => [a.artCode, a.artName]))

  const c = new pg.Client({ connectionString: t.url, ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  const rows = (await c.query(`
    SELECT a.id, a."artName", a."artCode", a."colorCode", a.color, a."minSize", a."maxSize",
      (SELECT count(*) FROM article_sizes s WHERE s."articleId" = a.id)::int AS sizes,
      (SELECT string_agg(s."sizeLabel", ' ' ORDER BY s."sortOrder") FROM article_sizes s WHERE s."articleId" = a.id) AS labels
    FROM articles a
    WHERE btrim(a."artCode") <> '' AND btrim(a."colorCode") <> ''
      AND (upper(regexp_replace(btrim(a."artCode"), '\\s+', ' ', 'g')), upper(regexp_replace(btrim(a."colorCode"), '\\s+', ' ', 'g'))) IN (
        SELECT upper(regexp_replace(btrim("artCode"), '\\s+', ' ', 'g')), upper(regexp_replace(btrim("colorCode"), '\\s+', ' ', 'g'))
        FROM articles WHERE btrim("artCode") <> '' AND btrim("colorCode") <> '' GROUP BY 1, 2 HAVING count(*) > 1)
    ORDER BY upper(btrim(a."artCode")), upper(btrim(a."colorCode")), a.id`)).rows
  const refTables = (await c.query(`select to_regclass('scans') is not null as scans, to_regclass('order_items') is not null as oi`)).rows[0]
  const refs = {
    scans: refTables.scans ? Number((await c.query(`select count(*) from scans`)).rows[0].count) : 0,
    orderItems: refTables.oi ? Number((await c.query(`select count(*) from order_items`)).rows[0].count) : 0,
  }
  await c.end()

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = `${N(r.artCode)}|${N(r.colorCode)}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const cls: Record<string, number> = {}
  const L = ['# Duplicate article code + colour code groups', '', `Database \`${t.endpoint}\`, ${new Date().toISOString()}, read-only. Compared with the approved Sparx workbook (${model.stats.variants} variants).`, '']
  L.push(`${groups.size} groups, ${rows.length} rows. References that could point at a duplicate row: ${refs.scans} scans, ${refs.orderItems} order lines (order lines store text, not ids).`, '')
  L.push('| Code | Colour | Rows (id: name / colour / sizes) | Same name? | Same colour name? | Same sizes? | In workbook | Class |', '|---|---|---|---|---|---|---|---|')
  for (const [k, g] of groups) {
    const [code, colour] = k.split('|')
    const sameName = new Set(g.map(r => N(r.artName))).size === 1
    const sameColour = new Set(g.map(r => colourKey(r.color))).size === 1
    const sameSizes = new Set(g.map(r => r.labels ?? '')).size === 1
    const v = wbVariant.get(k)
    const scope = isSparxScope(code, g[0].artName)
    const klass = !scope ? 'other brand' : v ? (sameName && sameColour && sameSizes ? 'workbook · identical rows' : 'workbook · rows differ (workbook decides)') : (sameName && sameColour && sameSizes ? 'not in workbook · identical' : 'not in workbook · rows differ')
    cls[klass] = (cls[klass] ?? 0) + 1
    L.push(`| ${code} | ${colour} | ${g.map(r => `#${r.id}: ${r.artName} / ${r.color} / ${r.labels ?? '—'}`).join('<br>')} | ${sameName ? 'yes' : 'no'} | ${sameColour ? 'yes' : 'no'} | ${sameSizes ? 'yes' : 'no'} | ${v ? `${wbName.get(code)} / ${v.displayColor} / ${v.sizes.map(s => s.label).join(' ')}` : 'no'} | ${klass} |`)
  }
  L.splice(5, 0, '## Summary', '', ...Object.entries(cls).map(([k, n]) => `- ${k}: ${n} groups`), '')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, L.join('\n'))
  log(`${groups.size} groups, ${rows.length} rows; ${JSON.stringify(cls)}; refs ${JSON.stringify(refs)}`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
