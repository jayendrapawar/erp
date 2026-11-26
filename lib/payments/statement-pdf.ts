// Reading a bank statement PDF (owner, 25 Nov 2026). Pure: takes the text pieces of each page with
// their positions (lib/payments/statement-pdf-read.ts pulls them out with pdf.js) and rebuilds the
// statement's table as rows, which then go through the same import as an Excel / CSV file.
//
// Seen so far: The Sarvodaya Sahakari Bank "Statement Of Accounts" (Date | Particulars | Chq No. |
// Value Date | Debit | Credit | Balance). Each entry has one row holding its date and amounts; its
// particulars start on that row and wrap onto the lines below it, sometimes onto the next page. Every
// page repeats the account block and the column headings and has Balance B/F / Balance C/F rows.
//
// Accuracy first: the rows are checked against the statement itself — each balance must equal the
// one before it plus the credit minus the debit, and the closing balance, totals and counts at the end
// must match. A PDF that fails a check is refused (download Excel / CSV instead), never half imported.

import { readStatementAmount, readStatementDate, type Cells } from './statement-parse'

/** One piece of text on a page: x, y = its left baseline (y grows upwards, as in PDF), w = width. */
export interface PdfText { s: string; x: number; y: number; w: number }
export interface PdfTextPage { items: PdfText[] }

export interface PdfStatement {
  cells: Cells
  /** Anything that makes the rows untrustworthy: the import is refused while there is one. */
  errors: string[]
  /** What was checked against the statement itself, for the preview. */
  checks: string[]
}

type Field = 'date' | 'details' | 'reference' | 'valueDate' | 'debit' | 'credit' | 'balance'
type Placed = Field | 'other'
interface Col { field: Field; label: string; left: number; right: number }
interface Line { y: number; items: PdfText[] }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const word = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const DATE = /^\d{1,2}[-/.](\d{1,2}|[A-Za-z]{3})[-/.]\d{2,4}$/
const AMOUNT = /^-?[\d,]+\.\d{2}(\s*(Cr|Dr)\.?)?$/i
const DIGITS = /^\d{1,12}$/
const LINE_GAP = 2.5 // pieces whose baselines are this close are one line (lines are ~9 apart)

const HEADINGS: Record<Field, string[]> = {
  date: ['date', 'txndate', 'transactiondate', 'trandate', 'postdate'],
  details: ['particulars', 'narration', 'description', 'details', 'transactiondetails', 'remarks'],
  reference: ['chqno', 'chequeno', 'chqrefno', 'refno', 'referenceno', 'instrumentno'],
  valueDate: ['valuedate', 'valuedt'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'debitamount', 'withdrawalamt'],
  credit: ['credit', 'deposit', 'deposits', 'creditamount', 'depositamt'],
  balance: ['balance', 'closingbalance', 'runningbalance'],
}
const FIELDS: Field[] = ['date', 'details', 'reference', 'valueDate', 'debit', 'credit', 'balance']
const NUMERIC: Field[] = ['reference', 'debit', 'credit', 'balance']

/** Lines of a page, top to bottom; the pieces of a line left to right. */
function linesOf(page: PdfTextPage): Line[] {
  const items = page.items.filter((i) => i.s.trim()).sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Line[] = []
  for (const it of items) {
    const last = lines.at(-1)
    if (last && Math.abs(last.y - it.y) <= LINE_GAP) last.items.push(it)
    else lines.push({ y: it.y, items: [it] })
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x)
  return lines
}

/** The column headings line: needs date, particulars, debit, credit and balance. */
function headingsOf(line: Line): Col[] | null {
  const cols: Col[] = []
  for (const it of line.items) {
    const w = word(it.s)
    const field = FIELDS.find((f) => HEADINGS[f].includes(w))
    if (field && !cols.some((c) => c.field === field)) cols.push({ field, label: norm(it.s), left: it.x, right: it.x + it.w })
  }
  const has = (f: Field) => cols.some((c) => c.field === f)
  return has('date') && has('details') && has('debit') && has('credit') && has('balance') ? cols : null
}

/**
 * Which column a piece belongs to. Words and dates are left-aligned (placed by their left edge);
 * amounts and cheque numbers are right-aligned (placed by the nearest heading's right edge).
 */
function place(it: PdfText, cols: Col[]): Placed {
  const s = norm(it.s)
  const details = cols.find((c) => c.field === 'details')!
  const next = cols.filter((c) => c.left > details.left).sort((a, b) => a.left - b.left)[0]
  const detailsEnd = next ? next.left - 2 : Infinity
  if (it.x < details.left - 2) return DATE.test(s) ? 'date' : 'other'
  if (it.x < detailsEnd) return 'details'
  if (DATE.test(s)) return cols.some((c) => c.field === 'valueDate') ? 'valueDate' : 'other'
  if (!AMOUNT.test(s) && !DIGITS.test(s)) return 'other'
  let best: Placed = 'other', gap = Infinity
  for (const c of cols) {
    if (!NUMERIC.includes(c.field) || (c.field === 'reference' && !DIGITS.test(s))) continue
    const g = Math.abs(c.right - (it.x + it.w))
    if (g < gap) { gap = g; best = c.field }
  }
  return best
}

const SUMMARY = /^(opening balance|closing balance|balance b\/?f|balance c\/?f|total\b|no\.? of tran)/i

