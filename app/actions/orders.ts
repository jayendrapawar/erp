'use server'

import { db } from '@/lib/db'
import { orders, orderItems, retailers } from '@/lib/db/schema'
import type { OrderStatus } from '@/lib/db/schema'
import { eq, desc, inArray, sql, and, ilike, gte, lte } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { requireAnyRole } from '@/lib/authz'
import type { Role } from '@/lib/permissions'
import type { Tx } from '@/lib/db/types'
import { releaseOrderScans } from '@/lib/billing/bill-stock'
import { cancelSaleBill, type TaxType } from '@/lib/billing/sale-bill'
import { SALE_BILL_AMOUNT_COLUMNS, amountsFromRow, type BillAmounts, type SaleBillAmountRow } from '@/lib/billing/bill-amounts'
import { audit } from '@/lib/audit'
import { olderOrders, recentOrders, type OrderScope } from '@/lib/orders/order-list'
import { nextOrderNumber } from '@/lib/orders/order-number'
import { assertPickerChoice } from '@/lib/orders/pickers'
import { enforceCredit } from '@/lib/payments/credit'

// ── Auth helpers ──────────────────────────────────────────────────────────────

/** Shared role check (lib/authz). Returns the user with `role` as the stored comma list. */
async function requireRole(...roles: Role[]) {
  const u = await requireAnyRole(...roles)
  return { ...u, role: u.roles.join(',') }
}

/** Exact (case-insensitive) retailer match for the typed party name. */
async function retailerIdFor(tx: Tx, name: string): Promise<string | null> {
  const [r] = await tx.select({ id: retailers.id }).from(retailers)
    .where(sql`lower(btrim(${retailers.partyName})) = lower(btrim(${name}))`).limit(1)
  return r?.id ?? null
}

// Order numbers ORD-1, ORD-2 …: lib/orders/order-number.ts (owner, 24 Nov 2026).

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrderItemInput {
  artNumber: string
  colorNumber?: string
  sizeNumber?: string
  /** Exact article code (the name can cover several codes with the same sizes). */
  artCode?: string
  quantityOrdered: number
}

export interface CreateOrderInput {
  shopkeeperName: string
  notes?: string
  items: OrderItemInput[]
  /** Admin only: place the order although the party is on credit hold (lib/payments/credit.ts). */
  overrideCredit?: boolean
}

// ── Salesman actions ──────────────────────────────────────────────────────────

export async function createOrder(input: CreateOrderInput) {
  const u = await requireRole('salesman', 'admin')

  if (!input.items.length) throw new Error('At least one item required')

  // Header and lines are written together or not at all.
  const order = await db.transaction(async (tx) => {
    const retailerId = await retailerIdFor(tx, input.shopkeeperName)
    // Credit hold (owner, 22 Nov 2026): unpaid past the party's credit days → no new order unless an admin allows it.
    const held = retailerId
      ? await enforceCredit(tx, { retailerId }, { allowed: u.roles.includes('admin'), requested: input.overrideCredit === true })
      : null
    const [created] = await tx.insert(orders).values({
      orderNumber: await nextOrderNumber(tx),
      shopkeeperName: input.shopkeeperName,
      retailerId,
      salesmanId: u.id,
      notes: input.notes,
      status: 'pending',
    }).returning()
    await tx.insert(orderItems).values(
      input.items.map((item) => ({
        orderId: created.id,
        artNumber: item.artNumber.toUpperCase(),
        colorNumber: item.colorNumber?.toUpperCase(),
        sizeNumber: item.sizeNumber?.toUpperCase(),
        artCode: item.artCode?.trim().toUpperCase() || null,
        quantityOrdered: item.quantityOrdered,
      }))
    )
    if (held) {
      await audit(tx, { actor: { id: u.id, name: u.name }, action: 'order.credit_override', entityType: 'order', entityId: created.id,
        after: { retailerId, overduePaise: held.overduePaise, creditDays: held.creditDays, oldest: held.overdue[0] ?? null } })
    }
    return created
  })

  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/salesman')
  return order
}

/** The order as the salesman list shows it (returned by saves, so the screen shows it at once). */
const LIST_ROW = {
  id: orders.id, orderNumber: orders.orderNumber, shopkeeperName: orders.shopkeeperName, shopkeeperAddress: orders.shopkeeperAddress,
  status: orders.status, notes: orders.notes, orderedAt: orders.orderedAt, updatedAt: orders.updatedAt,
}

