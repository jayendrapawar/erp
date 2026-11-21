'use server'

import { assignBillNo, stampBillLineHsn } from '@/lib/billing/bill-number'
import { revalidatePath } from 'next/cache'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { billLines, orders } from '@/lib/db/schema'
import { requireAnyRole } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import {
  addDraftScan, createDraft, discardDraft, generateDirectBill, listOpenDrafts, loadDraft, recordOrderScans, removeDraftScans, saveDraftHeader,
  type AddScanOutcome, type DraftDetail, type DraftHeader, type DraftSummary, type GeneratedBill, type StockOutCounts,
} from '@/lib/billing/bill-stock'

// Direct Billing (formerly "Emergency Bill") and order invoices. Every box a biller scans is
// saved at once; generating a bill takes its boxes out of stock (lib/billing/bill-stock.ts).

const biller = async () => {
  const u = await requireAnyRole('biller', 'admin')
  return { id: u.id, name: u.name }
}

export async function getOpenDirectBillDrafts(): Promise<DraftSummary[]> {
  await biller()
  return listOpenDrafts(db)
}

export async function startDirectBillDraft(header: Partial<DraftHeader> = {}): Promise<number> {
  return createDraft(db, await biller(), header)
}

export async function openDirectBillDraft(draftId: number): Promise<DraftDetail> {
  await biller()
  return loadDraft(db, draftId)
}

export async function saveDirectBillDraft(draftId: number, header: Partial<DraftHeader>): Promise<void> {
  await biller()
  await saveDraftHeader(db, draftId, header)
}

/**
 * Save one scanned box on the draft. Also says whether its article is in the master and whether
 * this user may add it there (admins get the New Article form; billers a warning).
 */
export async function scanIntoDirectBill(draftId: number, rawInput: string, clientEventId: string): Promise<AddScanOutcome & { canCreateArticle: boolean }> {
  const u = await requireAnyRole('biller', 'admin')
  const out = await addDraftScan(db, { id: u.id, name: u.name }, draftId, rawInput, clientEventId)
  return { ...out, canCreateArticle: hasPermission(u.roles, 'articles.create_from_scan') }
}

export async function removeFromDirectBill(draftId: number, rawInputs: string[]): Promise<number> {
  await biller()
  return removeDraftScans(db, draftId, rawInputs.slice(0, 2000), 'removed from bill')
}

export async function discardDirectBillDraft(draftId: number): Promise<void> {
  await discardDraft(db, await biller(), draftId)
}

export async function generateDirectBillFromDraft(draftId: number, header: Partial<DraftHeader>): Promise<GeneratedBill> {
  const out = await generateDirectBill(db, await biller(), draftId, header)
  revalidatePath('/orders/admin')
  revalidatePath('/inventory')
  return out
}

/**
 * Bill an order (Invoices tab): status → billed, bill lines replaced, scanned boxes recorded and
 * taken out of stock. One transaction; refuses if a box is already on another bill.
 */
export async function billOrder(
  orderId: number,
  scannedQrs: string[],
  lines: { artNumber: string; mrp: number; qty: number }[],
  lineDiscPct: number,
): Promise<StockOutCounts & { skipped: number; billNo: string }> {
  const actor = await biller()
  const out = await db.transaction(async (tx) => {
    const [o] = await tx.select({ orderNumber: orders.orderNumber, status: orders.status }).from(orders).where(eq(orders.id, orderId)).for('update')
    if (!o) throw new Error('Order not found.')
    if (o.status === 'cancelled' || o.status === 'delivered') throw new Error(`This order is ${o.status}.`)
    await tx.update(orders).set({ status: 'billed', billerId: actor.id, billedAt: sql`now()`, isEmergency: false, updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId)))
    await tx.delete(billLines).where(eq(billLines.orderId, orderId))
    const clean = lines.filter((l) => l.artNumber && Number(l.qty) > 0)
    if (clean.length) {
      await tx.insert(billLines).values(clean.map((l) => ({ orderId, artNumber: l.artNumber, mrp: String(Number(l.mrp) || 0), qty: Math.floor(Number(l.qty)), lineDiscPct: String(lineDiscPct) })))
    }
    // Official bill number (kept when billed again) and HSN on each line — same transaction.
    const billNo = await assignBillNo(tx, orderId)
    await stampBillLineHsn(tx, orderId)
    const counts = await recordOrderScans(tx, actor, orderId, o.orderNumber, Array.isArray(scannedQrs) ? scannedQrs : [])
    return { ...counts, billNo }
  })
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/biller')
  revalidatePath('/orders/dispatcher')
  revalidatePath('/inventory')
  return out
}
