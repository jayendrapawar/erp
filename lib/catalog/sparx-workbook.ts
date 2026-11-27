// Sparx article workbook → catalogue model (pure; no database access).
//
// Workbook layout (sheet "Articles"): id, <blank>, artName, artCode, color, colorCode, maxSize, minSize.
// `id` and the blank column are empty and are NOT identifiers.
//
// Hierarchy produced:
//   Article  = manufacturer article code (e.g. SS0702B). artName ("SS-702") is its display / family
//              name and may cover several codes (SS0702B boys, SS0702C children).
//   Variant  = article code + colour code (the `articles` table row).
//   SKU      = variant + size (the `article_sizes` table row).
//
// Several rows may describe one variant with different size ranges (kids 11–13, 1, 2–5). They are
// kept as separate ranges, never merged into one invented range. Nothing is guessed: conflicting
// colour names, overlapping ranges and code/name mismatches become review issues.

import { expandSizeRange, sizeSortOrders, sortSizes } from './sizes'

export interface WorkbookRow {
  rowNumber: number
  artName: string
  artCode: string
  color: string
  colorCode: string
  minSize: string
  maxSize: string
  /** Every cell as read, for traceability. */
  raw: Record<string, unknown>
}

export type IssueSeverity = 'info' | 'review' | 'error'

export type IssueKind =
  | 'invalid_row'
  | 'invalid_size_range'
  | 'exact_duplicate_row'
  | 'repeated_range'
  | 'range_overlap'
  | 'colour_name_conflict'
  | 'code_has_several_names'
  | 'name_code_mismatch'
  | 'same_colour_name_different_code'

export interface CatalogIssue {
  kind: IssueKind
  severity: IssueSeverity
  artCode: string
  colorCode: string | null
  rowNumbers: number[]
  message: string
  details?: Record<string, unknown>
}

export interface RangeSpec {
  min: string
  max: string
  sizes: string[]
  rowNumbers: number[]
}

export interface VariantSpec {
  key: string // ART|COLOUR
  artCode: string
  colorCode: string
  /** Distinct colour names in workbook order. */
  colorNames: string[]
  /** Display name. With conflicting names all are shown ("A / B") until an admin decides. */
  displayColor: string
  ranges: RangeSpec[]
  /** Sorted SKU sizes with sort keys. */
  sizes: { label: string; sortOrder: number }[]
  rowNumbers: number[]
  needsReview: boolean
}

export interface ArticleSpec {
  artCode: string
  artName: string
  artNames: string[]
  /** Last letter of the code (G, L, B, C, S…). A hint only, never used for logic. */
  segmentHint: string | null
  variants: VariantSpec[]
  needsReview: boolean
}

export interface WorkbookModel {
  rows: WorkbookRow[]
  articles: ArticleSpec[]
  variants: VariantSpec[]
  issues: CatalogIssue[]
  /** rowNumber → outcome, for catalog_source_rows. */
  rowOutcome: Map<number, { variantKey: string | null; outcome: 'used' | 'duplicate' | 'rejected'; range: string | null }>
  stats: {
    rows: number
    usableRows: number
    articleCodes: number
    artNames: number
    variants: number
    repeatedVariants: number
    exactDuplicateRows: number
    skus: number
    ranges: number
  }
}

export const CODE_RE = /^[A-Z]{2,3}[0-9A-Z]{3,4}[A-Z]$/
export const COLOUR_RE = /^[A-Z]{4}$/

const clean = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ')
export const normCode = (v: unknown) => clean(v).toUpperCase()
/** Colour-name comparison key: case, spacing and dot spacing ignored ("N. Blue" = "N.Blue"). */
export const colourKey = (v: unknown) => clean(v).toUpperCase().replace(/\s*\.\s*/g, '.')