export async function updateOrder(orderId: number, input: CreateOrderInput) {
  const u = await requireRole('salesman', 'admin')
  const userRoles = u.role.split(',').map(r => r.trim())
  // Check and change in one transaction with the order row locked, so a picker packing it at the
  // same moment cannot slip between the status check and the edit.
  const saved = await db.transaction(async (tx) => {
    const [order] = await tx.select({ salesmanId: orders.salesmanId, status: orders.status })
      .from(orders).where(eq(orders.id, orderId)).limit(1).for('update')
    if (!order) throw new Error('Order not found')
    if (order.salesmanId !== u.id && !userRoles.includes('admin')) throw new Error('Forbidden')
    // A billed order has an issued bill (and a ledger entry): the biller sends it back first (owner, 23 Nov 2026).
    if (order.status === 'billed') throw new Error('This order is billed. Ask the biller to send it back for editing first.')
    if (!['pending', 'assigned', 'packed'].includes(order.status)) throw new Error('Only pending, assigned or packed orders can be edited')

    // Reset order to pending so it re-enters the picker queue
    const statusPatch: Record<string, unknown> = {
      shopkeeperName: input.shopkeeperName,
      notes: input.notes ?? null,
      updatedAt: sql`now()`,
    }
    if (order.status === 'packed') {
      // Send back to pending — clear picker assignment so it re-queues
      statusPatch.status = 'pending'
      statusPatch.pickerId = null
      statusPatch.billerId = null
      statusPatch.packedAt = null
      statusPatch.isEmergency = false // back into the picker flow
    }
    // Header and replacement lines are written together or not at all.
    statusPatch.retailerId = await retailerIdFor(tx, input.shopkeeperName)
    const [row] = await tx.update(orders).set(statusPatch).where(eq(orders.id, orderId)).returning(LIST_ROW)
    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId))
    await tx.insert(orderItems).values(
      input.items.map(item => ({
        orderId,
        artNumber: item.artNumber.toUpperCase(),
        colorNumber: item.colorNumber?.toUpperCase(),
        sizeNumber: item.sizeNumber?.toUpperCase(),
        artCode: item.artCode?.trim().toUpperCase() || null,
        quantityOrdered: item.quantityOrdered,
      }))
    )
    return row
  })

  // Kept: the hub (/orders), admin hub and salesman page show this order; the page the user is on is
  // re-rendered with it, the others are fresh when opened. The screen also shows `saved` at once.
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/salesman')
  return saved
}

/** Admin and accountant see every salesman's orders; anyone else only their own (owner, 22 Nov 2026). */
function orderScope(u: { id: string; roles: Role[] }): OrderScope {
  return u.roles.includes('admin') || u.roles.includes('accountant') ? { all: true } : { salesmanId: u.id }
}

/** Salesman screen: own orders (admin/accountant: all) — open + last 60 days, max 2000. One query. */
export async function getSalesmanOrders() {
  const u = await requireRole('salesman', 'admin', 'picker', 'dispatcher', 'accountant')
  return recentOrders(db, orderScope(u))
}

/** Admin/accountant: ALL salesmen's orders — open + last 60 days, max 2000. One query. */
export async function getAllSalesmanOrders() {
  await requireRole('admin', 'accountant')
  return recentOrders(db, { all: true })
}

/** "Load older": the next 100 orders older than `beforeId` (null = from the 60-day line), same who-sees-what. One query. */
export async function getOlderSalesmanOrders(beforeId: number | null) {
  const u = await requireRole('salesman', 'admin', 'picker', 'dispatcher', 'accountant')
  if (beforeId != null && (!Number.isInteger(beforeId) || beforeId <= 0)) throw new Error('Invalid request.')
  return olderOrders(db, orderScope(u), beforeId)
}

export async function getSalesmanOrderWithItems(orderId: number) {
  await requireRole('salesman', 'admin', 'picker', 'dispatcher', 'accountant')
  const [order] = await db.select().from(orders)
    .where(eq(orders.id, orderId)).limit(1)
  if (!order) throw new Error('Order not found')
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
  return { order, items }
}

export async function cancelOrder(orderId: number) {
  const u = await requireRole('salesman', 'admin', 'accountant')
  const [order] = await db.select({ salesmanId: orders.salesmanId, status: orders.status })
    .from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) throw new Error('Order not found')
  const userRoles = u.role.split(',').map(r => r.trim())
  if (order.salesmanId !== u.id && !userRoles.includes('admin') && !userRoles.includes('accountant')) throw new Error('Forbidden')
  if (!['pending', 'assigned'].includes(order.status)) throw new Error('Only pending or assigned orders can be cancelled')
  // The status is checked again in the UPDATE itself: an order packed in the meantime is not cancelled.
  const [saved] = await db.update(orders)
    .set({ status: 'cancelled', updatedAt: sql`now()` })
    .where(and(eq(orders.id, orderId), inArray(orders.status, ['pending', 'assigned'])))
    .returning(LIST_ROW)
  if (!saved) throw new Error('Only pending or assigned orders can be cancelled (it was just picked up). Reload and check.')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/salesman')
  return saved
}

