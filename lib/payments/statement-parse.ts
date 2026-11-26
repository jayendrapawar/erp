// Reading a bank statement (Excel / CSV) into lines (owner, 24–25 Nov 2026). Pure. The columns are
// named once per bank (saved on the bank); a PDF reader per bank comes when its sample is seen.

import { toPaise } from '@/lib/billing/bill-totals'

/** Which column (by its header text) holds what. Either credit (+ debit) or amount + Dr/Cr. */
export interface StatementColumns {
  date: string
  details: string
  reference?: string
  credit?: string
  debit?: string
  amount?: string
  drcr?: string
  balance?: string
}

export interface StatementLine {
  rowNumber: number
  txnDate: string
  details: string
  reference: string
  creditPaise: number
  debitPaise: number
  balancePaise: number | null
  payerKey: string
  /** Proved by the statement itself not to be a party payment (a bounced cheque, a reversal): saved as ignored with this reason. */
  setAside?: string
}

export type Cells = { rowNumber: number; values: unknown[] }[]

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()
const key = (v: unknown) => norm(v).toLowerCase().replace(/[^a-z]/g, '')
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** 2026-04-01 from a Date, an Excel day number, 01/04/2026, 1-4-26, 01-Apr-2026, 01 Apr 26, 2026-04-01. */
export function readStatementDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000).toISOString().slice(0, 10)
  const s = norm(v).replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$/i, '')
  const ok = (y: number, m: number, d: number) => {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const t = new Date(`${iso}T00:00:00Z`)
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return ok(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s)
  if (m) return ok(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1])
  m = /^(\d{1,2})[\s./-]([A-Za-z]{3})[A-Za-z]*[\s./-](\d{2}|\d{4})$/.exec(s)
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase())
    if (mo >= 0) return ok(m[3].length === 2 ? 2000 + +m[3] : +m[3], mo + 1, +m[1])
  }
  return null
}

/** Paise from 1,23,456.50 / "500.00 Cr" / -200 / ""; null when empty or not an amount. */
export function readStatementAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null
  const s = norm(v).replace(/[₹,\s]/g, '').replace(/^(INR|Rs\.?)/i, '').replace(/(cr|dr)\.?$/i, '')
  if (!s || s === '-') return null
  try { return toPaise(s) } catch { return null }
}

const GUESS: Record<keyof StatementColumns, string[]> = {
  date: ['txndate', 'transactiondate', 'trandate', 'date', 'postdate', 'valuedate'],
  details: ['narration', 'description', 'particulars', 'transactiondetails', 'details', 'remarks', 'transactionremarks'],
  reference: ['chqrefno', 'chequeno', 'chqno', 'refno', 'referenceno', 'chequerefno', 'utr', 'utrno', 'refchqno', 'chqrefnumber', 'instrumentno'],
  credit: ['credit', 'deposit', 'depositamt', 'creditamount', 'deposits', 'cramount', 'creditamt'],
  debit: ['debit', 'withdrawal', 'withdrawalamt', 'debitamount', 'withdrawals', 'dramount', 'debitamt'],
  amount: ['amount', 'transactionamount', 'amountinr'],
  drcr: ['drcr', 'crdr', 'type', 'dc'],
  balance: ['balance', 'closingbalance', 'availablebalance', 'runningbalance'],
}

/** Guess the columns from a header row (exact header texts, so they can be saved). */
export function guessColumns(header: unknown[]): Partial<StatementColumns> {
  const texts = header.map(norm)
  const out: Partial<StatementColumns> = {}
  for (const [field, words] of Object.entries(GUESS) as [keyof StatementColumns, string[]][]) {
    for (const w of words) {
      const hit = texts.find((t) => t && key(t) === w && !Object.values(out).includes(t))
      if (hit) { out[field] = hit; break }
    }
  }
  if (out.credit && out.amount) delete out.amount
  return out
}

/** The header row: the first row holding every chosen column name. */
export function findHeaderRow(cells: Cells, cols: Partial<StatementColumns>): number {
  const want = Object.values(cols).filter(Boolean).map(key)
  if (!want.length) return -1
  return cells.findIndex((c) => { const have = new Set(c.values.map(key)); return want.every((w) => have.has(w)) })
}

/** A likely header row (most guessable column names) — for the first upload of a bank. */
export function likelyHeaderRow(cells: Cells): number {
  let best = -1, score = 0
  cells.slice(0, 40).forEach((c, i) => {
    const s = Object.keys(guessColumns(c.values)).length
    if (s > score) { score = s; best = i }
  })
  return score >= 3 ? best : -1
}