/** Map raw cell arrays (header row first) to WorkbookRow objects by header name. */
export function rowsFromSheet(cells: { rowNumber: number; values: unknown[] }[]): WorkbookRow[] {
  if (!cells.length) return []
  const header = cells[0].values.map(v => clean(v).toLowerCase())
  const col = (name: string) => {
    const i = header.indexOf(name.toLowerCase())
    if (i === -1) throw new Error(`Workbook is missing the "${name}" column.`)
    return i
  }
  const c = { artName: col('artName'), artCode: col('artCode'), color: col('color'), colorCode: col('colorCode'), minSize: col('minSize'), maxSize: col('maxSize') }
  const out: WorkbookRow[] = []
  for (const r of cells.slice(1)) {
    const v = r.values
    const raw: Record<string, unknown> = {}
    header.forEach((h, i) => { if (v[i] != null && v[i] !== '') raw[h || `col${i + 1}`] = v[i] })
    if (!Object.keys(raw).length) continue // blank line
    out.push({
      rowNumber: r.rowNumber,
      artName: clean(v[c.artName]),
      artCode: normCode(v[c.artCode]),
      color: clean(v[c.color]),
      colorCode: normCode(v[c.colorCode]),
      minSize: clean(v[c.minSize]),
      maxSize: clean(v[c.maxSize]),
      raw,
    })
  }
  return out
}

const digits = (s: string) => (s.match(/\d+/)?.[0] ?? '').replace(/^0+/, '')
const nameFamily = (s: string) => s.toUpperCase().split('-')[0].trim()
const codePrefix = (s: string) => s.match(/^[A-Z]+/)?.[0].slice(0, 2) ?? ''

