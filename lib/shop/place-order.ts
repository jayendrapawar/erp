// Placing a retailer shop order (owner, 21 Nov 2026). One transaction: check the retailer (still on,
// same PIN as the session) and every item / size (1 query each), write the order (status
// to_confirm, source retailer) and its lines (2), audit (1). Used by app/actions/shop.ts.

import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { nextOrderNumber } from '@/lib/orders/order-number'

const MAX_LINES = 300
const MAX_QTY = 999

export interface ShopLine { itemId: number; size: string; qty: number }


export async function placeShopOrderFor(db: Db, s: { retailerId: string; pinSetAt: number }, input: { lines: ShopLine[]; notes?: string }): Promise<{ orderId: number; orderNumber: string; pairs: number }> {
  const lines = (input.lines ?? [])
    .map((l) => ({ itemId: Number(l.itemId), size: String(l.size ?? '').trim(), qty: Math.round(Number(l.qty)) }))
    .filter((l) => Number.isInteger(l.itemId) && l.itemId > 0 && l.size && l.qty > 0)
  if (lines.length === 0) throw new Error('The cart is empty.')
  if (lines.length > MAX_LINES) throw new Error(`At most ${MAX_LINES} lines in one order.`)
  if (lines.some((l) => l.qty > MAX_QTY)) throw new Error(`At most ${MAX_QTY} pairs of one size in one line.`)
  const notes = (input.notes ?? '').trim().slice(0, 500)

  return db.transaction(async (tx) => {
    const r = (await tx.execute<{ id: string; partyName: string; phone: string; address: string; city: string; shopEnabled: boolean; shopPinSetAt: string | null }>(sql`
      SELECT id, "partyName", phone, address, city, "shopEnabled", "shopPinSetAt" FROM retailers WHERE id = ${s.retailerId}`)).rows[0]
    if (!r || !r.shopEnabled || (r.shopPinSetAt ? new Date(r.shopPinSetAt).getTime() : 0) !== s.pinSetAt) {
      throw new Error('Your shop access has changed. Please sign in again.')
    }
    const ids = [...new Set(lines.map((l) => l.itemId))]
    const known = (await tx.execute<{ id: number; artName: string; artCode: string; color: string; sizes: string[] | null }>(sql`
      SELECT a.id, a."artName", a."artCode", a.color,
             (SELECT json_agg(s."sizeLabel") FROM article_sizes s WHERE s."articleId" = a.id AND s.active) AS sizes
      FROM articles a
      WHERE a.active AND a.id IN (SELECT (x)::int FROM json_array_elements_text(${JSON.stringify(ids)}::json) x)`)).rows
    const byId = new Map(known.map((k) => [k.id, k]))
    for (const l of lines) {
      const a = byId.get(l.itemId)
      if (!a) throw new Error('An article in your cart is no longer available. Remove it and try again.')
      if (!(a.sizes ?? []).includes(l.size)) throw new Error(`${a.artName} ${a.color}: size ${l.size} is no longer available.`)
    }
    // Same lines for the same size are added together.
    const merged = new Map<string, ShopLine>()
    for (const l of lines) {
      const k = `${l.itemId}|${l.size}`
      merged.set(k, { ...l, qty: (merged.get(k)?.qty ?? 0) + l.qty })
    }
    const number = await nextOrderNumber(tx) // ORD-1, ORD-2 … (lib/orders/order-number.ts)
    const [o] = (await tx.execute<{ id: number }>(sql`
      INSERT INTO orders ("orderNumber", "shopkeeperName", "shopkeeperPhone", "shopkeeperAddress", "retailerId", status, source, notes)
      VALUES (${number}, ${r.partyName}, ${r.phone || null}, ${[r.address, r.city].filter(Boolean).join(', ') || null}, ${r.id},
              'to_confirm', 'retailer', ${notes || null})
      RETURNING id`)).rows
    const rows = [...merged.values()].map((l) => {
      const a = byId.get(l.itemId)!
      return { art: a.artName.toUpperCase(), colour: a.color.toUpperCase(), size: l.size.toUpperCase(), code: a.artCode.trim().toUpperCase(), qty: l.qty }
    })
    await tx.execute(sql`
      INSERT INTO order_items ("orderId", "artNumber", "colorNumber", "sizeNumber", "artCode", "quantityOrdered")
      SELECT ${o.id}, x.art, x.colour, x.size, x.code, x.qty
      FROM json_to_recordset(${JSON.stringify(rows)}::json) AS x(art text, colour text, size text, code text, qty int)`)
    const pairs = rows.reduce((t, x) => t + x.qty, 0)
    await audit(tx, { actor: { id: null, name: `Retailer: ${r.partyName}` }, action: 'order.placed_in_shop', entityType: 'order', entityId: o.id, after: { orderNumber: number, lines: rows.length, pairs } })
    return { orderId: o.id, orderNumber: number, pairs }
  })
}