export function columnsProblem(cols: Partial<StatementColumns>): string {
  if (!cols.date) return 'Choose the date column.'
  if (!cols.details) return 'Choose the details (narration) column.'
  if (!cols.credit && !cols.amount) return 'Choose the credit (deposit) column, or the amount column.'
  return ''
}

/** UPI ID if the details have one, else the payer's name without codes, numbers and bank words. */
export function payerKeyOf(details: string): string {
  const vpa = /[a-z0-9._-]{2,}@[a-z]{2,}/i.exec(details)
  if (vpa) return vpa[0].toLowerCase()
  // Clearing lines name the drawer: "By-Clg. SHREE JI FOOTWEAR Br-, Chq : …" or "By-Clg. NAME, Chq : …" (Sarvodaya).
  const drawer = /^by[- ](?:clg\.?|outward return)\s+(.+?)(?:\s+br\s*-|\s*,?\s*chq\b)/i.exec(details.trim())
  if (drawer) return nameKey(drawer[1])
  // A transfer from an account in the same bank: "By-Trf. 1001021011267".
  const acct = /^by[- ]trf\.?\s+(\d{6,})\s*$/i.exec(details.trim())
  if (acct) return `A/C ${acct[1]}`
  const words = details.toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 1 && !NOISE.has(w) && !/^[A-Z]{4}0/.test(w))
  return words.slice(0, 5).join(' ')
}
/**
 * A name as a payer key: capitals, letters only ("J.D. Brothers" → "J D BROTHERS"), no "M/S".
 * The same rule runs in SQL (NAME_KEY_SQL in statements.ts) to find a party with that exact name.
 */
export function nameKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z]+/g, ' ').trim().replace(/^(M S|MS|MESSRS) /, '').slice(0, 80)
}
const NOISE = new Set(['UPI', 'NEFT', 'IMPS', 'RTGS', 'CR', 'DR', 'BY', 'TO', 'FROM', 'TRANSFER', 'TRF', 'CLG', 'CHQ', 'CHEQUE', 'CLEARING',
  'INWARD', 'OUTWARD', 'P2A', 'P2P', 'MOB', 'PAY', 'PAYMENT', 'REF', 'NO', 'INB', 'IB', 'FT', 'DEP', 'DEPOSIT', 'CASH', 'SBIN', 'HDFC', 'ICIC',
  'BANK', 'LTD', 'OF', 'THE', 'AC', 'A/C', 'ACCOUNT', 'NA', 'NULL', 'IMPSIN', 'NEFTIN', 'UPIIN', 'RECEIVED', 'FROMUPI', 'BRANCH'])

/** How the money came: cheque (clearing / cheque no.), UPI, else a bank transfer. */
export function guessMode(details: string, reference: string): 'cheque' | 'upi' | 'bank' {
  if (/\b(chq|cheque|clg|clearing)\b/i.test(details) || /^\d{6}$/.test(reference.trim())) return 'cheque'
  if (/\bupi\b/i.test(details)) return 'upi'
  return 'bank'
}