// ── Picker actions ────────────────────────────────────────────────────────────

/** The signed-in picker's own open orders (owner, 23 Nov 2026: the Picker screen shows My orders only). */
export async function getPickerQueue() {
  const u = await requireRole('picker', 'admin', 'accountant')
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopkeeperName: orders.shopkeeperName,
      status: orders.status,
      orderedAt: orders.orderedAt,
      pickerId: orders.pickerId,
      totalPairs:  sql<number>`cast(coalesce(sum(${orderItems.quantityOrdered}), 0) as int)`,
      packedPairs: sql<number>`cast(coalesce(sum(${orderItems.quantityPacked}),  0) as int)`,
    })
    .from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(and(inArray(orders.status, ['pending', 'assigned']), eq(orders.pickerId, u.id)))
    .groupBy(orders.id)
    .orderBy(desc(orders.orderedAt))
}

/** Picker self-assigns a pending (unassigned) order to themselves. */
export async function selfAssignOrder(orderId: number): Promise<{ orderId: number; pickerId: string }> {
  const u = await requireRole('picker', 'admin')
  // Use a conditional UPDATE (WHERE pickerId IS NULL AND status = 'pending') to prevent
  // a race condition where two pickers claim the same order simultaneously.
  const result = await db.update(orders)
    .set({ pickerId: u.id, status: 'assigned', updatedAt: sql`now()` })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'pending'), sql`${orders.pickerId} is null`))
    .returning({ id: orders.id })
  if (result.length === 0) throw new Error('Order is no longer available')
  revalidatePath('/orders')
  revalidatePath('/orders/picker')
  revalidatePath('/orders/admin')
  return { orderId, pickerId: u.id }
}

/** Picker releases an order they previously claimed back to unassigned/pending. */
export async function unassignOrder(orderId: number): Promise<{ orderId: number }> {
  const u = await requireRole('picker', 'admin')
  const [order] = await db.select({ status: orders.status, pickerId: orders.pickerId })
    .from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) throw new Error('Order not found')
  if (order.status !== 'assigned') throw new Error('Only assigned orders can be released')
  const userRoles = u.role.split(',').map(r => r.trim())
  if (order.pickerId !== u.id && !userRoles.includes('admin')) throw new Error('You can only release orders assigned to you')
  await db.update(orders)
    .set({ pickerId: null, status: 'pending', updatedAt: sql`now()` })
    .where(eq(orders.id, orderId))
  revalidatePath('/orders')
  revalidatePath('/orders/picker')
  revalidatePath('/orders/admin')
  return { orderId }
}

// ── Bill lines ────────────────────────────────────────────────────────────────

export interface PrintableBill {
  lines: { artNumber: string; mrp: number; qty: number; hsn: string | null }[]
  lineDiscPct: number | null
  /** Saved amounts (sale_bills); null for a bill made before migration 0017 that is not backfilled yet. */
  amounts: BillAmounts | null
  /** Still unpaid on the bill (payments); 0 = paid; null = no saved bill. */
  unpaidPaise: number | null
}

/**
 * Lines and saved amounts of up to 100 bills, for printing / preview: ONE query whatever the number
 * of bills (was one getBillLines call per bill).
 */
