'use server'

// Retailer shop (owner, 21 Nov 2026): sign in with phone + PIN, place orders that wait for staff
// ("to_confirm"), see own orders. Queries per action are noted.

import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { placeShopOrderFor, type ShopLine } from '@/lib/shop/place-order'
import {
  PIN_LOCK_MINUTES, PIN_MAX_TRIES, clearShopSession, getShopSession, normalizeShopPhone, setShopSession, verifyPin,
} from '@/lib/shop/auth'

/** Sign in. 1 query, +1 to count a wrong PIN or reset the count. Same message for any failure. */
export async function shopSignIn(phoneInput: string, pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const phone = normalizeShopPhone(phoneInput)
  const generic = { ok: false as const, message: 'Phone number or PIN is not right.' }
  if (!phone || !/^\d{4,6}$/.test(pin)) return generic
  const r = await db.execute<{ id: string; partyName: string; shopPinHash: string; shopEnabled: boolean; shopPinSetAt: string | null; shopFailedPins: number; shopLockedUntil: string | null }>(sql`
    SELECT id, "partyName", "shopPinHash", "shopEnabled", "shopPinSetAt", "shopFailedPins", "shopLockedUntil"
    FROM retailers WHERE "shopPhone" = ${phone} LIMIT 1`)
  const x = r.rows[0]
  if (!x || !x.shopEnabled || !x.shopPinHash) return generic
  if (x.shopLockedUntil && new Date(x.shopLockedUntil).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(x.shopLockedUntil).getTime() - Date.now()) / 60_000)
    return { ok: false, message: `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask the shop for a new PIN.` }
  }
  if (!(await verifyPin(pin, x.shopPinHash))) {
    const fails = x.shopFailedPins + 1
    await db.execute(sql`UPDATE retailers SET "shopFailedPins" = ${fails >= PIN_MAX_TRIES ? 0 : fails},
      "shopLockedUntil" = ${fails >= PIN_MAX_TRIES ? sql`now() + make_interval(mins => ${PIN_LOCK_MINUTES})` : sql`"shopLockedUntil"`} WHERE id = ${x.id}`)
    return fails >= PIN_MAX_TRIES ? { ok: false, message: `Too many wrong PINs. Sign-in is locked for ${PIN_LOCK_MINUTES} minutes.` } : generic
  }
  if (x.shopFailedPins || x.shopLockedUntil) await db.execute(sql`UPDATE retailers SET "shopFailedPins" = 0, "shopLockedUntil" = NULL WHERE id = ${x.id}`)
  await setShopSession(x.id, x.partyName, x.shopPinSetAt ? new Date(x.shopPinSetAt) : null)
  return { ok: true }
}

export async function shopSignOut(): Promise<void> {
  await clearShopSession()
}

/** Place an order (see lib/shop/place-order.ts): 1 transaction, 5 statements. */
export async function placeShopOrder(input: { lines: ShopLine[]; notes?: string }): Promise<{ orderNumber: string; pairs: number }> {
  const s = await getShopSession()
  if (!s) throw new Error('Please sign in again.')
  const r = await placeShopOrderFor(db, s, input)
  revalidatePath('/orders/admin')
  revalidatePath('/orders')
  return { orderNumber: r.orderNumber, pairs: r.pairs }
}

export interface MyShopOrder { orderNumber: string; status: string; orderedAt: string; lines: number; pairs: number }

/** The signed-in retailer's last 30 shop orders. 1 query. */
export async function getMyShopOrders(): Promise<MyShopOrder[]> {
  const s = await getShopSession()
  if (!s) throw new Error('Please sign in again.')
  const r = await db.execute<{ orderNumber: string; status: string; orderedAt: string; lines: number; pairs: number }>(sql`
    SELECT o."orderNumber", o.status, o."orderedAt", count(i.id)::int AS lines, coalesce(sum(i."quantityOrdered"), 0)::int AS pairs
    FROM orders o LEFT JOIN order_items i ON i."orderId" = o.id
    WHERE o."retailerId" = ${s.retailerId} AND o.source = 'retailer'
    GROUP BY o.id ORDER BY o."orderedAt" DESC LIMIT 30`)
  return r.rows.map((x) => ({ ...x, orderedAt: new Date(x.orderedAt).toISOString() }))
}
