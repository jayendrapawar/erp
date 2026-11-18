// Carton assortments from the command line.
//
// 1. Convert the Flite EVA assortment workbook (owner's layout) into the upload format:
//      npx tsx scripts/catalog/import-assortments.ts --from-eva "<eva assortment.xlsx>" --write docs/catalog/eva/flite-eva-assortments.xlsx
// 2. Load an upload-format workbook (same rules as Master → Assortments → Upload Excel):
//      npx tsx scripts/catalog/import-assortments.ts --file <upload.xlsx> --env-file .env.local            (dry run)
//      npx tsx scripts/catalog/import-assortments.ts --file <upload.xlsx> --env-file .env.local --apply --confirm <endpoint> [--actor-name "…"]

import path from 'node:path'
import ExcelJS from 'exceljs'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '../../lib/db/schema'
import type { Db } from '../../lib/db/types'
import { parseAssortments } from '../../lib/catalog/eva'
import { DIVISIONS, SEGMENTS, formatSizes, parseAssortmentSheet, validateAssortment } from '../../lib/catalog/assortments'
import { buildAssortmentWorkbook, sheetCells, type ExportRow } from '../../lib/catalog/assortment-excel'
import { applyUpload, previewUpload } from '../../lib/catalog/assortment-store'
import { arg, flag, log, poolConfig, requireWriteConfirmation, resolveTarget } from '../db/_connect'

/** Owner decisions on the EVA sheet (same list as scripts/catalog/eva-analysis.ts). */
const EVA_IGNORED_ROWS: Record<number, string> = { 44: 'Owner, 18 Nov 2026: same as row 21 (Ladies 36/405); ignore.' }

async function convertEva(file: string, out: string) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.worksheets[0]
  const cells: { rowNumber: number; values: unknown[] }[] = []
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const v: unknown[] = []
    row.eachCell({ includeEmpty: true }, (c, i) => { const x = c.value as unknown; v[i - 1] = x && typeof x === 'object' && 'result' in (x as object) ? (x as { result: unknown }).result : x })
    cells.push({ rowNumber: n, values: v })
  })
  const rows: ExportRow[] = []
  for (const a of parseAssortments(cells)) {
    if (a.sheetRow in EVA_IGNORED_ROWS) { log(`  skip row ${a.sheetRow}: ${EVA_IGNORED_ROWS[a.sheetRow]}`); continue }
    const segment = SEGMENTS.find(s => s.toUpperCase() === a.segment)!
    const v = validateAssortment({ division: 'Flite EVA', segment, packing: a.packing, code: a.code, sizes: Object.entries(a.sizes).map(([size, pairs]) => ({ size, pairs })), note: `EVA sheet row ${a.sheetRow}` })
    if (v.errors.length) throw new Error(`EVA row ${a.sheetRow}: ${v.errors.join(' ')}`)
    rows.push(v.value)
  }
  await buildAssortmentWorkbook(rows, DIVISIONS).xlsx.writeFile(out)
  log(`Written ${out}: ${rows.length} Flite EVA assortments`)
}

async function load(file: string) {
  const t = resolveTarget()
  const apply = flag('apply')
  if (apply) requireWriteConfirmation(t)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const parsed = parseAssortmentSheet(sheetCells(wb) ?? [])
  if (parsed.errors.length) throw new Error(parsed.errors.join('\n'))
  const pool = new pg.Pool(poolConfig(t, arg('schema') || undefined, 1))
  try {
    const db = drizzle(pool, { schema }) as unknown as Db
    const lines = await previewUpload(db, parsed.rows)
    for (const l of lines) {
      log(`  row ${String(l.row).padStart(3)} ${l.status.padEnd(7)} ${l.value.division} · ${l.value.segment} · ${l.value.packing} · ${l.value.code}  ${formatSizes(l.value.sizes)}${l.errors.length ? `  ✗ ${l.errors.join(' ')}` : ''}${l.warnings.length ? `  ! ${l.warnings.join(' ')}` : ''}`)
    }
    const n = (s: string) => lines.filter(l => l.status === s).length
    log(`${t.endpoint}: ${lines.length} rows — ${n('new')} new, ${n('changed')} new version, ${n('same')} no change, ${n('error')} errors`)
    if (!apply) { log('Dry run only. Nothing written.'); return }
    const res = await applyUpload(db, { id: null, name: arg('actor-name') || 'assortment script' }, parsed.rows, path.basename(file))
    log(`Applied: ${JSON.stringify(res)}`)
  } finally {
    await pool.end()
  }
}

async function main() {
  const eva = arg('from-eva')
  if (eva) return convertEva(eva, arg('write') || 'docs/catalog/eva/flite-eva-assortments.xlsx')
  const file = arg('file')
  if (!file) throw new Error('Pass --from-eva <eva assortment.xlsx> or --file <upload.xlsx>')
  return load(file)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
