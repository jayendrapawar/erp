'use server'

// Payments (payments step 4; docs/architecture/payments.md). Record: admin + accountant; read: also
// salesmen (they see every party's balance, owner 22 Nov 2026). Each write is one transaction and
// returns the party's new balance, so the screen updates in place (no revalidatePath, no refresh).

import { db } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { vendors } from '@/lib/db/schema'
import type { RetailerTerms } from '@/app/actions/vendors'
import { requirePermission, requireUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { creditStatus, type CreditStatus } from '@/lib/payments/credit'
import {
  bouncePayment, depositCheque, loadPartyForPayment, recordPayment, returnCheque, reversePayment,
  type PartyForPayment, type RecordedPayment,
} from '@/lib/payments/payments'
import { applyOpenings, parseOpeningSheet, planOpenings, reverseOpening, type OpeningPlan, type OpeningRow } from '@/lib/payments/opening'
import { csvToCells, xlsxToCells } from '@/lib/catalog/article-upload'
import {
  cancelCreditNote, checkReturnBox, createCreditNote, creditNoteForPrint, listPartyBills,
  type CreditNotePrint, type PartyBill, type ReturnBox, type SavedCreditNote,
} from '@/lib/payments/credit-notes'
import {
  cashSlipNumbering, listBanks, saveBank, saveCashSlipNumbering, type BankAccount, type SlipNumbering,
} from '@/lib/payments/slips'
import { createHash } from 'node:crypto'
import {
  columnsProblem, findHeaderRow, guessColumns, likelyHeaderRow, parseStatement, type Cells, type StatementColumns,
} from '@/lib/payments/statement-parse'
import { bankStatementColumns, confirmStatementLines, countKnownLines, ignoreStatementLine, importStatement } from '@/lib/payments/statements'

const actorOf = (u: { id: string; name: string }) => ({ id: u.id, name: u.name })
const idOf = (v: unknown) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error('Payment not found.')
  return n
}

/** Party, balance and unpaid bills for the Record payment screen. 1 query. */
export async function getPartyForPayment(retailerId: string): Promise<PartyForPayment | null> {
  await requirePermission('payments.view')
  return loadPartyForPayment(db, String(retailerId ?? ''))
}

export async function recordPaymentAction(input: unknown): Promise<RecordedPayment> {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => recordPayment(tx, actorOf(u), input))
}

export async function depositChequeAction(paymentId: number, depositDate: string, allocations?: unknown, discounts?: unknown) {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => depositCheque(tx, actorOf(u), idOf(paymentId), depositDate, allocations ?? [], discounts ?? []))
}

export async function returnChequeAction(paymentId: number, reason: string) {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => returnCheque(tx, actorOf(u), idOf(paymentId), reason))
}

export async function bouncePaymentAction(paymentId: number, reason: string, chargePaise?: number) {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => bouncePayment(tx, actorOf(u), idOf(paymentId), reason, chargePaise ?? 0))
}

export async function reversePaymentAction(paymentId: number, reason: string) {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => reversePayment(tx, actorOf(u), idOf(paymentId), reason))
}

// ── Opening balances (payments step 6) ───────────────────────────────────────

const MAX_FILE = 900_000

async function readOpeningFile(file: unknown): Promise<{ rows: OpeningRow[]; problems: Array<{ rowNumber: number; message: string }>; missingColumns: string[]; fileName: string }> {
  if (!(file instanceof File) || file.size === 0) throw new Error('Choose an Excel (.xlsx) or CSV file.')
  if (file.size > MAX_FILE) throw new Error('The file is too large (limit about 900 KB). Split it into two files.')
  const name = file.name.toLowerCase()
  let cells
  try {
    if (name.endsWith('.xlsx')) cells = await xlsxToCells(await file.arrayBuffer())
    else if (name.endsWith('.csv')) cells = csvToCells(await file.text())
    else throw new Error('type')
  } catch (e) {
    throw new Error(e instanceof Error && e.message === 'type'
      ? 'Only .xlsx or .csv files can be uploaded. In Excel use File → Save As → Excel Workbook (.xlsx).'
      : 'The file could not be read. Save it again as .xlsx and retry.')
  }
  return { ...parseOpeningSheet(cells), fileName: file.name }
}

/** Upload, step 1: what would be added (nothing is saved). 2 queries. */
export async function previewOpeningUpload(form: FormData): Promise<OpeningPlan> {
  await requirePermission('payments.record')
  const f = await readOpeningFile(form.get('file'))
  if (f.missingColumns.length) return { rows: [], ok: 0, errors: 0, duplicates: 0, owedPaise: 0, advancePaise: 0, missingColumns: f.missingColumns }
  return planOpenings(db, f.rows, f.problems)
}

/** Upload, step 2: the same file again; rows are checked again inside the transaction. */
export async function saveOpeningUpload(form: FormData) {
  const u = await requirePermission('payments.record')
  const f = await readOpeningFile(form.get('file'))
  if (f.missingColumns.length) throw new Error(`Missing column(s): ${f.missingColumns.join(', ')}.`)
  return db.transaction(async (tx) => applyOpenings(tx, actorOf(u), (await planOpenings(tx, f.rows, f.problems)).rows, { fileName: f.fileName }))
}

