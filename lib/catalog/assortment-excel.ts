// Excel side of carton assortments (server / scripts only): the upload format as a workbook,
// and reading an uploaded workbook into rows for parseAssortmentSheet.

import ExcelJS from 'exceljs'
import type { AssortmentSize } from '@/lib/db/schema'
import { ASSORTMENT_SEGMENTS, HEADERS, SHEET_NAME, SIZE_COLUMNS } from './assortments'

export interface ExportRow { division: string; segment: string; packing: number; code: string; sizes: AssortmentSize[]; note?: string; onlyFor?: string }

export function buildAssortmentWorkbook(rows: ExportRow[], divisions: readonly string[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = HEADERS.map(h => ({ header: h, key: h, width: h === 'Note' || h === 'Only for articles' ? 30 : h.length > 3 ? Math.max(12, h.length + 2) : 6 }))
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }
  for (const a of rows) {
    const bySize = new Map(a.sizes.map(s => [s.size, s.pairs]))
    ws.addRow([a.division, a.segment, a.packing, a.code, ...SIZE_COLUMNS.map(s => bySize.get(s) ?? null), null, a.note || null, a.onlyFor ? a.onlyFor.split(',').join(', ') : null])
  }
  // Total = sum of the size columns (with its value cached), so a typing mistake shows at once in Excel.
  const first = 5, last = first + SIZE_COLUMNS.length - 1
  const L = (n: number) => ws.getColumn(n).letter
  const lastRow = Math.max(rows.length + 1, 200)
  for (let r = 2; r <= lastRow; r++) {
    const a = rows[r - 2]
    const result = a ? a.sizes.reduce((n, s) => n + s.pairs, 0) : undefined
    ws.getCell(r, last + 1).value = { formula: `IF(COUNT(${L(first)}${r}:${L(last)}${r})=0,"",SUM(${L(first)}${r}:${L(last)}${r}))`, ...(result != null ? { result } : {}) } as ExcelJS.CellFormulaValue
    ws.getCell(r, 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${divisions.join(',')}"`] }
    ws.getCell(r, 2).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${ASSORTMENT_SEGMENTS.join(',')}"`] }
  }

  const help = wb.addWorksheet('How to fill')
  help.columns = [{ width: 22 }, { width: 90 }]
  help.addRows([
    ['Carton assortments — upload format'],
    [],
    ['One row', 'One carton assortment: how many pairs of each size one carton holds.'],
    ['Division', `One of: ${divisions.join(', ')}.`],
    ['Segment', `One of: ${ASSORTMENT_SEGMENTS.join(', ')}. "Any" = for every segment (an article's own segment wins over Any).`],
    ['Pairs per carton', 'Total pairs in the carton (packing), e.g. 30.'],
    ['Assortment code', 'As printed, e.g. 608 = sizes 6–8, 1101 = sizes 11, 12, 13, 1. Filled sizes must lie inside the code\'s range.'],
    ['1 … 13', 'Pairs of that size. Leave blank when the carton has none.'],
    ['Total', 'Filled in by Excel. Must equal Pairs per carton.'],
    ['Note', 'Optional.'],
    ['Only for articles', 'Optional. Article codes this assortment is only for, e.g. HC003G, TR002G, or a code family ending in *, e.g. PUB* = every PUB… article. Blank = any article of the division. The most specific wins: a listed code over a family over blank. A note like "Hawaii only: HC003G, TR002G" is read the same way. For another article with the same pairs the app asks whether to use this assortment for it too or to enter a new one.'],
    [],
    ['What the upload does', 'New rows are added. Rows whose division + segment + pairs + code + only-for articles already exist and whose sizes differ become a new version (the old one is kept as history). Identical rows are skipped. Assortments not in the file are not touched — remove them on the screen.'],
    ['Errors', 'If any row has an error, nothing is saved; the screen lists every problem with its row number.'],
  ])
  help.getRow(1).font = { bold: true, size: 14 }
  help.getColumn(1).font = { bold: true }
  help.getColumn(2).alignment = { wrapText: true, vertical: 'top' }
  return wb
}

/** Worksheet rows (1-based numbers, 0-based cell values) of the "Assortments" sheet, else the first sheet. */
export function sheetCells(wb: ExcelJS.Workbook): { rowNumber: number; values: unknown[] }[] | null {
  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets[0]
  if (!ws) return null
  const cells: { rowNumber: number; values: unknown[] }[] = []
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const v: unknown[] = []
    row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value })
    cells.push({ rowNumber: n, values: v })
  })
  return cells
}
