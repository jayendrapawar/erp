// Relaxo bill PDFs ("PERFORMA INVOICE" / tax invoice) → structured lines. Pure: takes the text
// pdf.js extracts (one string per page) and returns the bill or the reasons it cannot be read.
//
// Item line as extracted (one line, or wrapped over 2–3 lines when the description is long):
//   1 64029990 PUG186G-DTDT0810, PUG 186 G D. TAN 0810 /1 A 1 30 30 299.50 199.65 5989.50 539.06 …
//   no  HSN    article-colour+range, description      /cartons pack cartons pairs/ctn pairs MRP rate amount …
// Checks: cartons × pairs/ctn = pairs; "/n" = cartons; Σ cartons and Σ pairs = the bill's Total row.
// Size "00xx" = a single-size carton (e.g. SF0192G-GFSL0007: every pair is size 7); stored as 7–7.

export interface BillLine {
  lineNo: number
  hsn: string
  articleCode: string
  colourCode: string
  /** Normalised ("08" → "8"). */
  sizeFrom: string
  sizeTo: string
  packLetter: string
  description: string
  cartons: number
  pairsPerCarton: number
  pairs: number
  mrp: number
  rate: number
  amount: number
}

export interface ParsedBill {
  docType: 'proforma' | 'invoice'
  supplier: string
  refNo: string
  invoiceNo: string
  billDate: string // yyyy-mm-dd
  soNo: string | null
  soDate: string | null
  poNo: string | null
  customerCode: string | null
  totalCartons: number
  totalPairs: number
  grossAmount: number | null
  lines: BillLine[]
}

export type BillParseResult = { ok: true; bill: ParsedBill; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] }

const LINE_START = /^(\d{1,3}) (\d{8}) [A-Z0-9]+-[A-Z0-9]{4}\d{4},/
const LINE_RE = /^(\d{1,3}) (\d{8}) ([A-Z0-9]+)-([A-Z0-9]{4})(\d{2})(\d{2}),\s*(.*?)\s*,?\s*\/(\d+)\s+([A-Z])\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/
const num = (s: string) => Number(s.replace(/,/g, ''))
const isoDate = (s: string | undefined | null) => {
  const m = (s ?? '').trim().replace(/,$/, '').match(DATE_RE)
  if (!m || m[3] === '0000') return null
  return `${m[3]}-${m[2]}-${m[1]}`
}
const size = (s: string) => String(Number(s))

/** Assortment code for a size range: 6–10 → "610", 8–10 → "810", 11–1 → "1101". */
export function rangeCode(sizeFrom: string, sizeTo: string): string {
  return `${Number(sizeFrom)}${String(Number(sizeTo)).padStart(2, '0')}`
}