/** One opening balance typed on the screen. */
export async function addOpeningBalance(input: { retailerId: string; date: string; amountPaise: number; billNo?: string; note?: string }) {
  const u = await requirePermission('payments.record')
  const row: OpeningRow = {
    rowNumber: 1, party: '', partyId: String(input?.retailerId ?? ''), date: String(input?.date ?? ''),
    amountPaise: Number(input?.amountPaise), billNo: String(input?.billNo ?? '').trim().slice(0, 40), note: String(input?.note ?? '').trim().slice(0, 200),
  }
  if (!row.partyId) throw new Error('Choose the party.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error('Choose the date.')
  if (!Number.isInteger(row.amountPaise) || row.amountPaise === 0) throw new Error('Type the amount.')
  return db.transaction(async (tx) => {
    const plan = await planOpenings(tx, [row])
    const r = plan.rows[0]
    if (r.status === 'duplicate') throw new Error('This opening balance is already entered (same party, date, bill no. and amount).')
    if (r.status === 'error') throw new Error(r.message)
    return applyOpenings(tx, actorOf(u), plan.rows)
  })
}

export async function reverseOpeningAction(entryId: number, reason: string) {
  const u = await requirePermission('payments.record')
  await db.transaction((tx) => reverseOpening(tx, actorOf(u), idOf(entryId), reason))
}

// ── Credit hold (payments steps 7–9) ─────────────────────────────────────────

/**
 * The party's balance and what is overdue, for the order form and Direct bill (salesmen, billers,
 * admins). canOverride: this user may place an order / bill despite a hold (admins). 1 query.
 */
export async function getCreditStatus(party: { retailerId?: string; name?: string }): Promise<(CreditStatus & { canOverride: boolean }) | null> {
  const u = await requireUser()
  if (!hasPermission(u.roles, 'payments.view') && !hasPermission(u.roles, 'orders.view')) throw new Error('Forbidden')
  const s = await creditStatus(db, { retailerId: party?.retailerId, name: party?.name })
  return s ? { ...s, canOverride: u.roles.includes('admin') } : null
}

// ── Retailer master: bill type and payment terms ─────────────────────────────

/** The retailer's bill type and payment terms (the form, when a retailer is opened). 1 query. */
export async function getRetailerTerms(id: string): Promise<RetailerTerms | null> {
  await requirePermission('retailers.view')
  const [r] = await db.select({
    taxType: vendors.taxType, creditDays: vendors.creditDays, creditLimitPaise: vendors.creditLimitPaise,
    earlyPayDiscountBp: vendors.earlyPayDiscountBp, earlyPayDays: vendors.earlyPayDays,
  }).from(vendors).where(eq(vendors.id, String(id ?? ''))).limit(1)
  return r ? { ...r, creditLimitPaise: r.creditLimitPaise == null ? null : Number(r.creditLimitPaise) } : null
}

// ── Credit notes (migration 0018) ─────────────────────────────────────────────

/** The party's bills to choose the original bill from (newest first). 1 query. */
export async function getPartyBills(retailerId: string): Promise<PartyBill[]> {
  await requirePermission('payments.record')
  return listPartyBills(db, String(retailerId ?? ''))
}

/** A box scanned for a goods return: on this bill and not returned yet. 1 query. */
export async function checkReturnBoxAction(saleBillId: number, raw: string): Promise<ReturnBox> {
  await requirePermission('payments.record')
  return checkReturnBox(db, idOf(saleBillId), String(raw ?? ''))
}

export async function createCreditNoteAction(input: unknown): Promise<SavedCreditNote> {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => createCreditNote(tx, actorOf(u), input))
}

export async function cancelCreditNoteAction(id: number, reason: string) {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => cancelCreditNote(tx, actorOf(u), idOf(id), reason))
}

/** What a printed credit note shows. 2 queries. */
export async function getCreditNotePrint(id: number): Promise<CreditNotePrint | null> {
  await requirePermission('payments.view')
  return creditNoteForPrint(db, idOf(id))
}

// ── Banks and cash / bank slips (migration 0019) ─────────────────────────────

/** The shop's banks: all (Master → Banks) or only active ones (Record payment's "Into"). 1 query. */
export async function getBanks(activeOnly = false): Promise<BankAccount[]> {
  await requirePermission('payments.view')
  return listBanks(db, { activeOnly })
}

export async function saveBankAction(input: unknown): Promise<BankAccount[]> {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => saveBank(tx, actorOf(u), input))
}

export async function getCashSlipNumbering(): Promise<SlipNumbering> {
  await requirePermission('payments.view')
  return cashSlipNumbering(db)
}

export async function saveCashSlipNumberingAction(input: unknown): Promise<SlipNumbering> {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => saveCashSlipNumbering(tx, actorOf(u), input))
}

// ── Bank statement import (migration 0020) ───────────────────────────────────

