'use server'

import { revalidateShopCatalogue } from '@/lib/shop/cache'
import { db } from '@/lib/db'
import { orderSets } from '@/lib/db/schema'
import { asc, eq, sql } from 'drizzle-orm'
import { requirePermission } from '@/lib/authz'

export type OrderSet = typeof orderSets.$inferSelect

async function requireAuth() {
  await requirePermission('sets.view')
}

async function requireAdmin() {
  await requirePermission('sets.edit')
}

// The order_sets table is created by migrations (db/migrations/0000_baseline.sql);
// it is no longer created at runtime on every request.
async function ensureTable() {}

// ── Fetch all sets ────────────────────────────────────────────────────────────
export async function getSets(): Promise<OrderSet[]> {
  await requireAuth()
  await ensureTable()
  return db.select().from(orderSets).orderBy(asc(orderSets.name))
}

// ── Save (upsert) a single set ────────────────────────────────────────────────
export async function saveSet(
  input: { name: string; quantities: Record<string, number>; id?: number }
): Promise<OrderSet[]> {
  await requireAdmin()
  if (!input.name.trim()) throw new Error('Set name is required')

  if (input.id) {
    await db
      .update(orderSets)
      .set({
        name: input.name.trim(),
        quantities: input.quantities,
        updatedAt: sql`now()`,
      })
      .where(eq(orderSets.id, input.id))
  } else {
    await db.insert(orderSets).values({
      name: input.name.trim(),
      quantities: input.quantities,
    })
  }
  revalidateShopCatalogue() // the shop offers sets as quick fill
  return db.select().from(orderSets).orderBy(asc(orderSets.name))
}

// ── Delete a single set ───────────────────────────────────────────────────────
export async function deleteSet(id: number): Promise<OrderSet[]> {
  await requireAdmin()
  await db.delete(orderSets).where(eq(orderSets.id, id))
  revalidateShopCatalogue()
  return db.select().from(orderSets).orderBy(asc(orderSets.name))
}