export async function getBillsForPrint(orderIds: number[]): Promise<Record<number, PrintableBill>> {
  await requireRole('biller', 'admin', 'accountant')
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 100)
  if (!ids.length) return {}
  const rows = (await db.execute<{ id: number; lines: Array<{ artNumber: string; mrp: string; qty: number; disc: string; hsn: string | null }>; amounts: SaleBillAmountRow | null; unpaid: string | null }>(sql`
    SELECT o.id,
      coalesce((SELECT json_agg(json_build_object('artNumber', b."artNumber", 'mrp', b.mrp, 'qty', b.qty, 'disc', b."lineDiscPct",
          'hsn', coalesce(b.hsn, (SELECT a.hsn FROM articles a WHERE a.hsn <> '' AND upper(btrim(a."artCode")) = upper(btrim(b."artNumber")) LIMIT 1))) ORDER BY b.id)
        FROM bill_lines b WHERE b."orderId" = o.id), '[]') AS lines,
      (SELECT row_to_json(x) FROM (SELECT ${sql.raw(SALE_BILL_AMOUNT_COLUMNS)} FROM sale_bills sb WHERE sb."orderId" = o.id AND sb.status = 'active' LIMIT 1) x) AS amounts,
      (SELECT CASE WHEN sb."retailerId" IS NULL THEN 0 ELSE e."amountPaise" - coalesce((SELECT sum(a."amountPaise") FROM party_allocations a WHERE a."debitEntryId" = e.id), 0) END
       FROM sale_bills sb LEFT JOIN party_ledger_entries e ON e."saleBillId" = sb.id AND e.kind = 'bill'
       WHERE sb."orderId" = o.id AND sb.status = 'active' LIMIT 1) AS unpaid
    FROM orders o WHERE o.id IN (SELECT (x)::int FROM json_array_elements_text(${JSON.stringify(ids)}::json) x)`)).rows
  const out: Record<number, PrintableBill> = {}
  for (const r of rows) {
    out[Number(r.id)] = {
      lines: r.lines.map((l) => ({ artNumber: l.artNumber, mrp: Number(l.mrp), qty: Number(l.qty), hsn: l.hsn || null })),
      lineDiscPct: r.lines[0] ? Number(r.lines[0].disc) : null,
      amounts: r.amounts ? amountsFromRow(r.amounts) : null,
      unpaidPaise: r.unpaid == null ? null : Number(r.unpaid),
    }
  }
  return out
}

/** Fetch persisted MRP lines for a billed order. */
export async function getBillLines(orderId: number) {
  await requireRole('biller', 'admin', 'accountant')
  // HSN: stored on the line when billed (migration 0016); older bills look it up from the article.
  const rows = (await db.execute<{ artNumber: string; mrp: string; qty: number; lineDiscPct: string; hsn: string }>(sql`
    SELECT b."artNumber", b.mrp, b.qty, b."lineDiscPct",
           coalesce(b.hsn, (SELECT a.hsn FROM articles a WHERE a.hsn <> '' AND upper(btrim(a."artCode")) = upper(btrim(b."artNumber")) LIMIT 1), '') AS hsn
    FROM bill_lines b WHERE b."orderId" = ${orderId} ORDER BY b.id`)).rows
  return rows.map(r => ({
    artNumber:   r.artNumber,
    mrp:         parseFloat(r.mrp),
    qty:         Number(r.qty),
    lineDiscPct: parseFloat(r.lineDiscPct),
    hsn:         r.hsn || null,
  }))
}

export async function getOrderWithItems(orderId: number) {
  await requireRole('picker', 'dispatcher', 'admin', 'salesman', 'accountant', 'biller')
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) throw new Error('Order not found')
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
  return { order, items }
}

export async function updateItemPacked(itemId: number, quantityPacked: number) {
  await requireRole('picker', 'admin')
  const [item] = await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1)
  if (!item) throw new Error('Item not found')

  const newStatus = quantityPacked >= item.quantityOrdered ? 'packed' : 'pending'

  await db.update(orderItems)
    .set({ quantityPacked, status: newStatus, updatedAt: sql`now()` })
    .where(eq(orderItems.id, itemId))

  revalidatePath('/orders')
  revalidatePath('/orders/admin')
}

export async function markItemOutOfStock(itemId: number) {
  await requireRole('picker', 'admin')
  await db.update(orderItems)
    .set({ status: 'out_of_stock', updatedAt: sql`now()` })
    .where(eq(orderItems.id, itemId))
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
}

export async function markOrderPacked(orderId: number) {
  await requireRole('picker', 'admin')
  await db.update(orders)
    .set({ status: 'packed', packedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId))
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/picker')
}

// Save all item quantities/statuses in one round-trip, then mark the order packed.
// Called once when the picker taps "Pack Order" — replaces the per-item saves.
export async function bulkSaveAndPackOrder(
  orderId: number,
  items: { id: number; quantityPacked: number; status: 'packed' | 'out_of_stock' | 'pending' }[]
) {
  await requireRole('picker', 'admin')

  // Item quantities and the packed status are saved together or not at all.
  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx.update(orderItems)
        .set({ quantityPacked: item.quantityPacked, status: item.status, updatedAt: sql`now()` })
        .where(and(eq(orderItems.id, item.id), eq(orderItems.orderId, orderId)))
    }
    await tx.update(orders)
      .set({ status: 'packed', packedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(orders.id, orderId))
  })

  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/picker')
}

// ── Biller actions ────────────────────────────────────────────────────────────