/** The cheque number in a line, if any ("Chq : 43" — short numbers too, when labelled). */
export function chequeNoOf(details: string, reference: string): string {
  const ref = reference.trim()
  if (/^\d{6}$/.test(ref)) return ref
  const labelled = /\b(?:chq|cheque)(?:\s*no)?\.?\s*[:#-]?\s*(\d{1,10})\b/i.exec(details)
  if (/^\d{1,10}$/.test(ref) && (!labelled || sameCheque(labelled[1], ref))) return ref
  if (labelled) return labelled[1]
  const m = /\b(?:chq|cheque|clg)\D{0,6}(\d{6})\b/i.exec(details)
  return m ? m[1] : ''
}

/** Statement rows → lines (rows without a date or an amount — totals, notes — are skipped). */
export function parseStatement(cells: Cells, cols: StatementColumns): { lines: StatementLine[]; problems: string[]; headerRow: number } {
  const problem = columnsProblem(cols)
  if (problem) return { lines: [], problems: [problem], headerRow: -1 }
  const h = findHeaderRow(cells, cols)
  if (h < 0) return { lines: [], problems: ['The column names were not found in this file. Choose the columns again.'], headerRow: -1 }
  const idx = (name?: string) => (name ? cells[h].values.findIndex((v) => key(v) === key(name)) : -1)
  const i = { date: idx(cols.date), details: idx(cols.details), reference: idx(cols.reference), credit: idx(cols.credit), debit: idx(cols.debit), amount: idx(cols.amount), drcr: idx(cols.drcr), balance: idx(cols.balance) }
  const at = (c: Cells[number], n: number) => (n < 0 ? undefined : c.values[n])
  const lines: StatementLine[] = [], problems: string[] = []
  for (const c of cells.slice(h + 1)) {
    const txnDate = readStatementDate(at(c, i.date))
    let credit = 0, debit = 0
    if (i.credit >= 0) {
      credit = readStatementAmount(at(c, i.credit)) ?? 0
      debit = readStatementAmount(at(c, i.debit)) ?? 0
    } else {
      const a = readStatementAmount(at(c, i.amount)) ?? 0
      const side = norm(at(c, i.drcr)).toLowerCase()
      const raw = norm(at(c, i.amount)).toLowerCase()
      const isDebit = /^d/.test(side) || /dr\.?$/.test(raw) || a < 0
      if (isDebit) debit = Math.abs(a); else credit = Math.abs(a)
    }
    if (!txnDate || (credit <= 0 && debit <= 0)) {
      if (txnDate && norm(at(c, i.details))) problems.push(`Row ${c.rowNumber}: no amount.`)
      continue
    }
    if (credit > 0 && debit > 0) { problems.push(`Row ${c.rowNumber}: both credit and debit — skipped.`); continue }
    const details = norm(at(c, i.details)).slice(0, 500)
    const reference = norm(at(c, i.reference)).slice(0, 60)
    lines.push({
      rowNumber: c.rowNumber, txnDate, details, reference, creditPaise: Math.abs(credit), debitPaise: Math.abs(debit),
      balancePaise: readStatementAmount(at(c, i.balance)), payerKey: credit > 0 ? payerKeyOf(details) : '',
    })
  }
  setAsideNonPayments(lines)
  return { lines, problems, headerRow: h }
}

const sameCheque = (a: string, b: string) => !!a && !!b && a.replace(/^0+/, '') === b.replace(/^0+/, '')
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000

/**
 * Money in that the same statement proves is not a party payment, so it never reaches review:
 * - a bounced cheque: the credit is taken back by a "return" debit of the same amount and cheque
 *   no. within 10 days (Sarvodaya: "By-Outward Return …" then "To-Outward Return Clg Return …");
 * - a reversal: "… Rev" money in after the same amount went out with the same long reference.
 * Each debit pairs once. Returns how many credits were set aside.
 */
export function setAsideNonPayments(lines: StatementLine[]): number {
  const paired = new Set<number>()
  let n = 0
  for (const c of lines) {
    if (c.creditPaise <= 0 || c.setAside) continue
    const chq = chequeNoOf(c.details, c.reference)
    let j = chq ? lines.findIndex((d, i) => !paired.has(i) && d.debitPaise === c.creditPaise && /\b(return|rtn|bounce|dishono)/i.test(d.details)
      && daysBetween(c.txnDate, d.txnDate) >= 0 && daysBetween(c.txnDate, d.txnDate) <= 10 && sameCheque(chequeNoOf(d.details, d.reference), chq)) : -1
    if (j >= 0) {
      const why = /return reason\s*:\s*(.+?)(?:\s+booking\b|$)/i.exec(lines[j].details)?.[1]?.trim()
      c.setAside = `Cheque ${chq} returned unpaid${why ? ` (${why.slice(0, 80)})` : ''}: not a payment. If it was recorded, mark it Bounced in Payments & cheques.`
    } else if (/\brev\b|revers/i.test(c.details)) {
      const refs = c.details.match(/\d{8,}/g) ?? []
      j = refs.length ? lines.findIndex((d, i) => !paired.has(i) && d.debitPaise === c.creditPaise && daysBetween(d.txnDate, c.txnDate) >= 0
        && daysBetween(d.txnDate, c.txnDate) <= 3 && refs.some((r) => d.details.includes(r) || d.reference.includes(r))) : -1
      if (j >= 0) c.setAside = 'Money sent out came back (reversal): not a payment.'
    }
    if (j >= 0) { paired.add(j); n++ }
  }
  return n
}

/**
 * The key that makes a line unique for a bank: date, amounts, reference, details, and how many
 * identical lines came before it in the file (two identical UPI credits the same day stay two).
 */
export function lineKeys(bankAccountId: number, lines: StatementLine[]): string[] {
  const seen = new Map<string, number>()
  return lines.map((l) => {
    const base = [bankAccountId, l.txnDate, l.creditPaise, l.debitPaise, l.reference.toUpperCase(), l.details.toUpperCase().replace(/\s+/g, ' ')].join('|')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return `${base}|${n}`
  })
}
