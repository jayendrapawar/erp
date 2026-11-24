'use server'

// Payments (payments step 4; docs/architecture/payments.md). Record: admin + accountant; read: also
// salesmen (they see every party's balance, owner 22 Nov 2026). Each write is one transaction and
// returns the party's new balance, so the screen updates in place (no revalidatePath, no refresh).

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/authz'
import {
  bouncePayment, depositCheque, loadPartyForPayment, recordPayment, returnCheque, reversePayment,
  type PartyForPayment, type RecordedPayment,
} from '@/lib/payments/payments'
import { applyOpenings, parseOpeningSheet, planOpenings, reverseOpening, type OpeningPlan, type OpeningRow } from '@/lib/payments/opening'
import { csvToCells, xlsxToCells } from '@/lib/catalog/article-upload'

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