/** Returns all orders the biller can verify (status = packed) */
export async function getBillerQueue() {
  await requireRole('biller', 'admin', 'accountant')
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      billNo: orders.billNo,
      shopkeeperName: orders.shopkeeperName,
      shopkeeperPhone: orders.shopkeeperPhone,
      shopkeeperAddress: orders.shopkeeperAddress,
      status: orders.status,
      packedAt: orders.packedAt,
      billedAt: orders.billedAt,
      billerId: orders.billerId,
      salesmanId: orders.salesmanId,
      isEmergency: orders.isEmergency,
      // Pairs on the bill (owner, 24 Nov 2026: shown on every bill in the list). Billed orders only.
      billedPairs: sql<number | null>`CASE WHEN ${orders.status} = 'billed' THEN (SELECT coalesce(sum(bl.qty), 0)::int FROM bill_lines bl WHERE bl."orderId" = ${orders.id}) END`,
      // The bill type to start from: the order's retailer, else the exact name match (as billing does).
      taxType: sql<TaxType | null>`(SELECT x."taxType" FROM retailers x
        WHERE x.id = ${orders.retailerId} OR (${orders.retailerId} IS NULL AND lower(btrim(x."partyName")) = lower(btrim(${orders.shopkeeperName})))
        ORDER BY (x.id = ${orders.retailerId}) DESC NULLS LAST LIMIT 1)`,
      // Paid / part-paid / unpaid (payments, owner 22 Nov 2026): the saved bill's total and what is still
      // unpaid on it (a walk-in bill is paid at once). Billed orders only.
      billTotalPaise: sql<number | null>`(SELECT sb."grandTotalPaise"::float8 FROM sale_bills sb WHERE sb."orderId" = "orders".id AND sb.status = 'active' LIMIT 1)`,
      unpaidPaise: sql<number | null>`(SELECT CASE WHEN sb."retailerId" IS NULL THEN 0
          ELSE (e."amountPaise" - coalesce((SELECT sum(a."amountPaise") FROM party_allocations a WHERE a."debitEntryId" = e.id), 0))::float8 END
        FROM sale_bills sb LEFT JOIN party_ledger_entries e ON e."saleBillId" = sb.id AND e.kind = 'bill'
        WHERE sb."orderId" = "orders".id AND sb.status = 'active' LIMIT 1)`,
    })
    .from(orders)
    .where(inArray(orders.status, ['packed', 'billed']))
    .orderBy(desc(orders.packedAt))
}

// Billing (order invoices, Direct Bills) and Cancel bill: app/actions/billing.ts.

/** Biller sends order back to salesman for editing (resets to pending); its bill is cancelled (ledger reversed). */
export async function sendBackToEdit(orderId: number) {
  const u = await requireRole('biller', 'admin')
  await db.transaction(async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for('update')
    if (!o) throw new Error('Order not found')
    if (!['packed', 'billed'].includes(o.status)) throw new Error(`Only packed or billed orders can be sent back (this one is ${o.status}).`)
    // Boxes billed for this order go back into stock; the bill is cancelled and its ledger entry reversed.
    await releaseOrderScans(tx, { id: u.id, name: u.name }, orderId, 'order sent back for editing')
    await cancelSaleBill(tx, { id: u.id, name: u.name }, orderId, 'sent back for editing')
    await tx.update(orders)
      .set({
        status: 'pending',
        pickerId: null,
        billerId: null,
        packedAt: null,
        billedAt: null,
        isEmergency: false, // back to the salesman and picker
        updatedAt: sql`now()`,
      })
      .where(eq(orders.id, orderId))
  })
  revalidatePath('/inventory')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/biller')
  revalidatePath('/orders/picker')
}

// ── Dispatcher actions ────────────────────────────────────────────────────────

/** Returns all orders ready for dispatch (status = billed or dispatched) */
export async function getPackedOrders() {
  await requireRole('dispatcher', 'admin', 'accountant')
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopkeeperName: orders.shopkeeperName,
      status: orders.status,
      packedAt: orders.packedAt,
      totalBundles: orders.totalBundles,
      dispatcherId: orders.dispatcherId,
    })
    .from(orders)
    .where(inArray(orders.status, ['billed', 'dispatched']))
    .orderBy(desc(orders.packedAt))
}

export async function markDispatched(orderId: number, totalBundles: number, deliveryAgentName: string) {
  const u = await requireRole('dispatcher', 'admin')
  await db.update(orders)
    .set({
      status: 'dispatched',
      dispatcherId: u.id,
      dispatchedAt: sql`now()`,
      updatedAt: sql`now()`,
      totalBundles,
      deliveryAgentName,
    })
    .where(eq(orders.id, orderId))
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
}

