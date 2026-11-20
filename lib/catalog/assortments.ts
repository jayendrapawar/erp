// Carton assortment rules shared by the Master screen, the Excel upload and scripts.
// Pure module (no server imports): safe in client components.
//
// One assortment = division + segment + pairs per carton + assortment code → pairs per size.
// Excel format (one row per assortment, sheet "Assortments"):
//   Division | Segment | Pairs per carton | Assortment code | 1 | 2 | … | 13 | Total | Note
// Size cells hold the pairs of that size (blank = none). Total is optional; when given it must
// equal the sum. The segment decides whether 11–13 are adult or children's sizes.

import { codeToRange } from './eva'
import { expandSizeRange, normaliseSizeLabel, sortSizes } from './sizes'
import type { AssortmentSize } from '../db/schema'

export const DIVISIONS = ['Sparx', 'Flite EVA', 'Flite PU', 'Bahamas'] as const
// Same segments as the article list (Gents, Ladies, Kids); Baby comes from the Flite EVA assortment sheet.
export const SEGMENTS = ['Gents', 'Ladies', 'Kids', 'Baby'] as const
export const SIZE_COLUMNS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'] as const
export const SHEET_NAME = 'Assortments'
export const HEADERS = ['Division', 'Segment', 'Pairs per carton', 'Assortment code', ...SIZE_COLUMNS, 'Total', 'Note', 'Only for articles'] as const

export interface AssortmentInput {
  division: string
  segment: string
  packing: number
  code: string
  sizes: AssortmentSize[]
  note?: string
  /** Article codes this assortment is only for ("FIP002G" or "HC003G,TR002G"); '' = any article. */
  onlyFor?: string
}

/** Article codes as stored: upper case, unique, sorted, comma-separated ('' = any article). */
export function normalizeOnlyFor(raw: unknown): string {
  return [...new Set(String(raw ?? '').toUpperCase().split(/[\s,;/]+/).map(x => x.trim()).filter(Boolean))].sort().join(',')
}

/** Article codes written in a note, e.g. "Hawaii only: HC003G, TR002G" or "only for FIP002G" ('' when none). */
export function onlyForFromNote(note: unknown): string {
  const m = /\bonly(?:\s+for)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9 ,;/]*)$/i.exec(String(note ?? '').trim())
  if (!m) return ''
  const codes = normalizeOnlyFor(m[1]).split(',').filter(c => /^[A-Z]{1,6}[0-9][A-Z0-9]{1,8}$/.test(c))
  return codes.join(',')
}

/** Does an assortment apply to this article code? ('' onlyFor = every article). */
export function coversArticle(onlyFor: string | null | undefined, articleCode: string): boolean {
  return !onlyFor || onlyFor.split(',').includes(articleCode.trim().toUpperCase())
}

export interface Validated {
  value: AssortmentInput
  errors: string[]
  warnings: string[]
}

const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ')

/** Match a name case-insensitively against a list; returns the list's spelling or null. */
function pick(list: readonly string[], raw: string): string | null {
  const k = raw.toLowerCase()
  return list.find(x => x.toLowerCase() === k) ?? null
}

export function assortmentKey(a: { division: string; segment: string; packing: number; code: string; onlyFor?: string }): string {
  return `${a.division}|${a.segment}|${a.packing}|${a.code}|${a.onlyFor ?? ''}`
}

/** "6×12 7×10 8×8" */
export function formatSizes(sizes: AssortmentSize[]): string {
  return sizes.map(s => `${s.size}×${s.pairs}`).join('  ')
}

/** Sizes the code stands for (305 → 3, 4, 5; 1101 → 11, 12, 13, 1), or null when it is not a range. */
export function codeSizes(code: string): string[] | null {
  const r = codeToRange(code)
  if (!r) return null
  const e = expandSizeRange(r.from, r.to)
  return e.ok ? e.sizes : null
}

export function sameSizes(a: AssortmentSize[], b: AssortmentSize[]): boolean {
  return a.length === b.length && a.every((s, i) => s.size === b[i].size && s.pairs === b[i].pairs)
}

/**
 * Normalise and check one assortment.
 * Errors block saving: unknown division/segment, bad pairs, sizes outside the code's range,
 * total ≠ pairs per carton. Warnings do not: a size of the code's range left empty.
 */
