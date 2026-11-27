// Relaxo Flite EVA reference data: distributor price list (article-level packing) and the
// carton assortment table (size-wise pairs per carton). Pure parsing + cross-checks; nothing
// here writes to the database.
//
// Two different facts, kept apart:
//   price list   article + size segment → WSP, MRP, pairs per carton (packing)
//   assortment   segment + packing + assortment code → pairs per size inside one carton
// A carton's expected contents need BOTH plus the carton's own size range (from its QR label).

import { expandSizeRange } from './sizes'

export interface PriceListRow {
  page: number
  collection: string
  article: string // as printed, e.g. "FL-291", "FL-K 53"
  colours: string[]
  sizeRange: string // as printed, e.g. "3-8", "11-1", "11"
  sizeFrom: number
  sizeTo: number
  wsp: number
  mrp: number
  packing: number
}

export type AssortmentSegment = 'GENTS' | 'LADIES' | 'BABY' | 'KIDS'

export interface AssortmentRow {
  sheetRow: number
  segment: AssortmentSegment
  /** Row label inside a block when the sheet gives one ("Baby", "Ladies"). */
  rowLabel: string | null
  packing: number
  code: string // "305", "610", "1101"
  sizes: Record<string, number>
  total: number
}

export interface EvaIssue { kind: string; message: string; ref: string }

