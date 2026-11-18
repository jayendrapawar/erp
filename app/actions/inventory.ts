'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/authz'
import { correctStock, undoCorrection } from '@/lib/inventory/adjust'
import {
  listMovements, listStock, stockSummary,
  type Movement, type MovementFilters, type StockFilters, type StockSummary, type StockVariant, type VariantDetail,
} from '@/lib/inventory/stock-queries'

// Inventory screen. Reads: one query each. Writes: one transaction each.
// No revalidatePath: the screen updates the affected rows itself.

export async function getStockPage(f: StockFilters): Promise<{ rows: StockVariant[]; total: number }> {
  await requirePermission('inventory.view.all')
  return listStock(db, f)
}

export async function getStockSummary(): Promise<StockSummary> {
  await requirePermission('inventory.view.all')
  return stockSummary(db)
}

export async function getMovements(f: MovementFilters): Promise<{ rows: Movement[]; hasMore: boolean }> {
  await requirePermission('inventory.view.all')
  return listMovements(db, f)
}


/** One variant with its sizes and its latest movements: two queries, run together. */
export async function getVariantDetail(articleId: number): Promise<VariantDetail> {
  await requirePermission('inventory.view.all')
  return variantDetail(articleId)
}

async function variantDetail(articleId: number): Promise<VariantDetail> {
  const [stock, moves] = await Promise.all([
    listStock(db, { articleId, inStockOnly: false }),
    listMovements(db, { articleId, limit: 30 }),
  ])
  return { variant: stock.rows[0] ?? null, movements: moves.rows, hasMore: moves.hasMore }
}

/** Add or remove pairs of one size by hand (admin, supervisor). Returns the refreshed variant. */
export async function correctStockAction(input: { articleId: number; skuId: number; delta: number; reason: string; requestId: string }): Promise<VariantDetail> {
  const u = await requirePermission('inventory.adjust')
  await correctStock(db, { id: u.id, name: u.name }, input)
  return variantDetail(input.articleId)
}

export async function undoCorrectionAction(input: { articleId: number; movementId: number; reason: string }): Promise<VariantDetail> {
  const u = await requirePermission('inventory.adjust')
  await undoCorrection(db, { id: u.id, name: u.name }, input.movementId, input.reason)
  return variantDetail(input.articleId)
}
