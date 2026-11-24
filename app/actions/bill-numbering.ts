'use server'

// Master → Bill template → Bill numbers (admin; owner, 22 Nov 2026). At go-live the admin sets "Next
// bill number" to the old software's next number so both match. Two series (owner, 23 Nov 2026): GST
// bills, and bills without GST (small parties, walk-in), each with its own prefix and counter; and
// credit notes (CN series, migration 0018; their numbers live in credit_notes, so no clash check).
// 2 queries to read a series; save = 1 transaction (check the other series' prefix, highest used,
// update, audit).

import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/authz'
import { audit } from '@/lib/audit'
import {
  SALE_BILL, SALE_BILL_UNTAXED, formatBillNo, prefixesClash, getBillNumbering, highestBillNumber, type BillNumbering, type BillSeries,
} from '@/lib/billing/bill-number'

export type NumberSeries = BillSeries | 'credit_note'

function seriesOf(v: unknown): NumberSeries {
  if (v === undefined || v === SALE_BILL) return SALE_BILL
  if (v === SALE_BILL_UNTAXED) return SALE_BILL_UNTAXED
  if (v === 'credit_note') return 'credit_note'
  throw new Error('Unknown number series.')
}

/** Highest number already used with this prefix: bills in orders, credit notes in credit_notes. 1 query. */
async function highestUsed(db: Parameters<typeof highestBillNumber>[0], series: NumberSeries, prefix: string): Promise<number> {
  if (series !== 'credit_note') return highestBillNumber(db, prefix)
  const r = (await db.execute<{ max: string | null }>(sql`
    SELECT max(substring("noteNo" FROM ${prefix.length + 1}::int)::bigint) AS max FROM credit_notes
    WHERE left("noteNo", ${prefix.length}::int) = ${prefix} AND substring("noteNo" FROM ${prefix.length + 1}::int) ~ '^[0-9]{1,15}$'`)).rows[0]
  return Number(r?.max ?? 0)
}

export async function getBillNumberingSetup(series?: NumberSeries): Promise<BillNumbering & { highestUsed: number }> {
  await requirePermission('settings.bill')
  const s = seriesOf(series)
  const n = await getBillNumbering(db, s as BillSeries)
  return { ...n, highestUsed: await highestUsed(db, s, n.prefix) }
}

export async function saveBillNumbering(input: { prefix: string; next: number; padding: number; series?: NumberSeries }): Promise<BillNumbering & { highestUsed: number }> {
  const u = await requirePermission('settings.bill')
  const series = seriesOf(input.series)
  const other: BillSeries = series === SALE_BILL ? SALE_BILL_UNTAXED : SALE_BILL
  const prefix = String(input.prefix ?? '').trim()
  if (prefix.length > 12 || !/^[A-Za-z0-9/-]*$/.test(prefix)) throw new Error('The prefix may have up to 12 letters, digits, "/" or "-" (e.g. SSP/26-27/).')
  const next = Math.floor(Number(input.next))
  if (!Number.isFinite(next) || next < 1 || next > 9_999_999_999) throw new Error('Enter the next bill number (a whole number, 1 or more).')
  const padding = Math.floor(Number(input.padding))
  if (!Number.isFinite(padding) || padding < 0 || padding > 10) throw new Error('Digits must be 0 to 10.')
  if (formatBillNo(prefix, next, padding).length > 16) throw new Error('A GST bill number may have at most 16 characters — shorten the prefix.')
  await db.transaction(async (tx) => {
    const before = await getBillNumbering(tx, series as BillSeries)
    // The two bill series must never give the same number (prefix "E" + 123 = prefix "E1" + 23).
    const o = await getBillNumbering(tx, other)
    if (series !== 'credit_note' && prefixesClash(prefix, o.prefix)) {
      throw new Error(`The ${other === SALE_BILL ? 'GST bills' : 'bills without GST'} already use the prefix "${o.prefix || '(none)'}". Use a different prefix so the two series never give the same number.`)
    }
    const used = await highestUsed(tx, series, prefix)
    if (next <= used) throw new Error(`${series === 'credit_note' ? 'Credit note' : 'Bill'} ${formatBillNo(prefix, used, padding)} is already used. The next number must be ${used + 1} or more.`)
    await tx.execute(sql`UPDATE document_sequences SET prefix = ${prefix}, next = ${next}, padding = ${padding}, "updatedAt" = now(), "updatedByName" = ${u.name}
      WHERE name = ${series}`)
    await audit(tx, { actor: { id: u.id, name: u.name }, action: 'bill_numbering.changed', entityType: 'document_sequence', entityId: series,
      before: { prefix: before.prefix, next: before.next, padding: before.padding }, after: { prefix, next, padding } })
  })
  return getBillNumberingSetup(series)
}
