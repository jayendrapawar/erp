'use server'

// Master → Bill template → Bill numbers (admin; owner, 22 Nov 2026). At go-live the admin sets "Next
// bill number" to the old software's next number so both match. Two series (owner, 23 Nov 2026): GST
// bills, and bills without GST (small parties, walk-in), each with its own prefix and counter.
// 2 queries to read a series; save = 1 transaction (check the other series' prefix, highest used,
// update, audit).

import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/authz'
import { audit } from '@/lib/audit'
import {
  SALE_BILL, SALE_BILL_UNTAXED, formatBillNo, prefixesClash, getBillNumbering, highestBillNumber, type BillNumbering, type BillSeries,
} from '@/lib/billing/bill-number'

function seriesOf(v: unknown): BillSeries {
  if (v === undefined || v === SALE_BILL) return SALE_BILL
  if (v === SALE_BILL_UNTAXED) return SALE_BILL_UNTAXED
  throw new Error('Unknown bill series.')
}

export async function getBillNumberingSetup(series?: BillSeries): Promise<BillNumbering & { highestUsed: number }> {
  await requirePermission('settings.bill')
  const s = seriesOf(series)
  const n = await getBillNumbering(db, s)
  return { ...n, highestUsed: await highestBillNumber(db, n.prefix) }
}

export async function saveBillNumbering(input: { prefix: string; next: number; padding: number; series?: BillSeries }): Promise<BillNumbering & { highestUsed: number }> {
  const u = await requirePermission('settings.bill')
  const series = seriesOf(input.series)
  const other = series === SALE_BILL ? SALE_BILL_UNTAXED : SALE_BILL
  const prefix = String(input.prefix ?? '').trim()
  if (prefix.length > 12 || !/^[A-Za-z0-9/-]*$/.test(prefix)) throw new Error('The prefix may have up to 12 letters, digits, "/" or "-" (e.g. SSP/26-27/).')
  const next = Math.floor(Number(input.next))
  if (!Number.isFinite(next) || next < 1 || next > 9_999_999_999) throw new Error('Enter the next bill number (a whole number, 1 or more).')
  const padding = Math.floor(Number(input.padding))
  if (!Number.isFinite(padding) || padding < 0 || padding > 10) throw new Error('Digits must be 0 to 10.')
  if (formatBillNo(prefix, next, padding).length > 16) throw new Error('A GST bill number may have at most 16 characters — shorten the prefix.')
  await db.transaction(async (tx) => {
    const before = await getBillNumbering(tx, series)
    // The two series must never give the same number (prefix "E" + 123 = prefix "E1" + 23).
    const o = await getBillNumbering(tx, other)
    if (prefixesClash(prefix, o.prefix)) {
      throw new Error(`The ${other === SALE_BILL ? 'GST bills' : 'bills without GST'} already use the prefix "${o.prefix || '(none)'}". Use a different prefix so the two series never give the same number.`)
    }
    const used = await highestBillNumber(tx, prefix)
    if (next <= used) throw new Error(`Bill ${formatBillNo(prefix, used, padding)} is already used. The next number must be ${used + 1} or more.`)
    await tx.execute(sql`UPDATE document_sequences SET prefix = ${prefix}, next = ${next}, padding = ${padding}, "updatedAt" = now(), "updatedByName" = ${u.name}
      WHERE name = ${series}`)
    await audit(tx, { actor: { id: u.id, name: u.name }, action: 'bill_numbering.changed', entityType: 'document_sequence', entityId: series,
      before: { prefix: before.prefix, next: before.next, padding: before.padding }, after: { prefix, next, padding } })
  })
  return getBillNumberingSetup(series)
}