export function validateAssortment(raw: AssortmentInput, divisions: readonly string[] = DIVISIONS): Validated {
  const errors: string[] = []
  const warnings: string[] = []
  const divisionRaw = norm(raw.division)
  const segmentRaw = norm(raw.segment)
  const division = pick(divisions, divisionRaw)
  const segment = pick(SEGMENTS, segmentRaw)
  if (!divisionRaw) errors.push('Division is missing.')
  else if (!division) errors.push(`Division "${divisionRaw}" is not one of: ${divisions.join(', ')}.`)
  if (!segmentRaw) errors.push('Segment is missing.')
  else if (!segment) errors.push(`Segment "${segmentRaw}" is not one of: ${SEGMENTS.join(', ')}.`)

  const packing = Number(raw.packing)
  if (!Number.isInteger(packing) || packing < 1 || packing > 1000) errors.push('Pairs per carton must be a whole number from 1 to 1000.')

  const code = norm(raw.code).toUpperCase().replace(/\.0+$/, '')
  if (!code) errors.push('Assortment code is missing.')
  else if (!/^[0-9A-Z][0-9A-Z-]{0,15}$/.test(code)) errors.push(`Assortment code "${code}" may only contain letters, digits and "-".`)

  const bySize = new Map<string, number>()
  for (const s of raw.sizes) {
    const size = normaliseSizeLabel(s.size)
    const pairs = Number(s.pairs)
    if (s.pairs == null || String(s.pairs).trim() === '' || pairs === 0) continue
    if (!Number.isInteger(pairs) || pairs < 0) { errors.push(`Size ${size}: pairs must be a whole number.`); continue }
    if (bySize.has(size)) { errors.push(`Size ${size} is given twice.`); continue }
    bySize.set(size, pairs)
  }
  const sizes: AssortmentSize[] = sortSizes([...bySize.keys()]).map(size => ({ size, pairs: bySize.get(size)! }))
  if (sizes.length === 0) errors.push('No pairs entered for any size.')
  const total = sizes.reduce((n, s) => n + s.pairs, 0)
  if (sizes.length && Number.isInteger(packing) && total !== packing) errors.push(`Sizes add up to ${total} pairs, but pairs per carton is ${packing}.`)

  const range = code ? codeSizes(code) : null
  if (range && sizes.length) {
    const outside = sizes.filter(s => !range.includes(s.size)).map(s => s.size)
    const empty = range.filter(r => !bySize.has(r))
    if (outside.length) errors.push(`Code ${code} means sizes ${range.join(', ')}; size ${outside.join(', ')} is outside it.`)
    if (empty.length) warnings.push(`Code ${code} means sizes ${range.join(', ')}; no pairs for size ${empty.join(', ')}.`)
  } else if (code && /^\d+$/.test(code) && !range) {
    warnings.push(`Code ${code} does not read as a size range, so the sizes cannot be cross-checked.`)
  }
  const onlyFor = normalizeOnlyFor(raw.onlyFor)
  const badCode = onlyFor.split(',').filter(Boolean).find(c => !/^[A-Z0-9]{3,14}$/.test(c))
  if (badCode) errors.push(`"${badCode}" in Only for articles is not an article code.`)

  return {
    value: { division: division ?? divisionRaw, segment: segment ?? segmentRaw, packing, code, sizes, note: norm(raw.note), onlyFor },
    errors, warnings,
  }
}

export interface SheetRow { row: number; input: AssortmentInput; total: number | null }

/**
 * Read the "Assortments" sheet. `rows` are 1-based worksheet rows with 0-based cell values.
 * Columns are found by header name, so their order may change; extra columns are ignored.
 */
