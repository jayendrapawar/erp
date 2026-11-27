'use server'

// Orders placed by retailers in the shop wait as "to_confirm" until staff confirm them (owner,
// 21 Nov 2026). Confirm → a normal pending order (picking, billing as usual); Reject → cancelled with
// the reason in the notes (the retailer sees "Cancelled").

import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requireAnyRole } from '@/lib/authz'
import { audit } from '@/lib/audit'

export interface ShopOrderToConfirm {
  id: number
  orderNumber: string
  retailer: string
  phone: string | null
  orderedAt: string
  notes: string | null
  pairs: number
  lines: Array<{ art: string; code: string | null; colour: string | null; size: string | null; qty: number }>
}

/** Retailer orders waiting for staff, oldest first. 1 query. */
export async function getShopOrdersToConfirm(): Promise<ShopOrderToConfirm[]> {
  await requireAnyRole('admin', 'salesman', 'accountant')
  const r = await db.execute<{ id: number; orderNumber: string; retailer: string; phone: string | null; orderedAt: string; notes: string | null; lines: ShopOrderToConfirm['lines'] }>(sql`
    SELECT o.id, o."orderNumber", o."shopkeeperName" AS retailer, o."shopkeeperPhone" AS phone, o."orderedAt", o.notes,
           coalesce(json_agg(json_build_object('art', i."artNumber", 'code', i."artCode", 'colour', i."colorNumber", 'size', i."sizeNumber", 'qty', i."quantityOrdered")
                    ORDER BY i."artNumber", i."colorNumber", i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS lines
    FROM orders o LEFT JOIN order_items i ON i."orderId" = o.id
    WHERE o.status = 'to_confirm'
    GROUP BY o.id ORDER BY o."orderedAt" LIMIT 100`)
  return r.rows.map((x) => ({ ...x, orderedAt: new Date(x.orderedAt).toISOString(), pairs: x.lines.reduce((t, l) => t + Number(l.qty), 0) }))
}

/** Confirm: becomes a normal pending order; the confirming salesman / admin is its salesman. 1 update + audit. */
export async function confirmShopOrder(orderId: number): Promise<void> {
  const u = await requireAnyRole('admin', 'salesman')
  const r = await db.execute<{ orderNumber: string }>(sql`
    UPDATE orders SET status = 'pending', "salesmanId" = coalesce("salesmanId", ${u.id}), "updatedAt" = now()
    WHERE id = ${orderId} AND status = 'to_confirm' RETURNING "orderNumber"`)
  if (!r.rows[0]) throw new Error('This order was already confirmed or cancelled.')
  await audit(db, { actor: { id: u.id, name: u.name }, action: 'order.shop_confirmed', entityType: 'order', entityId: orderId, after: { orderNumber: r.rows[0].orderNumber } })
  revalidatePath('/orders/admin'); revalidatePath('/orders')
}

/** Reject: cancelled, with the reason kept in the notes. 1 update + audit. */
export async function rejectShopOrder(orderId: number, reason: string): Promise<void> {
  const u = await requireAnyRole('admin', 'salesman')
  const why = reason.trim().slice(0, 300)
  if (!why) throw new Error('Write why the order is not accepted (the retailer may ask).')
  const r = await db.execute<{ orderNumber: string }>(sql`
    UPDATE orders SET status = 'cancelled', notes = concat_ws(E'\n', nullif(notes, ''), ${`Not accepted: ${why}`}), "updatedAt" = now()
    WHERE id = ${orderId} AND status = 'to_confirm' RETURNING "orderNumber"`)
  if (!r.rows[0]) throw new Error('This order was already confirmed or cancelled.')
  await audit(db, { actor: { id: u.id, name: u.name }, action: 'order.shop_rejected', entityType: 'order', entityId: orderId, reason: why, after: { orderNumber: r.rows[0].orderNumber } })
  revalidatePath('/orders/admin'); revalidatePath('/orders')
}