export function buildWorkbookModel(rows: WorkbookRow[]): WorkbookModel {
  const issues: CatalogIssue[] = []
  const rowOutcome: WorkbookModel['rowOutcome'] = new Map()
  const exactSeen = new Map<string, number>()
  let exactDuplicateRows = 0

  interface Acc { artCode: string; colorCode: string; names: string[]; rows: number[]; ranges: Map<string, RangeSpec> }
  const variants = new Map<string, Acc>()
  const articleNames = new Map<string, { names: string[]; rows: number[] }>()

  for (const r of rows) {
    if (!CODE_RE.test(r.artCode) || !COLOUR_RE.test(r.colorCode) || !r.artName) {
      issues.push({ kind: 'invalid_row', severity: 'error', artCode: r.artCode, colorCode: r.colorCode || null, rowNumbers: [r.rowNumber],
        message: `Row ${r.rowNumber}: article code "${r.artCode}", colour code "${r.colorCode}" or name "${r.artName}" is not valid; row not imported.` })
      rowOutcome.set(r.rowNumber, { variantKey: null, outcome: 'rejected', range: null })
      continue
    }
    const range = expandSizeRange(r.minSize, r.maxSize)
    if (!range.ok) {
      issues.push({ kind: 'invalid_size_range', severity: 'error', artCode: r.artCode, colorCode: r.colorCode, rowNumbers: [r.rowNumber],
        message: `Row ${r.rowNumber}: ${range.reason} Row not imported.` })
      rowOutcome.set(r.rowNumber, { variantKey: null, outcome: 'rejected', range: null })
      continue
    }
    const key = `${r.artCode}|${r.colorCode}`
    const exact = [r.artName.toUpperCase(), key, colourKey(r.color), range.min, range.max].join('|')
    const firstRow = exactSeen.get(exact)
    if (firstRow != null) {
      exactDuplicateRows++
      issues.push({ kind: 'exact_duplicate_row', severity: 'info', artCode: r.artCode, colorCode: r.colorCode, rowNumbers: [firstRow, r.rowNumber],
        message: `Row ${r.rowNumber} repeats row ${firstRow} exactly; counted once.` })
      rowOutcome.set(r.rowNumber, { variantKey: key, outcome: 'duplicate', range: `${range.min}-${range.max}` })
      continue
    }
    exactSeen.set(exact, r.rowNumber)
    rowOutcome.set(r.rowNumber, { variantKey: key, outcome: 'used', range: `${range.min}-${range.max}` })

    const an: { names: string[]; rows: number[] } = articleNames.get(r.artCode) ?? { names: [], rows: [] }
    if (!an.names.some(n => n.toUpperCase() === r.artName.toUpperCase())) an.names.push(r.artName)
    an.rows.push(r.rowNumber)
    articleNames.set(r.artCode, an)

    const v: Acc = variants.get(key) ?? { artCode: r.artCode, colorCode: r.colorCode, names: [], rows: [], ranges: new Map() }
    if (!v.names.some(n => colourKey(n) === colourKey(r.color))) v.names.push(r.color)
    v.rows.push(r.rowNumber)
    const rk = `${range.min}-${range.max}`
    const existing = v.ranges.get(rk)
    if (existing) existing.rowNumbers.push(r.rowNumber)
    else v.ranges.set(rk, { min: range.min, max: range.max, sizes: range.sizes, rowNumbers: [r.rowNumber] })
    variants.set(key, v)
  }

  // ── Variant-level checks ──
  const variantSpecs: VariantSpec[] = []
  for (const [key, v] of variants) {
    let needsReview = false
    const ranges = [...v.ranges.values()]
    for (const rg of ranges) {
      if (rg.rowNumbers.length > 1) {
        issues.push({ kind: 'repeated_range', severity: 'info', artCode: v.artCode, colorCode: v.colorCode, rowNumbers: rg.rowNumbers,
          message: `${key} size range ${rg.min}–${rg.max} appears in rows ${rg.rowNumbers.join(', ')}; kept once.` })
      }
    }
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const shared = ranges[i].sizes.filter(s => ranges[j].sizes.includes(s))
        if (shared.length) {
          needsReview = true
          issues.push({ kind: 'range_overlap', severity: 'review', artCode: v.artCode, colorCode: v.colorCode,
            rowNumbers: [...ranges[i].rowNumbers, ...ranges[j].rowNumbers],
            message: `${key}: ranges ${ranges[i].min}–${ranges[i].max} and ${ranges[j].min}–${ranges[j].max} both include size ${shared.join(', ')}. Each size is created once; confirm which range is correct.`,
            details: { ranges: [`${ranges[i].min}-${ranges[i].max}`, `${ranges[j].min}-${ranges[j].max}`], shared } })
        }
      }
    }
    if (v.names.length > 1) {
      needsReview = true
      issues.push({ kind: 'colour_name_conflict', severity: 'review', artCode: v.artCode, colorCode: v.colorCode, rowNumbers: v.rows,
        message: `${key} is named ${v.names.map(n => `"${n}"`).join(' and ')}. Shown as "${v.names.join(' / ')}" until an admin chooses.`,
        details: { names: v.names } })
    }
    const all = [...new Set(ranges.flatMap(r => r.sizes))]
    const sorted = sortSizes(all)
    const order = sizeSortOrders(sorted)
    variantSpecs.push({
      key, artCode: v.artCode, colorCode: v.colorCode, colorNames: v.names,
      displayColor: v.names.join(' / '),
      ranges: ranges.sort((a, b) => order.get(a.sizes[0])! - order.get(b.sizes[0])!),
      sizes: sorted.map(label => ({ label, sortOrder: order.get(label)! })),
      rowNumbers: v.rows, needsReview,
    })
  }

  // ── Article-level checks ──
  const byArticle = new Map<string, VariantSpec[]>()
  for (const v of variantSpecs) byArticle.set(v.artCode, [...(byArticle.get(v.artCode) ?? []), v])

  // How often each (name family → code prefix) pairing occurs, to spot one-off pairings.
  // Only meaningful when the family has enough codes to compare against.
  const pairCount = new Map<string, number>()
  const familyCount = new Map<string, number>()
  for (const [code, an] of articleNames) {
    const fam = nameFamily(an.names[0])
    const p = `${fam}>${codePrefix(code)}`
    pairCount.set(p, (pairCount.get(p) ?? 0) + 1)
    familyCount.set(fam, (familyCount.get(fam) ?? 0) + 1)
  }

  const articleSpecs: ArticleSpec[] = []
  for (const [code, vs] of byArticle) {
    const an = articleNames.get(code)!
    let needsReview = vs.some(v => v.needsReview)
    if (an.names.length > 1) {
      needsReview = true
      issues.push({ kind: 'code_has_several_names', severity: 'review', artCode: code, colorCode: null, rowNumbers: an.rows,
        message: `${code} is named ${an.names.map(n => `"${n}"`).join(' and ')}. Using "${an.names[0]}" (first row) as the display name until reviewed.` })
    }
    const name = an.names[0]
    const pair = `${nameFamily(name)}>${codePrefix(code)}`
    if (digits(name) !== digits(code)) {
      needsReview = true
      issues.push({ kind: 'name_code_mismatch', severity: 'review', artCode: code, colorCode: null, rowNumbers: an.rows,
        message: `${code} is named "${name}": the number in the name does not match the code.` })
    } else if ((pairCount.get(pair) ?? 0) === 1 && (familyCount.get(nameFamily(name)) ?? 0) >= 5) {
      needsReview = true
      issues.push({ kind: 'name_code_mismatch', severity: 'review', artCode: code, colorCode: null, rowNumbers: an.rows,
        message: `${code} is named "${name}": no other article pairs a "${nameFamily(name)}-" name with a "${codePrefix(code)}" code.` })
    }
    // Same colour name under two colour codes of one article (possible typo such as BLAK vs BKBK).
    const byName = new Map<string, VariantSpec[]>()
    for (const v of vs) for (const n of v.colorNames) byName.set(colourKey(n), [...(byName.get(colourKey(n)) ?? []), v])
    for (const [n, list] of byName) {
      const codes = [...new Set(list.map(v => v.colorCode))]
      if (codes.length > 1) {
        needsReview = true
        issues.push({ kind: 'same_colour_name_different_code', severity: 'review', artCode: code, colorCode: codes.join(','),
          rowNumbers: list.flatMap(v => v.rowNumbers),
          message: `${code}: colour "${n}" appears under colour codes ${codes.join(' and ')}. Kept separate; confirm whether one is a typo.` })
      }
    }
    // Segment is never read from the code or name (owner, 18 Nov 2026): it will come from the
    // Segment column of the final article list.
    articleSpecs.push({ artCode: code, artName: name, artNames: an.names, segmentHint: null, variants: vs, needsReview })
  }

  const usable = [...rowOutcome.values()].filter(o => o.outcome !== 'rejected').length
  return {
    rows, articles: articleSpecs, variants: variantSpecs, issues, rowOutcome,
    stats: {
      rows: rows.length,
      usableRows: usable,
      articleCodes: articleSpecs.length,
      artNames: new Set(rows.filter(r => rowOutcome.get(r.rowNumber)?.outcome !== 'rejected').map(r => r.artName.toUpperCase())).size,
      variants: variantSpecs.length,
      repeatedVariants: variantSpecs.filter(v => v.rowNumbers.length > 1).length,
      exactDuplicateRows,
      skus: variantSpecs.reduce((n, v) => n + v.sizes.length, 0),
      ranges: variantSpecs.reduce((n, v) => n + v.ranges.length, 0),
    },
  }
}

