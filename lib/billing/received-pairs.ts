// Direct bill from an order (owner, 23 Nov 2026). Server only.
//
// An order the admin sent straight to billing skips the picker. When it is billed, the pairs the
// biller actually scanned for each order line are saved on the line (quantityPacked; 0 = out of
// stock), so what was not received stays marked on the order. One statement + audit.

import { sql } from 'drizzle-orm'
import type { Actor, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'

export interface ReceivedPairs { itemId: number; qty: number }
export interface ShortLine { itemId: number; artNumber: string; sizeNumber: string | null; ordered: number; received: number }

export async function recordReceivedPairs(tx: Tx, actor: Actor, orderId: number, packed: ReceivedPairs[]): Promise<ShortLine[]> {
  const rows = packed.map((p) => ({ id: Math.floor(Number(p.itemId)), q: Math.max(0, Math.floor(Number(p.qty) || 0)) })).filter((r) => r.id > 0)
  if (!rows.length) return []
  const res = (await tx.execute<{ id: number; artNumber: string; sizeNumber: string | null; ordered: number; packed: number }>(sql`
    UPDATE order_items i SET "quantityPacked" = LEAST(x.q, i."quantityOrdered"),
      status = (CASE WHEN x.q = 0 THEN 'out_of_stock' ELSE 'packed' END)::order_item_status
    FROM json_to_recordset(${JSON.stringify(rows)}::json) AS x(id int, q int)
    WHERE i.id = x.id AND i."orderId" = ${orderId}
    RETURNING i.id, i."artNumber", i."sizeNumber", i."quantityOrdered" AS ordered, i."quantityPacked" AS packed`)).rows
  const short = res.filter((r) => Number(r.packed) < Number(r.ordered))
    .map((r) => ({ itemId: Number(r.id), artNumber: r.artNumber, sizeNumber: r.sizeNumber, ordered: Number(r.ordered), received: Number(r.packed) }))
  await audit(tx, { actor, action: 'order.direct_billed', entityType: 'order', entityId: orderId, after: { short } })
  return short
}
