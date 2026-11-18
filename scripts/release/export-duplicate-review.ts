// Export the production duplicate-group decisions as an Excel sheet for the owner to review
// (read-only). Uses the same rules as prepare-article-duplicates.ts.
//
//   npx tsx scripts/release/export-duplicate-review.ts --env-file .env --file "<sparx workbook.xlsx>" [--out docs/release/production-duplicate-review.xlsx]

import ExcelJS from 'exceljs'
import pg from 'pg'
import { buildWorkbookModel, rowsFromSheet } from '../../lib/catalog/sparx-workbook'
import { arg, log, poolConfig, resolveTarget } from '../db/_connect'
import { decideDuplicates, loadDuplicateRows } from './_duplicates'

const ACTION_LABEL = { keep: 'Keep', merge: 'Archive, then remove', clear: 'Keep row, clear wrong code' } as const
const ACTION_FILL = { keep: 'FFE4F2E5', merge: 'FFF8E4E0', clear: 'FFFBF0DC' } as const

async function main() {
  const t = resolveTarget()
  const out = arg('out') || 'docs/release/production-duplicate-review.xlsx'
  const src = new ExcelJS.Workbook()
  await src.xlsx.readFile(arg('file')!)
  const cells: { rowNumber: number; values: unknown[] }[] = []
  src.getWorksheet('Articles')!.eachRow((row, n) => { const v: unknown[] = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value }); cells.push({ rowNumber: n, values: v }) })
  const model = buildWorkbookModel(rowsFromSheet(cells))
  const wbVariant = new Map(model.variants.map(v => [v.key, v]))
  const wbName = new Map(model.articles.map(a => [a.artCode, a.artName]))

  const pool = new pg.Pool(poolConfig(t, undefined, 1))
  const c = await pool.connect()
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  const rows = await loadDuplicateRows(c)
  c.release()
  await pool.end()
  const decisions = decideDuplicates(rows)

  const wb = new ExcelJS.Workbook()
  const sum = wb.addWorksheet('Summary')
  sum.columns = [{ width: 34 }, { width: 14 }, { width: 70 }]
  const counts = { keep: 0, merge: 0, clear: 0 }
  for (const d of decisions) counts[d.action]++
  sum.addRows([
    ['Production duplicate article rows — for review'],
    [`Database ${t.endpoint}, read ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Nothing has been changed.`],
    [],
    ['What happens', 'Rows', 'Meaning'],
    [ACTION_LABEL.keep, counts.keep, 'One row per group stays as the article. The catalogue import then gives it the approved name, colour and all sizes.'],
    [ACTION_LABEL.merge, counts.merge, 'Same product as the kept row. A full copy (row, sizes, colours) goes to article_duplicate_archive, then the row is removed.'],
    [ACTION_LABEL.clear, counts.clear, 'Another brand\'s row carrying a Sparx code by mistake. The row stays; only the wrong code is cleared (old value archived).'],
    [],
    ['Groups', new Set(rows.map(r => r.key)).size],
    ['Rows', rows.length],
    ['References to these rows', 0, 'No scans, stock or orders point at any of them.'],
    [],
    ['How to review', '', 'In the "Rows" sheet, write OK or CHANGE in "Your decision" and a note for anything to change.'],
  ])
  sum.getRow(1).font = { bold: true, size: 14 }
  sum.getRow(4).font = { bold: true }

  const ws = wb.addWorksheet('Rows', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [
    { header: 'Article code', key: 'code', width: 13 },
    { header: 'Colour code', key: 'colour', width: 11 },
    { header: 'Row id', key: 'id', width: 8 },
    { header: 'Name in database', key: 'name', width: 18 },
    { header: 'Colour in database', key: 'colourName', width: 22 },
    { header: 'Sizes in database', key: 'sizes', width: 20 },
    { header: 'What happens', key: 'action', width: 24 },
    { header: 'Why', key: 'why', width: 60 },
    { header: 'Approved workbook says', key: 'workbook', width: 42 },
    { header: 'Your decision (OK / CHANGE)', key: 'decision', width: 16 },
    { header: 'Your note', key: 'note', width: 30 },
  ]
  ws.getRow(1).font = { bold: true }
  ws.autoFilter = { from: 'A1', to: 'K1' }
  for (const d of decisions) {
    const [code, colour] = d.row.key.split('|')
    const v = wbVariant.get(d.row.key)
    const r = ws.addRow({
      code, colour, id: d.row.id, name: d.row.artName, colourName: d.row.color, sizes: d.row.sizes, action: ACTION_LABEL[d.action], why: d.reason,
      workbook: v ? `${wbName.get(code)} · ${v.displayColor} · ${v.sizes.map(s => s.label).join(' ')}` : 'not in the workbook',
    })
    r.getCell('action').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACTION_FILL[d.action] } }
    r.alignment = { vertical: 'top', wrapText: true }
  }
  await wb.xlsx.writeFile(out)
  log(`Written ${out}: ${decisions.length} rows (${counts.keep} keep, ${counts.merge} archive+remove, ${counts.clear} clear code)`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