/** Article codes and names that belong to the Sparx catalogue this workbook replaces. */
export const SPARX_CODE_PREFIXES = ['SS', 'SF', 'SX', 'SD', 'SN', 'SC']
export const SPARX_NAME_FAMILIES = ['SS', 'SFG', 'SFL', 'SFK', 'SM', 'SL', 'SK']

/**
 * Which rows the Sparx workbook replaces.
 *
 * The article NAME family decides (SS-, SFG-, SM- …), because older rows of other brands carry
 * Sparx-looking codes by mistake (e.g. "FL-561" with code SF0561G); those stay out of scope and are
 * reported instead. Only when the name has no recognisable family (blank, "SM990") does a
 * Sparx code prefix bring the row into scope.
 */
export function isSparxScope(artCode: string, artName: string): boolean {
  const fam = nameFamily(clean(artName))
  if (SPARX_NAME_FAMILIES.includes(fam)) return true
  if (/^[A-Z]+( [A-Z]+)*$/.test(fam)) return false // another brand or product line
  return SPARX_CODE_PREFIXES.includes(normCode(artCode).slice(0, 2))
}

/** A row outside Sparx scope whose code looks like a Sparx code (likely a data-entry error). */
export function hasSparxCodeOutsideScope(artCode: string, artName: string): boolean {
  return !isSparxScope(artCode, artName) && SPARX_CODE_PREFIXES.includes(normCode(artCode).slice(0, 2)) && CODE_RE.test(normCode(artCode))
}
