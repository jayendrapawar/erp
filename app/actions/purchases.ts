'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/authz'
import * as store from '@/lib/purchases/store'
import { manualCartonOptions, receiveManualCarton, type ManualOptions, type ManualReceiveInput, type ManualReceiveOutcome } from '@/lib/purchases/manual-carton'
import { SETTING_BILL_MAIL_START, getSetting, setSetting } from '@/lib/settings'
import type { AssortmentAnswer } from '@/lib/purchases/assortment-entry'

export interface MailStartState { day: string | null; updatedByName: string; updatedAt: string | null }

// Purchases screen. Reads: one query each (bill detail: four). Writes: one transaction each.

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

/**
 * Receive a scanned carton. First call (no answer): a multi-size carton comes back as 'confirm'
 * with its proposed assortment (reads only). Second call with the answer: saved and posted.
 */
export async function receiveCartonAction(input: { rawInput: string; clientEventId: string; billId?: number | null; answer?: AssortmentAnswer | null }): Promise<store.ReceiveOutcome> {
  const u = await requirePermission('purchases.receive')
  const out = await store.receiveCarton(db, actorOf(u), input)
  return out
}

/** Manual carton entry, step 1: read a pair box from the carton; list the invoice lines it fits. 2 reads. */
export async function manualCartonOptionsAction(rawBox: string): Promise<ManualOptions> {
  await requirePermission('purchases.receive')
  return manualCartonOptions(db, rawBox)
}

/** Manual carton entry, step 2: receive the carton against the chosen invoice line. 1 transaction. */
export async function receiveManualCartonAction(input: ManualReceiveInput): Promise<ManualReceiveOutcome> {
  const u = await requirePermission('purchases.receive')
  return receiveManualCarton(db, actorOf(u), input)
}

export async function voidCartonAction(receiptId: number, reason: string): Promise<void> {
  const u = await requirePermission('purchases.manage')
  await store.voidCartonReceipt(db, actorOf(u), receiptId, reason)
  revalidatePath('/inventory')
}

export async function setLineAssortmentAction(lineId: number, assortmentId: number, addArticle = false): Promise<void> {
  const u = await requirePermission('purchases.manage')
  await store.setLineAssortment(db, actorOf(u), lineId, assortmentId, addArticle)
}

export async function setBillDivisionAction(billId: number, division: string): Promise<void> {
  const u = await requirePermission('purchases.manage')
  await store.setBillDivision(db, actorOf(u), billId, division)
}

/**
 * Turn reading bills from mail on from a day (yyyy-mm-dd), or off (null). Admin only, audited.
 * Owner (19 Nov 2026): on the live site, only once the warehouse stocktake is complete.
 */
export async function setBillMailStartAction(day: string | null): Promise<MailStartState> {
  const u = await requirePermission('purchases.mail_start')
  if (day !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new Error('Choose a date.')
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
    if (day > today) throw new Error('The start date cannot be in the future.')
  }
  await setSetting(db, actorOf(u), SETTING_BILL_MAIL_START, day, day ? 'reading bills from mail switched on' : 'reading bills from mail switched off')
  const s = await getSetting<string>(db, SETTING_BILL_MAIL_START)
  return { day: s?.value ?? null, updatedByName: s?.updatedByName ?? u.name, updatedAt: s?.updatedAt ?? null }
}

export async function cancelBillAction(billId: number, reason: string): Promise<void> {
  const u = await requirePermission('purchases.manage')
  await store.cancelBill(db, actorOf(u), billId, reason)
}