export function parseAssortmentSheet(rows: { rowNumber: number; values: unknown[] }[]): { rows: SheetRow[]; errors: string[] } {
  const errors: string[] = []
  const headerAt = rows.findIndex(r => r.values.some(v => /^division$/i.test(norm(cellText(v)))))
  if (headerAt === -1) return { rows: [], errors: ['No header row with "Division" found. Download the template and keep its first row.'] }
  const header = rows[headerAt].values.map(v => norm(cellText(v)).toLowerCase())
  const col = (...names: string[]) => header.findIndex(h => names.includes(h))
  const c = {
    division: col('division'), segment: col('segment'),
    packing: col('pairs per carton', 'packing', 'pairs/carton', 'pairs'),
    code: col('assortment code', 'assortment', 'code'),
    total: col('total'), note: col('note', 'notes'),
    onlyFor: col('only for articles', 'only for', 'only for article', 'articles'),
  }
  for (const [k, i] of Object.entries(c)) {
    if (i === -1 && k !== 'total' && k !== 'note' && k !== 'onlyFor') errors.push(`Column "${HEADERS[['division', 'segment', 'packing', 'code'].indexOf(k)]}" is missing.`)
  }
  const sizeCols = SIZE_COLUMNS.map(s => [s, header.findIndex(h => h === s || h === `size ${s}`)] as const).filter(([, i]) => i !== -1)
  if (sizeCols.length === 0) errors.push('No size columns (1 … 13) found.')
  if (errors.length) return { rows: [], errors }

  const out: SheetRow[] = []
  for (const r of rows.slice(headerAt + 1)) {
    const v = (i: number) => (i === -1 ? null : cellText(r.values[i]))
    const cells = [c.division, c.segment, c.packing, c.code, ...sizeCols.map(([, i]) => i)].map(v)
    if (cells.every(x => x == null || norm(x) === '')) continue
    const totalRaw = v(c.total)
    out.push({
      row: r.rowNumber,
      total: totalRaw == null || norm(totalRaw) === '' ? null : Number(totalRaw),
      input: {
        division: norm(v(c.division)), segment: norm(v(c.segment)), packing: Number(v(c.packing)), code: norm(v(c.code)),
        note: norm(v(c.note)),
        // "Only for articles" column; else codes written in the note ("Hawaii only: HC003G, TR002G").
        onlyFor: normalizeOnlyFor(v(c.onlyFor)) || onlyForFromNote(v(c.note)),
        sizes: sizeCols.map(([size, i]) => ({ size, pairs: v(i) == null || norm(v(i)) === '' ? 0 : Number(v(i)) })),
      },
    })
  }
  return { rows: out, errors }
}

/** exceljs cell values may be formula results or rich text. */
function cellText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'object') {
    const o = v as { result?: unknown; formula?: string; sharedFormula?: string; richText?: { text: string }[]; text?: string }
    if (o.result !== undefined) return o.result == null || typeof o.result === 'object' ? null : String(o.result)
    if (o.formula !== undefined || o.sharedFormula !== undefined) return null // never calculated (file not opened in Excel)
    if (o.richText) return o.richText.map(t => t.text).join('')
    if (o.text !== undefined) return String(o.text)
  }
  return String(v)
}

export type UploadStatus = 'new' | 'changed' | 'same' | 'error'

export interface UploadLine {
  row: number
  status: UploadStatus
  value: AssortmentInput
  errors: string[]
  warnings: string[]
  /** Active assortment the line replaces (changed) or equals (same). */
  current?: { id: number; version: number; sizes: AssortmentSize[]; note: string; onlyFor?: string }
}

/** Compare sheet rows with the active assortments. Pure: the caller reads the database. */
export function planAssortmentUpload(
  rows: SheetRow[],
  active: { id: number; division: string; segment: string; packing: number; code: string; version: number; sizes: AssortmentSize[]; note: string; onlyFor?: string }[],
  divisions: readonly string[],
): UploadLine[] {
  const byKey = new Map(active.map(a => [assortmentKey(a), a]))
  const seen = new Map<string, number>()
  return rows.map(r => {
    const v = validateAssortment(r.input, divisions)
    if (r.total != null && Number.isFinite(r.total) && r.total !== v.value.sizes.reduce((n, s) => n + s.pairs, 0)) {
      v.errors.push(`Total column says ${r.total}, sizes add up to ${v.value.sizes.reduce((n, s) => n + s.pairs, 0)}.`)
    }
    const key = assortmentKey(v.value)
    if (!v.errors.length && seen.has(key)) v.errors.push(`Same division, segment, pairs, code and "only for" articles as row ${seen.get(key)}.`)
    seen.set(key, r.row)
    const cur = byKey.get(key)
    const current = cur ? { id: cur.id, version: cur.version, sizes: cur.sizes, note: cur.note } : undefined
    const status: UploadStatus = v.errors.length ? 'error'
      : !cur ? 'new'
      : sameSizes(cur.sizes, v.value.sizes) && (v.value.note ?? '') === cur.note ? 'same' : 'changed'
    return { row: r.row, status, value: v.value, errors: v.errors, warnings: v.warnings, current }
  })
}