export async function markDelivered(orderId: number) {
  await requireRole('dispatcher', 'admin')
  await db.update(orders)
    .set({ status: 'delivered', deliveredAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId))
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
}

// ── Admin actions ─────────────────────────────────────────────────────────────

/** Delete an order that was never billed. A billed one is cancelled instead (Cancel bill keeps the record). */
export async function deleteOrder(orderId: number) {
  const u = await requireRole('admin')
  await db.transaction(async (tx) => {
    const [b] = (await tx.execute<{ billNo: string }>(sql`SELECT "billNo" FROM sale_bills WHERE "orderId" = ${orderId} ORDER BY id DESC LIMIT 1`)).rows
    if (b) throw new Error(`This order has bill ${b.billNo}. Bills are never deleted — use Cancel bill instead.`)
    await releaseOrderScans(tx, { id: u.id, name: u.name }, orderId, 'order deleted')
    await tx.delete(orders).where(eq(orders.id, orderId))
  })
  revalidatePath('/inventory')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
}

export async function getAllOrders() {
  await requireRole('admin', 'accountant')
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopkeeperName: orders.shopkeeperName,
      status: orders.status,
      orderedAt: orders.orderedAt,
      updatedAt: orders.updatedAt,
      packedAt: orders.packedAt,
      billedAt: orders.billedAt,
      dispatchedAt: orders.dispatchedAt,
      deliveredAt: orders.deliveredAt,
      salesmanId: orders.salesmanId,
      pickerId: orders.pickerId,
      billerId: orders.billerId,
      dispatcherId: orders.dispatcherId,
    })
    .from(orders)
    // Open orders of any age + finished / cancelled ones from the last 60 days (owner: "laggy",
    // 22 Nov 2026 — this used to load every order ever placed, on every visit).
    .where(sql`${orders.status} NOT IN ('delivered', 'cancelled') OR ${orders.orderedAt} > now() - interval '60 days'`)
    .orderBy(desc(orders.orderedAt))
    .limit(2000)
}

/**
 * Admin moves an order to another status. "Billed" is not one of them: only billing makes a bill
 * (owner, 23 Nov 2026). Moving a billed order back (or cancelling it) cancels its bill and reverses
 * its ledger entry, and returns its boxes to stock — all in one transaction.
 */
export async function adminUpdateOrderStatus(orderId: number, status: OrderStatus, reason?: string) {
  const u = await requireRole('admin')
  if (status === 'billed') throw new Error('Bill the order from Billing; its status cannot be set to billed by hand.')
  const patch: Record<string, unknown> = { status, updatedAt: sql`now()` }
  if (status === 'packed') patch.packedAt = sql`now()`
  if (status === 'dispatched') patch.dispatchedAt = sql`now()`
  if (status === 'delivered') patch.deliveredAt = sql`now()`
  // Clear picker/biller assignment when manually reverting to pending
  if (status === 'pending') { patch.pickerId = null; patch.billerId = null }
  if (status === 'pending' || status === 'assigned') patch.isEmergency = false
  await db.transaction(async (tx) => {
    // Moving an order back before "billed" (or cancelling it) returns its billed boxes to stock.
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for('update')
    if (!o) throw new Error('Order not found')
    if (['pending', 'assigned', 'packed', 'cancelled'].includes(status)) {
      const why = reason?.trim() || `order set to ${status} by admin`
      await releaseOrderScans(tx, { id: u.id, name: u.name }, orderId, why)
      await cancelSaleBill(tx, { id: u.id, name: u.name }, orderId, why)
    }
    await tx.update(orders).set(patch).where(eq(orders.id, orderId))
    await audit(tx, { actor: { id: u.id, name: u.name }, action: 'order.status_set', entityType: 'order', entityId: orderId, before: { status: o.status }, after: { status }, reason: reason?.trim() || undefined })
  })
  revalidatePath('/inventory')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/picker')
  revalidatePath('/orders/biller')
}

/**
 * Admin sends an order straight to billing (owner, 23 Nov 2026; Orders → Salesman → ⚡ on the order):
 * it skips the picking screen and waits on the biller's Bills tab as a Direct bill (isEmergency +
 * packed). Every Direct bill names who picked the goods (pickerId). The biller scans the boxes against
 * the ordered pairs; what is not received is marked on the order when it is billed. 2 statements + audit.
 */
