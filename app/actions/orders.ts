'use server'

import { assignBillNo, stampBillLineHsn } from '@/lib/billing/bill-number'
import { db } from '@/lib/db'
import { orders, orderItems, billLines, retailers } from '@/lib/db/schema'
import type { OrderStatus } from '@/lib/db/schema'
import { eq, desc, inArray, sql, and, ilike, gte, lte } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { requireAnyRole } from '@/lib/authz'
import type { Role } from '@/lib/permissions'
import type { Tx } from '@/lib/db/types'
import { releaseOrderScans } from '@/lib/billing/bill-stock'
import { olderOrders, recentOrders, type OrderScope } from '@/lib/orders/order-list'

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

// ── Order-number generator ────────────────────────────────────────────────────

function genOrderNumber() {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')
  return `ORD-${ymd}-${rand}`
}

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
}

// ── Salesman actions ──────────────────────────────────────────────────────────

export async function createOrder(input: CreateOrderInput) {
  const u = await requireRole('salesman', 'admin')

  if (!input.items.length) throw new Error('At least one item required')

  // Header and lines are written together or not at all.
  const order = await db.transaction(async (tx) => {
    const [created] = await tx.insert(orders).values({
      orderNumber: genOrderNumber(),
      shopkeeperName: input.shopkeeperName,
      retailerId: await retailerIdFor(tx, input.shopkeeperName),
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
    if (!['pending', 'assigned', 'packed', 'billed'].includes(order.status)) throw new Error('Only pending, assigned, packed, or billed orders can be edited')

    // Reset order to pending so it re-enters the picker queue
    const statusPatch: Record<string, unknown> = {
      shopkeeperName: input.shopkeeperName,
      notes: input.notes ?? null,
      updatedAt: sql`now()`,
    }
    if (['packed', 'billed'].includes(order.status)) {
      // Send back to pending — clear picker/biller assignment so it re-queues
      statusPatch.status = 'pending'
      statusPatch.pickerId = null
      statusPatch.billerId = null
      statusPatch.packedAt = null
      statusPatch.billedAt = null
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

export async function getPickerQueue() {
  await requireRole('picker', 'admin', 'accountant')
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
    .where(inArray(orders.status, ['pending', 'assigned']))
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

/** Persist MRP lines for a billed order. Replaces any existing lines. */
export async function saveBillLines(
  orderId: number,
  lines: { artNumber: string; mrp: number; qty: number }[],
  lineDiscPct: number,
) {
  await requireRole('biller', 'admin')
  // Replace the lines atomically (idempotent re-save).
  await db.transaction(async (tx) => {
    await tx.delete(billLines).where(eq(billLines.orderId, orderId))
    if (lines.length > 0) {
      await tx.insert(billLines).values(
        lines.map(l => ({
          orderId,
          artNumber:   l.artNumber,
          mrp:         String(l.mrp),
          qty:         l.qty,
          lineDiscPct: String(lineDiscPct),
        }))
      )
    }
  })
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
    })
    .from(orders)
    .where(inArray(orders.status, ['packed', 'billed']))
    .orderBy(desc(orders.packedAt))
}

/** Biller marks an order as billed — moves it to the dispatcher queue */
export async function markBilled(orderId: number, isEmergency = false) {
  const u = await requireRole('biller', 'admin')
  await db.transaction(async (tx) => {
    await tx.update(orders)
      .set({
        status: 'billed',
        billerId: u.id,
        billedAt: sql`now()`,
        isEmergency,
        updatedAt: sql`now()`,
      })
      .where(eq(orders.id, orderId))
    await assignBillNo(tx, orderId)
    await stampBillLineHsn(tx, orderId)
  })
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/biller')
  revalidatePath('/orders/dispatcher')
}

// Direct Bills (formerly "Emergency Bills") are created from drafts: app/actions/billing.ts.

/** Biller sends order back to salesman for editing (resets to pending) */
export async function sendBackToEdit(orderId: number) {
  const u = await requireRole('biller', 'admin')
  await db.transaction(async (tx) => {
    // Boxes billed for this order go back into stock.
    await releaseOrderScans(tx, { id: u.id, name: u.name }, orderId, 'order sent back for editing')
    await tx.update(orders)
      .set({
        status: 'pending',
        pickerId: null,
        billerId: null,
        packedAt: null,
        billedAt: null,
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

export async function deleteOrder(orderId: number) {
  const u = await requireRole('admin')
  await db.transaction(async (tx) => {
    await releaseOrderScans(tx, { id: u.id, name: u.name }, orderId, 'order deleted')
    await tx.delete(orders).where(eq(orders.id, orderId))
  })
  revalidatePath('/inventory')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
}

/** Biller can delete a Direct Bill (isEmergency). Its boxes go back into stock first. */
export async function deleteEmergencyBill(orderId: number) {
  const u = await requireRole('biller', 'admin')
  await db.transaction(async (tx) => {
    await releaseOrderScans(tx, { id: u.id, name: u.name }, orderId, 'Direct Bill deleted')
    await tx.delete(orders).where(and(eq(orders.id, orderId), eq(orders.isEmergency, true)))
  })
  revalidatePath('/inventory')
  revalidatePath('/orders/biller')
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

export async function adminUpdateOrderStatus(orderId: number, status: OrderStatus) {
  const u = await requireRole('admin')
  const patch: Record<string, unknown> = { status, updatedAt: sql`now()` }
  if (status === 'packed') patch.packedAt = sql`now()`
  if (status === 'billed') patch.billedAt = sql`now()`
  if (status === 'dispatched') patch.dispatchedAt = sql`now()`
  if (status === 'delivered') patch.deliveredAt = sql`now()`
  // Clear picker/biller assignment when manually reverting to pending
  if (status === 'pending') { patch.pickerId = null; patch.billerId = null }
  await db.transaction(async (tx) => {
    // Moving an order back before "billed" (or cancelling it) returns its billed boxes to stock.
    if (['pending', 'assigned', 'packed', 'cancelled'].includes(status)) {
      await releaseOrderScans(tx, { id: u.id, name: u.name }, orderId, `order set to ${status}`)
    }
    await tx.update(orders).set(patch).where(eq(orders.id, orderId))
  })
  revalidatePath('/inventory')
  revalidatePath('/orders')
  revalidatePath('/orders/admin')
  revalidatePath('/orders/picker')
  revalidatePath('/orders/biller')
}

export async function salesmanAssignPicker(orderId: number, pickerId: string) {
  await requireRole('salesman', 'admin')
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