export interface StatementPreview {
  bankName: string
  /** Header row cells (to choose columns) and a few rows below it. */
  headers: string[]
  sample: string[][]
  columns: Partial<StatementColumns>
  /** True when the columns are this bank's saved ones. */
  saved: boolean
  problems: string[]
  lines: number; credits: number; creditPaise: number; debits: number; known: number
  fromDate: string | null; toDate: string | null
}

async function readStatementFile(file: unknown): Promise<{ cells: Cells; name: string; sha256: string }> {
  if (!(file instanceof File) || file.size === 0) throw new Error('Choose the statement file (Excel .xlsx or CSV).')
  if (file.size > 5_000_000) throw new Error('The file is too large (limit 5 MB). Download a shorter period.')
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) throw new Error('PDF statements need a reader for that bank: send a sample of this bank\'s PDF. Until then, download the statement as Excel or CSV.')
  if (name.endsWith('.xls')) throw new Error('Old .xls files cannot be read. Open it in Excel and save as .xlsx (or download CSV).')
  const buf = await file.arrayBuffer()
  let cells: Cells
  try {
    cells = name.endsWith('.xlsx') ? await xlsxToCells(buf) : name.endsWith('.csv') ? csvToCells(new TextDecoder().decode(buf)) : (() => { throw new Error('type') })()
  } catch (e) {
    throw new Error(e instanceof Error && e.message === 'type' ? 'Only Excel (.xlsx) or CSV statements can be read here.' : 'The file could not be read. Download it again as Excel or CSV.')
  }
  const sha256 = createHash('sha256').update(Buffer.from(buf)).digest('hex')
  return { cells, name: file.name, sha256 }
}

const cellText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim())

/** Upload step 1: read the file, find the columns (saved for this bank, else guessed), count new lines. Nothing is saved. */
export async function previewStatementAction(form: FormData): Promise<StatementPreview> {
  await requirePermission('payments.record')
  const bankId = idOf(form.get('bankAccountId'))
  const bank = await bankStatementColumns(db, bankId)
  if (!bank) throw new Error('Bank not found. Add it in Master → Banks.')
  const f = await readStatementFile(form.get('file'))
  const typed = form.get('columns') ? (JSON.parse(String(form.get('columns'))) as Partial<StatementColumns>) : null
  let cols: Partial<StatementColumns> = typed ?? bank.columns ?? {}
  let h = findHeaderRow(f.cells, cols)
  if (h < 0) { h = likelyHeaderRow(f.cells); if (!typed) cols = h >= 0 ? guessColumns(f.cells[h].values) : {} }
  const headerCells = h >= 0 ? f.cells[h].values.map(cellText) : (f.cells.find((c) => c.values.filter(Boolean).length >= 3)?.values.map(cellText) ?? [])
  const sample = (h >= 0 ? f.cells.slice(h + 1, h + 7) : f.cells.slice(0, 6)).map((c) => c.values.map(cellText))
  const base = { bankName: bank.name, headers: headerCells, sample, columns: cols, saved: !typed && !!bank.columns && findHeaderRow(f.cells, bank.columns) >= 0 }
  const problem = columnsProblem(cols)
  if (problem || h < 0) return { ...base, problems: [problem || 'Choose which columns are the date, details and amount.'], lines: 0, credits: 0, creditPaise: 0, debits: 0, known: 0, fromDate: null, toDate: null }
  const p = parseStatement(f.cells, cols as StatementColumns)
  const credits = p.lines.filter((l) => l.creditPaise > 0)
  const dates = p.lines.map((l) => l.txnDate).sort()
  return {
    ...base, problems: p.problems.slice(0, 20), lines: p.lines.length, credits: credits.length, creditPaise: credits.reduce((s, l) => s + l.creditPaise, 0),
    debits: p.lines.length - credits.length, known: await countKnownLines(db, bankId, p.lines), fromDate: dates[0] ?? null, toDate: dates.at(-1) ?? null,
  }
}

/** Upload step 2: save the new lines (already imported ones are skipped) and the bank's columns. */
export async function importStatementAction(form: FormData) {
  const u = await requirePermission('payments.record')
  const bankId = idOf(form.get('bankAccountId'))
  const cols = JSON.parse(String(form.get('columns') ?? '{}')) as StatementColumns
  const problem = columnsProblem(cols)
  if (problem) throw new Error(problem)
  const f = await readStatementFile(form.get('file'))
  const p = parseStatement(f.cells, cols)
  if (!p.lines.length) throw new Error(p.problems[0] ?? 'No lines found in this file.')
  return db.transaction((tx) => importStatement(tx, actorOf(u), bankId, { name: f.name, sha256: f.sha256 }, cols, p.lines))
}

export async function confirmStatementAction(items: unknown) {
  const u = await requirePermission('payments.record')
  return db.transaction((tx) => confirmStatementLines(tx, actorOf(u), items))
}

export async function ignoreStatementAction(lineId: number, reason: string) {
  const u = await requirePermission('payments.record')
  await db.transaction((tx) => ignoreStatementLine(tx, actorOf(u), idOf(lineId), reason))
}
