// Official sale bill numbers (owner, 22 Nov 2026; migration 0016). Server only.
//
// A bill takes its number inside the billing transaction: one locked UPDATE … RETURNING on the
// counter (the same pattern Carbon ERP uses after fixing a read-then-write race), so two bills can
// never share a number, and a bill that fails rolls the counter back (no gaps). An order that already
// has a number keeps it (sent back for editing, billed again). HSN is copied onto the bill lines in
// the same transaction.

import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'

export const SALE_BILL = 'sale_bill'

export interface BillNumbering { prefix: string; next: number; padding: number; updatedByName: string; updatedAt: string }

export function formatBillNo(prefix: string, n: number, padding: number): string {
  return `${prefix}${String(n).padStart(padding, '0')}`
}

/** The order's bill number: its existing one, or the next from the counter. 1–3 statements. */
export async function assignBillNo(tx: DbOrTx, orderId: number): Promise<string> {
  const cur = (await tx.execute<{ billNo: string | null }>(sql`SELECT "billNo" FROM orders WHERE id = ${orderId} FOR UPDATE`)).rows[0]
  if (!cur) throw new Error('Order not found.')
  if (cur.billNo) return cur.billNo
  const seq = (await tx.execute<{ prefix: string; n: string; padding: number }>(sql`
    UPDATE document_sequences SET next = next + 1 WHERE name = ${SALE_BILL}
    RETURNING prefix, next - 1 AS n, padding`)).rows[0]
  if (!seq) throw new Error('Bill numbering is not set up (document_sequences).')
  const billNo = formatBillNo(seq.prefix, Number(seq.n), seq.padding)
  try {
    await tx.execute(sql`UPDATE orders SET "billNo" = ${billNo} WHERE id = ${orderId}`)
  } catch (e) {
    if (/orders_bill_no_key|duplicate key/i.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? ''))) {
      throw new Error(`Bill number ${billNo} is already used. An admin should set "Next bill number" higher in Master → Bill template.`)
    }
    throw e
  }
  return billNo
}

/** Copy each line's HSN from the article (code, else name) onto the order's bill lines. 1 statement. */
export async function stampBillLineHsn(tx: DbOrTx, orderId: number): Promise<void> {
  await tx.execute(sql`
    UPDATE bill_lines b SET hsn = (
      SELECT a.hsn FROM articles a
      WHERE a.hsn <> '' AND (upper(btrim(a."artCode")) = upper(btrim(b."artNumber")) OR upper(btrim(a."artName")) = upper(btrim(b."artNumber")))
      ORDER BY (upper(btrim(a."artCode")) = upper(btrim(b."artNumber"))) DESC, a.active DESC LIMIT 1)
    WHERE b."orderId" = ${orderId} AND b.hsn IS NULL`)
}

/** Current numbering, for Master → Bill template. 1 query. */
export async function getBillNumbering(db: DbOrTx): Promise<BillNumbering> {
  const r = (await db.execute<{ prefix: string; next: string; padding: number; updatedByName: string; updatedAt: string }>(sql`
    SELECT prefix, next, padding, "updatedByName", "updatedAt" FROM document_sequences WHERE name = ${SALE_BILL}`)).rows[0]
  if (!r) return { prefix: '', next: 1, padding: 0, updatedByName: '', updatedAt: '' }
  return { prefix: r.prefix, next: Number(r.next), padding: r.padding, updatedByName: r.updatedByName, updatedAt: new Date(r.updatedAt).toISOString() }
}

/** Highest number already given with this prefix (a new "next" must be above it). 1 query. */
export async function highestBillNumber(db: DbOrTx, prefix: string): Promise<number> {
  const r = (await db.execute<{ max: string | null }>(sql`
    SELECT max(substring("billNo" FROM ${prefix.length + 1}::int)::bigint) AS max FROM orders
    WHERE "billNo" IS NOT NULL AND left("billNo", ${prefix.length}::int) = ${prefix}
      AND substring("billNo" FROM ${prefix.length + 1}::int) ~ '^[0-9]{1,15}$'`)).rows[0]
  return Number(r?.max ?? 0)
}