export async function sendToBilling(orderId: number, pickerId: string) {
  const u = await requireRole('admin')
  return db.transaction(async (tx) => {
    const picker = await assertPickerChoice(tx, pickerId)
    const [row] = await tx.update(orders)
      .set({ status: 'packed', isEmergency: true, pickerId: picker, packedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), inArray(orders.status, ['pending', 'assigned'])))
      .returning(LIST_ROW)
    if (!row) throw new Error('Only pending or assigned orders can be sent straight to billing (it may have been packed already). Reload and check.')
    await audit(tx, { actor: { id: u.id, name: u.name }, action: 'order.sent_to_billing', entityType: 'order', entityId: orderId, after: { status: 'packed', direct: true, pickerId: picker } })
    return row
  })
}

/** Returns the saved row, so the Orders list shows the new status at once. */
export async function salesmanAssignPicker(orderId: number, pickerId: string) {
  await requireRole('salesman', 'admin')
  // One statement: the status is decided from the row as it is at that moment (no gap between a read
  // and the write in which a picker could change it).
  const [row] = await db.update(orders)
    .set({ pickerId, status: sql`CASE WHEN ${orders.status} = 'pending' THEN 'assigned'::order_status ELSE ${orders.status} END`, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId)).returning(LIST_ROW)
  if (!row) throw new Error('Order not found')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/picker')
  return row
}

export async function adminAssignPicker(orderId: number, pickerId: string) {
  await requireRole('admin')
  // Fetch current status so we only advance to 'assigned' from 'pending'.
  // If already 'packed', 'dispatched', etc., just update the pickerId without
  // changing status — the order is already progressing through the pipeline.
  // One statement: the status is decided from the row as it is at that moment (no gap between a read
  // and the write in which a picker could change it).
  const [row] = await db.update(orders)
    .set({ pickerId, status: sql`CASE WHEN ${orders.status} = 'pending' THEN 'assigned'::order_status ELSE ${orders.status} END`, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId)).returning({ id: orders.id })
  if (!row) throw new Error('Order not found')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/picker')
}

export async function adminUnassignPicker(orderId: number) {
  await requireRole('admin')
  // Only revert to pending if still in picker hands (pending/assigned).
  // A packed/dispatched/delivered order keeps its status when unassigning.
  // One statement (see adminAssignPicker): a packed order is never sent back to pending.
  const [row] = await db.update(orders)
    .set({ pickerId: null, status: sql`CASE WHEN ${orders.status} = 'assigned' THEN 'pending'::order_status ELSE ${orders.status} END`, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId)).returning({ id: orders.id })
  if (!row) throw new Error('Order not found')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/picker')
}

/** Returns orderId → pickerId map for all non-null picker assignments. */
export async function getPickerAssignments(): Promise<Record<number, string>> {
  await requireRole('admin', 'accountant')
  const rows = await db
    .select({ id: orders.id, pickerId: orders.pickerId })
    .from(orders)
    .where(sql`${orders.pickerId} is not null`)
  return Object.fromEntries(rows.map(r => [r.id, r.pickerId!]))
}

export async function getOrderStats() {
  await requireRole('admin', 'accountant')
  const [row] = await db.execute<{
    total: string; pending: string; packed: string; dispatched: string; delivered: string; cancelled: string
  }>(sql`
    SELECT
      count(*) filter (where status NOT IN ('delivered', 'cancelled'))::int AS total,
      count(*) filter (where status = 'pending')::int    AS pending,
      count(*) filter (where status = 'packed')::int     AS packed,
      count(*) filter (where status = 'dispatched')::int AS dispatched,
      count(*) filter (where status = 'delivered')::int  AS delivered,
      count(*) filter (where status = 'cancelled')::int  AS cancelled
    FROM orders
  `).then(r => r.rows)
  return {
    total:      Number(row?.total ?? 0),
    pending:    Number(row?.pending ?? 0),
    packed:     Number(row?.packed ?? 0),
    dispatched: Number(row?.dispatched ?? 0),
    delivered:  Number(row?.delivered ?? 0),
    cancelled:  Number(row?.cancelled ?? 0),
  }
}

// ── Procurement summary ───────────────────────────────────────────────────────

export interface ProcurementRow {
  artNumber: string
  colorNumber: string
  vendorName: string
  totalPairs: number
  orderCount: number
}

/**
 * Returns one row per (artNumber, colorNumber, vendorName / shopkeeperName)
 * for orders whose status matches the given filter (default: pending).
 * Optionally narrow by artNumber or colorNumber prefix.
 */