export function readPdfStatement(pages: PdfTextPage[]): PdfStatement {
  const errors: string[] = [], checks: string[] = []
  type Entry = { page: number; parts: Partial<Record<Placed, string[]>> }
  const entries: Entry[] = []
  let cols: Col[] | null = null
  let opening: number | null = null, closing: number | null = null
  let totals: { debit?: number; credit?: number } | null = null
  let counts: { debit?: number; credit?: number } | null = null
  let current: Entry | null = null
  let ended = false

  pages.forEach((page, pi) => {
    if (ended) return
    const lines = linesOf(page)
    const h = lines.findIndex((l) => headingsOf(l))
    if (h < 0) {
      if (lines.length && entries.length) errors.push(`Page ${pi + 1}: the column headings were not found.`)
      return
    }
    cols = headingsOf(lines[h])!
    for (const line of lines.slice(h + 1)) {
      const parts: Partial<Record<Placed, string[]>> = {}
      for (const it of line.items) (parts[place(it, cols)] ??= []).push(norm(it.s))
      const words = norm((parts.details ?? []).join(' '))
      if (/end of statement/i.test(line.items.map((i) => i.s).join(' '))) { ended = true; break }
      if (SUMMARY.test(words)) {
        if (/^opening/i.test(words)) opening = signed(parts.balance)
        if (/^closing/i.test(words)) closing = signed(parts.balance)
        if (/^total/i.test(words)) totals = { debit: amountOf(parts.debit), credit: amountOf(parts.credit) }
        if (/^no\.? of tran/i.test(words)) counts = { debit: countOf(parts.debit), credit: countOf(parts.credit) }
        if (/^(opening|closing|total|no)/i.test(words)) current = null
        continue // Balance B/F, C/F: the entry above may still carry on below
      }
      if (parts.date && (parts.balance || parts.credit || parts.debit)) {
        current = { page: pi + 1, parts }
        entries.push(current)
      } else if (words && current && Object.keys(parts).every((f) => f === 'details' || f === 'other')) {
        (current.parts.details ??= []).push(words)
      }
    }
  })

  if (!cols) return { cells: [], errors: ['This PDF has no statement table (Date, Particulars, Debit, Credit, Balance) that the app can read. Download the statement as Excel or CSV.'], checks }
  const label = (f: Field) => (cols as Col[]).find((c) => c.field === f)?.label ?? f
  const cells: Cells = [{ rowNumber: 1, values: FIELDS.map(label) }]
  let balance: number | null = opening as number | null
  let debitSum = 0, creditSum = 0, debitN = 0, creditN = 0
  entries.forEach((e, i) => {
    const get = (f: Field) => norm((e.parts[f] ?? []).join(' '))
    const debit = amountOf(e.parts.debit) ?? 0, credit = amountOf(e.parts.credit) ?? 0
    const bal = signed(e.parts.balance)
    const where = `Page ${e.page}, ${get('date')} "${get('details').slice(0, 40)}"`
    if (!readStatementDate(get('date'))) errors.push(`${where}: the date could not be read.`)
    if (debit > 0 && credit > 0) errors.push(`${where}: both a debit and a credit.`)
    if (debit > 0) { debitN++; debitSum += debit }
    if (credit > 0) { creditN++; creditSum += credit }
    if (bal === null) errors.push(`${where}: no balance.`)
    else if (balance !== null && balance + credit - debit !== bal) {
      errors.push(`${where}: balance ${rupees(bal)} is not ${rupees(balance)} + ${rupees(credit)} − ${rupees(debit)}.`)
    }
    if (bal !== null) balance = bal
    cells.push({ rowNumber: i + 2, values: FIELDS.map(get) })
  })
  if (!entries.length) errors.push('No entries were found in this PDF.')
  else checks.push(opening !== null ? `Every balance follows from the opening balance ${rupees(opening)}.` : 'Every balance follows from the one before it.')
  if (closing !== null) {
    if (closing !== balance) errors.push(`The closing balance ${rupees(closing)} differs from the last entry's balance ${rupees(balance ?? 0)}.`)
    else checks.push(`Closing balance ${rupees(closing)} matches.`)
  }
  const t = totals as { debit?: number; credit?: number } | null
  if (t) {
    if ((t.debit ?? 0) !== debitSum || (t.credit ?? 0) !== creditSum) {
      errors.push(`The statement's totals (debit ${rupees(t.debit ?? 0)}, credit ${rupees(t.credit ?? 0)}) differ from the entries read (debit ${rupees(debitSum)}, credit ${rupees(creditSum)}).`)
    } else checks.push(`Totals match: debit ${rupees(debitSum)}, credit ${rupees(creditSum)}.`)
  }
  const n = counts as { debit?: number; credit?: number } | null
  if (n) {
    if (n.debit !== debitN || n.credit !== creditN) errors.push(`The statement counts ${n.debit} debits and ${n.credit} credits; ${debitN} and ${creditN} were read.`)
    else checks.push(`Counts match: ${debitN} debits, ${creditN} credits.`)
  }
  return { cells, errors, checks }
}

function amountOf(parts?: string[]): number | undefined {
  return parts?.length ? (readStatementAmount(parts.join('')) ?? undefined) : undefined
}
function countOf(parts?: string[]): number | undefined {
  const s = (parts ?? []).join('').trim()
  return /^\d+$/.test(s) ? Number(s) : undefined
}
/** "733931.25 Cr" → +, "120.00 Dr" → − (an overdrawn account). Paise; null when missing. */
function signed(parts?: string[]): number | null {
  const s = norm((parts ?? []).join(' '))
  const p = s ? readStatementAmount(s) : null
  if (p === null) return null
  return /dr\.?$/i.test(s) ? -Math.abs(p) : p
}
function rupees(p: number) {
  return `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
