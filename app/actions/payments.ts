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
