'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/authz'
import * as store from '@/lib/purchases/store'

// Purchases screen. Reads: one query each (bill detail: three). Writes: one transaction each.

const actorOf = (u: { id: string; name: string }) => ({ id: u.id, name: u.name })

export async function getPurchaseOverview(): Promise<{ summary: store.PurchaseSummary; bills: store.BillRow[] }> {
  await requirePermission('purchases.view')
  const [summary, bills] = await Promise.all([store.purchaseSummary(db), store.listBills(db, { limit: 200 })])
  return { summary, bills }
}

export async function getBillDetail(billId: number): Promise<store.BillDetail | null> {
  await requirePermission('purchases.view')
  return store.billDetail(db, billId)
}

export async function getExpectedStock(search: string): Promise<store.ExpectedStockRow[]> {
  await requirePermission('purchases.view')
  return store.expectedStock(db, search)
}

export async function getReceipts(opts: { unexpected?: boolean }): Promise<store.ReceiptRow[]> {
  await requirePermission('purchases.view')
  return store.listReceipts(db, { unexpected: opts.unexpected, limit: 100 })
}

export async function getOpenBills(): Promise<store.BillRow[]> {
  await requirePermission('purchases.view')
  return store.listBills(db, { open: true, limit: 100 })
}

export async function receiveCartonAction(input: { rawInput: string; clientEventId: string; billId?: number | null }): Promise<store.ReceiveOutcome> {
  const u = await requirePermission('purchases.receive')
  const out = await store.receiveCarton(db, actorOf(u), input)
  return out
}

export async function voidCartonAction(receiptId: number, reason: string): Promise<void> {
  const u = await requirePermission('purchases.manage')
  await store.voidCartonReceipt(db, actorOf(u), receiptId, reason)
  revalidatePath('/inventory')
}

export async function setLineAssortmentAction(lineId: number, assortmentId: number): Promise<{ posted: number }> {
  const u = await requirePermission('purchases.manage')
  const r = await store.setLineAssortment(db, actorOf(u), lineId, assortmentId)
  revalidatePath('/inventory')
  return r
}

export async function setBillDivisionAction(billId: number, division: string): Promise<void> {
  const u = await requirePermission('purchases.manage')
  await store.setBillDivision(db, actorOf(u), billId, division)
}

export async function cancelBillAction(billId: number, reason: string): Promise<void> {
  const u = await requirePermission('purchases.manage')
  await store.cancelBill(db, actorOf(u), billId, reason)
}

/** Post cartons waiting for stock (after articles or assortments were added elsewhere). */
export async function retryPendingCartons(billId?: number): Promise<{ posted: number; pending: number }> {
  const u = await requirePermission('purchases.manage')
  const r = await db.transaction((tx) => store.postPendingCartons(tx, actorOf(u), billId ? { billId } : {}))
  revalidatePath('/inventory')
  return r
}