export function parseRelaxoBill(pages: string[]): BillParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const all = pages.join('\n')
  const lines = all.split(/\r?\n/).map((l) => l.trim())

  if (!/RELAXO FOOTWEARS/i.test(all)) errors.push('This does not look like a Relaxo bill (no "RELAXO FOOTWEARS" on it).')
  const docType: 'proforma' | 'invoice' = /PERFORMA INVOICE|PROFORMA INVOICE/i.test(all) ? 'proforma' : 'invoice'

  // Header values follow their labels in a block: "Invoice No. :", "Date :", "SO No. :", "SO Date :", "Ref :"
  // then the values in the same order (invoice no, date, SO no, SO date, ref).
  const refLine = lines.find((l) => /^\d{6,}\/\d+$/.test(l))
  const refIdx = refLine ? lines.indexOf(refLine) : -1
  const invoiceNo = refIdx >= 4 ? lines[refIdx - 4] : ''
  const billDate = refIdx >= 3 ? isoDate(lines[refIdx - 3]) : null
  const soNo = refIdx >= 2 ? lines[refIdx - 2].replace(/,$/, '') || null : null
  const soDate = refIdx >= 1 ? isoDate(lines[refIdx - 1]) : null
  if (!refLine) errors.push('Bill reference (e.g. 0520364945/1062) not found.')
  if (!billDate) errors.push('Bill date not found.')
  const poNo = all.match(/PO No\. : ([^\n]+?),?\s*$/m)?.[1]?.trim() ?? null
  const customerCode = lines.find((l) => /^\d{8}$/.test(l)) ?? null

  // Item lines, joining wrapped ones.
  const items: BillLine[] = []
  const seen = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (!LINE_START.test(lines[i])) continue
    let text = lines[i]
    let m = text.match(LINE_RE)
    for (let k = 1; !m && k <= 3 && i + k < lines.length; k++) {
      text = `${text} ${lines[i + k]}`
      m = text.match(LINE_RE)
    }
    if (!m) { errors.push(`Line could not be read: "${lines[i].slice(0, 80)}"`); continue }
    const lineNo = Number(m[1])
    if (seen.has(lineNo)) continue // header/footer repeated on a new page never repeats items, but be safe
    seen.add(lineNo)
    const cartons = Number(m[10]), perCtn = Number(m[11]), pairs = Number(m[12])
    const line: BillLine = {
      lineNo, hsn: m[2], articleCode: m[3], colourCode: m[4], sizeFrom: m[5] === '00' ? size(m[6]) : size(m[5]), sizeTo: size(m[6]),
      packLetter: m[9], description: m[7].replace(/\s+/g, ' ').trim(), cartons, pairsPerCarton: perCtn, pairs,
      mrp: num(m[13]), rate: num(m[14]), amount: num(m[15]),
    }
    if (cartons * perCtn !== pairs) errors.push(`Line ${lineNo}: ${cartons} cartons × ${perCtn} pairs ≠ ${pairs} pairs.`)
    if (Number(m[8]) !== cartons) warnings.push(`Line ${lineNo}: "/${m[8]}" differs from ${cartons} cartons.`)
    if (Number(line.sizeFrom) <= 0 || Number(line.sizeTo) <= 0) errors.push(`Line ${lineNo}: size range ${m[5]}–${m[6]} is not valid.`)
    items.push(line)
  }
  if (!items.length) errors.push('No item lines found.')
  items.sort((a, b) => a.lineNo - b.lineNo)
  items.forEach((l, i) => { if (l.lineNo !== i + 1) warnings.push(`Line numbers jump at ${l.lineNo}.`) })

  // Totals row: "Total <cartons> <pairs> <amount> … <gross>"
  const totalRow = lines.find((l) => /^Total \d+ \d+ /.test(l))
  const t = totalRow?.split(/\s+/) ?? []
  const totalCartons = t.length ? Number(t[1]) : NaN
  const totalPairs = t.length ? Number(t[2]) : NaN
  const grossAmount = t.length ? num(t[t.length - 1]) : NaN
  const sumCartons = items.reduce((n, l) => n + l.cartons, 0)
  const sumPairs = items.reduce((n, l) => n + l.pairs, 0)
  if (!totalRow) errors.push('Total row not found.')
  else {
    if (sumCartons !== totalCartons) errors.push(`Lines add up to ${sumCartons} cartons; the bill total says ${totalCartons}.`)
    if (sumPairs !== totalPairs) errors.push(`Lines add up to ${sumPairs} pairs; the bill total says ${totalPairs}.`)
  }

  if (errors.length) return { ok: false, errors, warnings }
  return {
    ok: true, warnings,
    bill: {
      docType, supplier: 'Relaxo Footwears Limited', refNo: refLine!, invoiceNo, billDate: billDate!,
      soNo, soDate, poNo, customerCode, totalCartons, totalPairs, grossAmount: Number.isFinite(grossAmount) ? grossAmount : null, lines: items,
    },
  }
}

/** Division suggested from the article codes, by majority (hint only; changeable on the bill). */
export function suggestDivision(lines: { articleCode: string }[], divisionOf: (articleCode: string) => string): string {
  const votes = new Map<string, number>()
  for (const l of lines) {
    const d = divisionOf(l.articleCode)
    if (d) votes.set(d, (votes.get(d) ?? 0) + 1)
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

/** Date + n days, yyyy-mm-dd. */
export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