export async function getProcurementSummary(opts?: {
  status?: string
  artNumber?: string
  colorNumber?: string
  dateFrom?: string
  dateTo?: string
}): Promise<ProcurementRow[]> {
  await requireRole('admin', 'salesman', 'accountant')

  const status      = opts?.status      || 'pending'
  const artFilter   = opts?.artNumber?.trim().toUpperCase()   || ''
  const colorFilter = opts?.colorNumber?.trim().toUpperCase() || ''

  const conditions = [eq(orders.status, status as OrderStatus)]
  if (artFilter)   conditions.push(ilike(orderItems.artNumber,   `${artFilter}%`))
  if (colorFilter) conditions.push(ilike(orderItems.colorNumber, `${colorFilter}%`))
  if (opts?.dateFrom) conditions.push(gte(orders.orderedAt, new Date(opts.dateFrom)))
  if (opts?.dateTo) {
    const to = new Date(opts.dateTo)
    to.setHours(23, 59, 59, 999)
    conditions.push(lte(orders.orderedAt, to))
  }

  const rows = await db
    .select({
      artNumber:   orderItems.artNumber,
      colorNumber: orderItems.colorNumber,
      vendorName:  orders.shopkeeperName,
      totalPairs:  sql<number>`cast(sum(${orderItems.quantityOrdered}) as int)`,
      orderCount:  sql<number>`cast(count(distinct ${orders.id}) as int)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(...conditions))
    .groupBy(orderItems.artNumber, orderItems.colorNumber, orders.shopkeeperName)
    .orderBy(orderItems.artNumber, orderItems.colorNumber, orders.shopkeeperName)

  return rows.map(r => ({
    artNumber:   r.artNumber,
    colorNumber: r.colorNumber ?? '—',
    vendorName:  r.vendorName,
    totalPairs:  r.totalPairs,
    orderCount:  r.orderCount,
  }))
}

export interface ShortfallRow {
  artNumber: string
  colorNumber: string
  sizeNumber: string
  vendorName: string
  shortfall: number
}

/**
 * Returns one row per (artNumber, colorNumber, sizeNumber, shopkeeperName)
 * where sum(quantityOrdered - quantityPacked) > 0, for orders in the given
 * statuses (default: packed + dispatched + delivered — i.e. already being
 * fulfilled but with gaps the picker couldn't fill).
 */
export async function getProcurementShortfall(opts?: {
  statuses?: string[]
  artNumber?: string
  colorNumber?: string
}): Promise<ShortfallRow[]> {
  await requireRole('admin', 'salesman')

  const statuses    = opts?.statuses ?? ['packed', 'dispatched', 'delivered']
  const artFilter   = opts?.artNumber?.trim().toUpperCase()   || ''
  const colorFilter = opts?.colorNumber?.trim().toUpperCase() || ''

  const conditions = [inArray(orders.status, statuses as OrderStatus[])]
  if (artFilter)   conditions.push(ilike(orderItems.artNumber,   `${artFilter}%`))
  if (colorFilter) conditions.push(ilike(orderItems.colorNumber, `${colorFilter}%`))

  const rows = await db
    .select({
      artNumber:   orderItems.artNumber,
      colorNumber: orderItems.colorNumber,
      sizeNumber:  orderItems.sizeNumber,
      artCode:     orderItems.artCode,
      vendorName:  orders.shopkeeperName,
      shortfall:   sql<number>`cast(sum(${orderItems.quantityOrdered} - ${orderItems.quantityPacked}) as int)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(...conditions))
    .groupBy(orderItems.artNumber, orderItems.colorNumber, orderItems.sizeNumber, orderItems.artCode, orders.shopkeeperName)
    .having(sql`sum(${orderItems.quantityOrdered} - ${orderItems.quantityPacked}) > 0`)
    .orderBy(orderItems.artNumber, orderItems.colorNumber, orderItems.sizeNumber, orders.shopkeeperName)

  // One name can cover several codes with the same sizes (SS-101 children 11 vs big 11): where a size
  // appears for two codes, the code is added to the size so the two never merge.
  const codesPer = new Map<string, Set<string>>()
  for (const r of rows) {
    const k = `${r.vendorName}|${r.artNumber}|${r.colorNumber ?? ''}|${r.sizeNumber ?? ''}`
    if (!codesPer.has(k)) codesPer.set(k, new Set())
    codesPer.get(k)!.add((r.artCode ?? '').toUpperCase())
  }
  return rows.map(r => {
    const clash = (codesPer.get(`${r.vendorName}|${r.artNumber}|${r.colorNumber ?? ''}|${r.sizeNumber ?? ''}`)?.size ?? 0) > 1
    return {
      artNumber:   r.artNumber,
      colorNumber: r.colorNumber ?? '—',
      sizeNumber:  clash && r.artCode ? `${r.sizeNumber ?? '—'} (${r.artCode})` : (r.sizeNumber ?? '—'),
      vendorName:  r.vendorName,
      shortfall:   r.shortfall,
    }
  })
}