/** Parse the hand transcription (one line per size row: ARTICLE|COLOURS|SIZE|WSP|MRP|PACKING). */
export function parsePriceList(text: string): PriceListRow[] {
  const out: PriceListRow[] = []
  let page = 0
  let collection = 'EVA COLLECTION'
  for (const line of text.split(/\r?\n/)) {
    // "# page 5 — AIR COLLECTION" starts a new collection; "# page 4 (note)" does not.
    const pm = line.match(/^# page (\d+)(?:\s+—\s+(.+))?/)
    if (pm) { page = Number(pm[1]); if (pm[2]) collection = pm[2].trim(); continue }
    if (!line.trim() || line.startsWith('#')) continue
    const [article, colours, size, wsp, mrp, packing] = line.split('|')
    const [a, b] = size.includes('-') ? size.split('-') : [size, size]
    out.push({
      page, collection, article: article.trim(), colours: colours.split(',').map(c => c.trim()).filter(Boolean),
      sizeRange: size.trim(), sizeFrom: Number(a), sizeTo: Number(b), wsp: Number(wsp), mrp: Number(mrp), packing: Number(packing),
    })
  }
  return out
}

/** Read the assortment sheet: header rows "Packing, Assortment, <sizes…>, Total" start a block. */
export function parseAssortments(rows: { rowNumber: number; values: unknown[] }[]): AssortmentRow[] {
  const out: AssortmentRow[] = []
  let segment: AssortmentSegment | null = null
  let header: { packingCol: number; codeCol: number; sizeCols: [number, string][]; totalCol: number; labelCol: number | null } | null = null
  for (const r of rows) {
    const v = r.values.map(x => (x == null ? null : x))
    const text = v.map(x => String(x ?? '').trim().toUpperCase())
    if (['GENTS', 'LADIES', 'KIDS', 'BABY'].includes(text[0]) && v.slice(3).every(x => x == null)) { segment = text[0] as AssortmentSegment; header = null; continue }
    const pi = text.indexOf('PACKING')
    if (pi !== -1 && text[pi + 1] === 'ASSORTMENT') {
      const totalCol = text.indexOf('TOTAL')
      const sizeCols: [number, string][] = []
      for (let i = pi + 2; i < totalCol; i++) sizeCols.push([i, String(v[i])])
      header = { packingCol: pi, codeCol: pi + 1, sizeCols, totalCol, labelCol: pi > 0 ? 0 : null }
      continue
    }
    if (!header || !segment || v[header.packingCol] == null) continue
    const sizes: Record<string, number> = {}
    for (const [i, s] of header.sizeCols) if (v[i] != null && v[i] !== '') sizes[s] = Number(v[i])
    const label = header.labelCol != null ? (String(v[header.labelCol] ?? '').trim() || null) : null
    out.push({
      sheetRow: r.rowNumber, segment: label && /^baby$/i.test(label) ? 'BABY' : segment, rowLabel: label,
      packing: Number(v[header.packingCol]), code: String(v[header.codeCol]), sizes, total: Number(v[header.totalCol]),
    })
  }
  return out
}

/** Assortment code → size range: "305" = 3–5, "610" = 6–10, "1101" = 11–1, "205" = 2–5. */
export function codeToRange(code: string): { from: number; to: number } | null {
  const m = code.match(/^(\d{1,2})(\d{2})$/)
  if (!m) return null
  return { from: Number(m[1]), to: Number(m[2]) }
}

export function checkAssortments(list: AssortmentRow[]): EvaIssue[] {
  const issues: EvaIssue[] = []
  const seen = new Map<string, AssortmentRow>()
  for (const a of list) {
    const ref = `assortment sheet row ${a.sheetRow} (${a.segment} ${a.packing}/${a.code})`
    const sum = Object.values(a.sizes).reduce((x, y) => x + y, 0)
    if (sum !== a.total) issues.push({ kind: 'total_mismatch', ref, message: `Size quantities add up to ${sum}, Total says ${a.total}.` })
    if (a.total !== a.packing) issues.push({ kind: 'packing_mismatch', ref, message: `Total ${a.total} differs from packing ${a.packing}.` })
    const range = codeToRange(a.code)
    const exp = range ? expandSizeRange(range.from, range.to) : null
    const sizes = Object.keys(a.sizes)
    if (!exp || !exp.ok) issues.push({ kind: 'code_not_a_range', ref, message: `Assortment code ${a.code} does not read as a size range.` })
    else {
      const outside = sizes.filter(s => !exp.sizes.includes(s))
      const absent = exp.sizes.filter(s => !sizes.includes(s))
      if (outside.length || absent.length) {
        issues.push({ kind: 'code_range_mismatch', ref,
          message: `Code ${a.code} means sizes ${exp.sizes.join(', ')}, but the row fills ${sizes.join(', ') || 'nothing'}${outside.length ? ` (outside: ${outside.join(', ')})` : ''}${absent.length ? ` (missing: ${absent.join(', ')})` : ''}.` })
      }
    }
    const key = `${a.segment}|${a.packing}|${a.code}`
    const prev = seen.get(key)
    if (prev && JSON.stringify(prev.sizes) !== JSON.stringify(a.sizes)) {
      issues.push({ kind: 'duplicate_key_different_contents', ref, message: `Same segment, packing and code as row ${prev.sheetRow} but different quantities.` })
    }
    seen.set(key, a)
  }
  // Same packing + code in two segments with different quantities: the segment is part of the key.
  const byPc = new Map<string, AssortmentRow[]>()
  for (const a of list) byPc.set(`${a.packing}|${a.code}`, [...(byPc.get(`${a.packing}|${a.code}`) ?? []), a])
  for (const [k, rows] of byPc) {
    const segs = [...new Set(rows.map(r => r.segment))]
    const distinct = new Set(rows.map(r => JSON.stringify(r.sizes)))
    if (segs.length > 1 && distinct.size > 1) {
      issues.push({ kind: 'segment_needed', ref: `packing/code ${k.replace('|', '/')}`,
        message: `${segs.join(' and ')} both have packing ${k.split('|')[0]} code ${k.split('|')[1]} with different size quantities (${rows.map(r => `${r.segment}: ${Object.entries(r.sizes).map(([s, q]) => `${s}×${q}`).join(' ')}`).join('; ')}). The article's segment must come from the article master; it cannot be guessed from the carton.` })
    }
  }
  return issues
}

/** Which assortments could fill a carton for one price-list row (same packing, range inside the row's range). */
export function candidateAssortments(row: PriceListRow, list: AssortmentRow[]): AssortmentRow[] {
  const rowRange = expandSizeRange(row.sizeFrom, row.sizeTo)
  if (!rowRange.ok) return []
  return list.filter(a => {
    if (a.packing !== row.packing) return false
    const r = codeToRange(a.code)
    const e = r ? expandSizeRange(r.from, r.to) : null
    return Boolean(e && e.ok && e.sizes.every(s => rowRange.sizes.includes(s)))
  })
}
