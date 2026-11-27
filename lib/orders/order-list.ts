// Order lists for the salesman screen (server only). Owner, 22 Nov 2026: a salesman sees only his
// own orders; admin and accountant see everyone's.
//
// First load: open orders of any age + delivered/cancelled orders of the last 60 days, max 2000,
// newest first (same rule as Orders → Overview). Older history: "Load older" pages of 100, keyset on
// (orderedAt, id) after the oldest order already shown (the screen drops ones it already has).
// One query per call.

import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import { orders, user } from '@/lib/db/schema'
import type { DbOrTx } from '@/lib/db/types'

export const RECENT_LIMIT = 2000
export const OLDER_PAGE = 100

/** Whose orders: one salesman's, or everyone's (admin / accountant). */
export type OrderScope = { salesmanId: string } | { all: true }

const COLUMNS = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  shopkeeperName: orders.shopkeeperName,
  shopkeeperAddress: orders.shopkeeperAddress,
  status: orders.status,
  notes: orders.notes,
  orderedAt: orders.orderedAt,
  updatedAt: orders.updatedAt,
  salesmanName: user.name,
}

export type OrderListRow = { id: number; orderNumber: string; shopkeeperName: string; shopkeeperAddress: string | null; status: string; notes: string | null; orderedAt: Date; updatedAt: Date; salesmanName: string | null }

const scoped = (scope: OrderScope): SQL | undefined => ('salesmanId' in scope ? eq(orders.salesmanId, scope.salesmanId) : undefined)

/** Open orders of any age + closed ones of the last 60 days, newest first, max 2000. */
export function recentOrders(db: DbOrTx, scope: OrderScope): Promise<OrderListRow[]> {
  return db.select(COLUMNS).from(orders).leftJoin(user, eq(orders.salesmanId, user.id))
    .where(and(scoped(scope), sql`(${orders.status} NOT IN ('delivered', 'cancelled') OR ${orders.orderedAt} > now() - interval '60 days')`))
    .orderBy(desc(orders.orderedAt), desc(orders.id))
    .limit(RECENT_LIMIT)
}

/**
 * The next 100 orders older than order `beforeId` (by orderedAt, then id), in the same scope; with
 * `beforeId` null, from the 60-day line down. The screen passes its oldest order that is closed or
 * recent — never an old open one, which would skip the history between it and the 60-day line.
 * Open orders that come again are dropped by the screen.
 */
export function olderOrders(db: DbOrTx, scope: OrderScope, beforeId: number | null): Promise<OrderListRow[]> {
  const after = beforeId == null
    ? sql`${orders.orderedAt} <= now() - interval '60 days'`
    : sql`(${orders.orderedAt}, ${orders.id}) < (SELECT o2."orderedAt", o2.id FROM orders o2 WHERE o2.id = ${beforeId})`
  return db.select(COLUMNS).from(orders).leftJoin(user, eq(orders.salesmanId, user.id))
    .where(and(scoped(scope), after))
    .orderBy(desc(orders.orderedAt), desc(orders.id))
    .limit(OLDER_PAGE)
}
