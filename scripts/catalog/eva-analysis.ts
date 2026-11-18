// EVA price list + assortment workbook analysis (read-only; no database).
//
//   npx tsx scripts/catalog/eva-analysis.ts --assortments <eva assortment.xlsx>
//
// Writes docs/catalog/eva/price-list.csv, assortments.csv, analysis.json.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import ExcelJS from 'exceljs'
import { checkAssortments, candidateAssortments, codeToRange, parseAssortments, parsePriceList } from '../../lib/catalog/eva'
import { BOX_SAMPLES, CARTON_SAMPLES } from '../../tests/qr/corpus'
import { arg, log } from '../db/_connect'

const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const toCsv = (h: string[], rows: unknown[][]) => [h, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n'

async function main() {
  const file = arg('assortments')
  if (!file) throw new Error('Pass --assortments <eva assortment.xlsx>')
  const dir = 'docs/catalog/eva'
  const priceText = fs.readFileSync(`${dir}/eva-price-list-2026-08-01.txt`, 'utf8')
  const price = parsePriceList(priceText)

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.worksheets[0]
  const cells: { rowNumber: number; values: unknown[] }[] = []
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const v: unknown[] = []
    row.eachCell({ includeEmpty: true }, (c, i) => { const x = c.value as unknown; v[i - 1] = x && typeof x === 'object' && 'result' in (x as object) ? (x as { result: unknown }).result : x })
    cells.push({ rowNumber: n, values: v })
  })
  // Owner decisions on the sheet (kept here so the reason travels with the data).
  const IGNORED_ROWS: Record<number, string> = { 44: 'Owner, 18 Nov 2026: same as row 21 (Ladies 36/405); ignore.' }
  const parsed = parseAssortments(cells)
  const assort = parsed.filter(a => !(a.sheetRow in IGNORED_ROWS))
  const issues = checkAssortments(assort)

  // Price list facts
  const articles = [...new Set(price.map(p => p.article))]
  const packings: Record<string, number> = {}
  for (const p of price) packings[p.packing] = (packings[p.packing] ?? 0) + 1
  const ranges: Record<string, number> = {}
  for (const p of price) ranges[p.sizeRange] = (ranges[p.sizeRange] ?? 0) + 1
  const colourCount = price.reduce((m, p) => m.set(p.article, p.colours.length), new Map<string, number>())

  // Price-list rows vs assortments: which (packing, range) have no assortment at all?
  const coverage = price.map(p => ({ p, cands: candidateAssortments(p, assort) }))
  const uncovered = coverage.filter(c => !c.cands.length)
  const uncoveredKeys = [...new Set(uncovered.map(c => `${c.p.sizeRange} @ ${c.p.packing}`))]
  const exact = coverage.filter(c => c.cands.some(a => { const r = codeToRange(a.code)!; return r.from === c.p.sizeFrom && r.to === c.p.sizeTo }))

  // Flite labels in the QR corpus vs the price list (article number + size + MRP)
  const num = (code: string) => code.match(/\d+/)?.[0].replace(/^0+/, '') ?? ''
  const labelChecks: { label: string; code: string; sizes: string; mrp: number; matches: string[] }[] = []
  const seen = new Set<string>()
  for (const b of BOX_SAMPLES.filter(b => b.art.startsWith('FL'))) {
    const k = `${b.art}|${b.size}|${b.mrp}`
    if (seen.has(k)) continue
    seen.add(k)
    const m = price.filter(p => num(p.article) === num(b.art) && !p.article.includes('K') && Number(b.size) >= Math.min(p.sizeFrom, p.sizeTo) && Number(b.size) <= Math.max(p.sizeFrom, p.sizeTo))
    labelChecks.push({ label: 'box', code: b.art, sizes: b.size, mrp: b.mrp, matches: m.map(p => `${p.article} ${p.sizeRange} MRP ${p.mrp.toFixed(2)} pack ${p.packing}${p.mrp === b.mrp ? ' ✓' : ' ≠'}`) })
  }
  for (const c of CARTON_SAMPLES.filter(c => c.art.startsWith('FL'))) {
    const k = `${c.art}|${c.sizeFrom}-${c.sizeTo}|${c.mrp}`
    if (seen.has(k)) continue
    seen.add(k)
    const m = price.filter(p => num(p.article) === num(c.art) && !p.article.includes('K') && Number(c.sizeFrom) >= p.sizeFrom && Number(c.sizeTo) <= p.sizeTo)
    labelChecks.push({ label: 'carton', code: c.art, sizes: `${c.sizeFrom}-${c.sizeTo}`, mrp: c.mrp, matches: m.map(p => `${p.article} ${p.sizeRange} MRP ${p.mrp.toFixed(2)} pack ${p.packing}${p.mrp === c.mrp ? ' ✓' : ' ≠'}`) })
  }

  fs.writeFileSync(`${dir}/price-list.csv`, toCsv(['page', 'collection', 'article', 'colours', 'sizeRange', 'wsp', 'mrp', 'packingPerCarton'],
    price.map(p => [p.page, p.collection, p.article, p.colours.join('; '), p.sizeRange, p.wsp.toFixed(2), p.mrp.toFixed(2), p.packing])))
  const sizeCols = [...new Set(assort.flatMap(a => Object.keys(a.sizes)))]
  fs.writeFileSync(`${dir}/assortments.csv`, toCsv(['sheetRow', 'segment', 'rowLabel', 'packing', 'assortmentCode', ...sizeCols.map(s => `size_${s}`), 'total'],
    assort.map(a => [a.sheetRow, a.segment, a.rowLabel, a.packing, a.code, ...sizeCols.map(s => a.sizes[s] ?? ''), a.total])))
  const analysis = {
    sources: {
      priceList: { file: 'EVA.pdf (transcribed)', rows: price.length, articles: articles.length, sha256: crypto.createHash('sha256').update(priceText).digest('hex') },
      assortments: { file: path.basename(file), rows: assort.length, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') },
    },
    priceList: {
      collections: [...new Set(price.map(p => p.collection))], packings, ranges,
      articlesWithSeveralSizeRows: articles.filter(a => price.filter(p => p.article === a).length > 1).length,
      articlesWithDifferentPackingBySize: articles.filter(a => new Set(price.filter(p => p.article === a).map(p => p.packing)).size > 1),
      colourNamesPerArticle: { min: Math.min(...colourCount.values()), max: Math.max(...colourCount.values()) },
    },
    assortments: { ignoredRows: IGNORED_ROWS, bySegment: assort.reduce((m, a) => ({ ...m, [a.segment]: (m[a.segment] ?? 0) + 1 }), {} as Record<string, number>), issues },
    coverage: { rows: price.length, withAnyAssortment: price.length - uncovered.length, withFullRangeAssortment: exact.length, uncoveredRangePackings: uncoveredKeys },
    labelChecks,
  }
  fs.writeFileSync(`${dir}/analysis.json`, JSON.stringify(analysis, null, 2))
  log(JSON.stringify(analysis, null, 2))
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
