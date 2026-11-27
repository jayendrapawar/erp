'use server'

import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requirePermission, requireUser } from '@/lib/authz'

// Two views of inventory:
//  - "My scans"     : scan activity (scan_events) for the signed-in user.
//  - "Overall stock": stock balances from the ledger (stock_balances), split into
//                     scanned / unscanned / carton-derived provenance.
// Every aggregate is computed in SQL; nothing loads raw rows to count them in JS.

export async function getLoggedInUserName(): Promise<string | null> {
  return (await requireUser()).name
}

const ACTIVE_STOCKTAKE = sql`e.status = 'active' AND e.purpose = 'stocktake'`

export interface InventorySummaryRow {
  artNumber: string | undefined
  colorNumber: string | undefined
  sizeNumber: string | undefined
  division: string | undefined
  mrp: number | undefined
  mfgMonth: number | undefined
  mfgYear: number | undefined
  scannedByName: string | undefined
  entryType: string
  quantity: number
  count: number
  lastScanned: Date
}

/** The signed-in user's own scans, grouped per article/colour/size/MRP/batch. */
export async function getInventorySummary(): Promise<InventorySummaryRow[]> {
  const u = await requirePermission('inventory.view')
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT e."articleCode" AS "artNumber", e."colourCode" AS "colorNumber", e."sizeLabel" AS "sizeNumber",
           a.division, e.mrp, e."mfgMonth", e."mfgYear", e."userName" AS "scannedByName", e."entryType",
           sum(e.quantity)::int AS quantity, count(*)::int AS count, max(e."createdAt") AS "lastScanned"
    FROM scan_events e LEFT JOIN articles a ON a.id = e."articleId"
    WHERE ${ACTIVE_STOCKTAKE} AND e."userId" = ${u.id}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
    ORDER BY max(e."createdAt") DESC
    LIMIT 2000`)
  return r.rows.map((x) => ({
    artNumber: (x.artNumber as string) ?? undefined,
    colorNumber: (x.colorNumber as string) ?? undefined,
    sizeNumber: (x.sizeNumber as string) ?? undefined,
    division: (x.division as string) ?? undefined,
    mrp: x.mrp != null ? Number(x.mrp) : undefined,
    mfgMonth: (x.mfgMonth as number) ?? undefined,
    mfgYear: (x.mfgYear as number) ?? undefined,
    scannedByName: (x.scannedByName as string) ?? undefined,
    entryType: x.entryType as string,
    quantity: Number(x.quantity),
    count: Number(x.count),
    lastScanned: new Date(x.lastScanned as string),
  }))
}

export async function getStatistics() {
  const u = await requirePermission('inventory.view')
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT count(*)::int AS "totalScans",
           coalesce(sum(e.quantity), 0)::int AS "totalItems",
           count(DISTINCT (e."articleCode", e."colourCode", e."sizeLabel"))::int AS "uniqueItems",
           count(*) FILTER (WHERE e."createdAt" > now() - interval '24 hours')::int AS "scansLast24h"
    FROM scan_events e WHERE ${ACTIVE_STOCKTAKE} AND e."userId" = ${u.id}`)
  const x = r.rows[0] ?? {}
  return {
    totalScans: Number(x.totalScans ?? 0),
    totalItems: Number(x.totalItems ?? 0),
    uniqueItems: Number(x.uniqueItems ?? 0),
    scansLast24h: Number(x.scansLast24h ?? 0),
  }
}

export interface OverallStockItem {
  skuId: number
  artNumber: string
  artName: string
  colorNumber: string
  colorName: string
  sizeNumber: string
  division: string | undefined
  scannedQuantity: number
  unscannedQuantity: number
  cartonQuantity: number
  totalQuantity: number
  lastUpdated: Date
}

export interface OverallStockStats {
  totalStockItems: number
  scannedStockItems: number
  unscannedStockItems: number
  uniqueSKUs: number
  awaitingArticleLink: number
  negativeSKUs: number
}

/** Stock on hand per SKU from the ledger balances. */
export async function getOverallStockSummary(): Promise<OverallStockItem[]> {
  await requirePermission('inventory.view.all')
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT b."skuId", a."artCode", a."artName", a."colorCode", a.color, s."sizeLabel", a.division,
           sum(b.quantity) FILTER (WHERE b.provenance = 'scanned')::int AS scanned,
           sum(b.quantity) FILTER (WHERE b.provenance = 'unscanned')::int AS unscanned,
           sum(b.quantity) FILTER (WHERE b.provenance = 'carton')::int AS carton,
           sum(b.quantity)::int AS total, max(b."updatedAt") AS updated
    FROM stock_balances b
    JOIN article_sizes s ON s.id = b."skuId"
    JOIN articles a ON a.id = s."articleId"
    GROUP BY b."skuId", a."artCode", a."artName", a."colorCode", a.color, s."sizeLabel", s."sortOrder", a.division
    HAVING sum(b.quantity) <> 0 OR bool_or(b.quantity <> 0)
    ORDER BY a."artName", a.color, s."sortOrder"
    LIMIT 5000`)
  return r.rows.map((x) => ({
    skuId: Number(x.skuId),
    artNumber: (x.artCode as string) || (x.artName as string),
    artName: x.artName as string,
    colorNumber: (x.colorCode as string) || '',
    colorName: x.color as string,
    sizeNumber: x.sizeLabel as string,
    division: (x.division as string) ?? undefined,
    scannedQuantity: Number(x.scanned ?? 0),
    unscannedQuantity: Number(x.unscanned ?? 0),
    cartonQuantity: Number(x.carton ?? 0),
    totalQuantity: Number(x.total ?? 0),
    lastUpdated: new Date(x.updated as string),
  }))
}

export async function getOverallStockStats(): Promise<OverallStockStats> {
  await requirePermission('inventory.view.all')
  const r = await db.execute<Record<string, unknown>>(sql`
    WITH per_sku AS (SELECT "skuId", sum(quantity) q FROM stock_balances GROUP BY 1)
    SELECT
      (SELECT coalesce(sum(quantity), 0) FROM stock_balances)::int AS total,
      (SELECT coalesce(sum(quantity), 0) FROM stock_balances WHERE provenance = 'scanned')::int AS scanned,
      (SELECT coalesce(sum(quantity), 0) FROM stock_balances WHERE provenance = 'unscanned')::int AS unscanned,
      (SELECT count(*) FROM per_sku WHERE q > 0)::int AS skus,
      (SELECT count(*) FROM per_sku WHERE q < 0)::int AS negative,
      (SELECT coalesce(sum(quantity), 0) FROM scan_events WHERE status = 'active' AND resolution <> 'resolved')::int AS awaiting`)
  const x = r.rows[0] ?? {}
  return {
    totalStockItems: Number(x.total ?? 0),
    scannedStockItems: Number(x.scanned ?? 0),
    unscannedStockItems: Number(x.unscanned ?? 0),
    uniqueSKUs: Number(x.skus ?? 0),
    negativeSKUs: Number(x.negative ?? 0),
    awaitingArticleLink: Number(x.awaiting ?? 0),
  }
}

// The browser runs server actions one at a time, so two actions in Promise.all on the client run one
// after the other. These run each pair in parallel on the server: one request (Orders speed, 22 Nov 2026).

/** Scanned inventory list + its statistics, one request. */
export async function getScannedInventoryView() {
  const [summary, stats] = await Promise.all([getInventorySummary(), getStatistics()])
  return { summary, stats }
}

/** Overall stock list + its statistics, one request. */
export async function getOverallStockView() {
  const [items, stats] = await Promise.all([getOverallStockSummary(), getOverallStockStats()])
  return { items, stats }
}

/** Every one of my active scan events, one row per box (CSV export). */
export async function exportToExcel(): Promise<Record<string, string | number>[]> {
  const u = await requirePermission('inventory.view')
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT e.id, e."entryType", e."articleCode", e."colourCode", e."sizeLabel", a."artName", a.color, a.division,
           e.mrp, e."mfgMonth", e."mfgYear", e."userName", e.quantity, e.resolution, e.flag, e."createdAt", e."rawInput"
    FROM scan_events e LEFT JOIN articles a ON a.id = e."articleId"
    WHERE ${ACTIVE_STOCKTAKE} AND e."userId" = ${u.id}
    ORDER BY e.id DESC LIMIT 20000`)
  return r.rows.map((x) => ({
    'Scan ID': Number(x.id),
    'Entry Type': x.entryType as string,
    'Article Code': (x.articleCode as string) ?? '',
    'Article Name': (x.artName as string) ?? '',
    'Colour Code': (x.colourCode as string) ?? '',
    'Colour': (x.color as string) ?? '',
    Size: (x.sizeLabel as string) ?? '',
    Division: (x.division as string) ?? '',
    MRP: x.mrp != null ? Number(x.mrp) : '',
    'Mfg Month': (x.mfgMonth as number) ?? '',
    'Mfg Year': (x.mfgYear as number) ?? '',
    'Scanned By': x.userName as string,
    Quantity: Number(x.quantity),
    Status: x.resolution === 'resolved' ? 'In stock' : 'Awaiting article link',
    Flag: (x.flag as string) ?? '',
    'Scanned At': new Date(x.createdAt as string).toISOString(),
    'Raw QR': (x.rawInput as string) ?? '',
  }))
}

/** Stock on hand per SKU (CSV export). */
export async function exportOverallStockToCSV(): Promise<Record<string, string | number>[]> {
  await requirePermission('inventory.export')
  const rows = await getOverallStockSummary()
  return rows.map((r) => ({
    'Article Code': r.artNumber,
    'Article Name': r.artName,
    'Colour Code': r.colorNumber,
    Colour: r.colorName,
    Size: r.sizeNumber,
    Division: r.division ?? '',
    'Scanned Pairs': r.scannedQuantity,
    'Unscanned Pairs': r.unscannedQuantity,
    'Carton-derived Pairs': r.cartonQuantity,
    'Total Pairs': r.totalQuantity,
    'Last Updated': r.lastUpdated.toISOString(),
  }))
}

export interface ScansOverTimePoint { date: string; scans: number; quantity: number }
export interface DivisionBreakdownItem { division: string; quantity: number }
export interface TopSKUItem { sku: string; quantity: number }
export interface EntryTypeItem { type: string; count: number }
export interface ScansByUserItem { user: string; scans: number; quantity: number }

function fill14Days(rows: Array<{ day: string; scans: number; quantity: number }>): ScansOverTimePoint[] {
  const map = new Map(rows.map((r) => [r.day, r]))
  const out: ScansOverTimePoint[] = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
    const r = map.get(key)
    out.push({ date: key, scans: Number(r?.scans ?? 0), quantity: Number(r?.quantity ?? 0) })
  }
  return out
}

async function chartData(userId: string | null) {
  const mine = userId ? sql`AND e."userId" = ${userId}` : sql``
  const [time, div, sku, type, users] = await Promise.all([
    db.execute<{ day: string; scans: number; quantity: number }>(sql`
      SELECT to_char(e."createdAt" AT TIME ZONE 'Asia/Kolkata', 'MM/DD') AS day, count(*)::int AS scans, sum(e.quantity)::int AS quantity
      FROM scan_events e WHERE ${ACTIVE_STOCKTAKE} ${mine} AND e."createdAt" >= now() - interval '14 days' GROUP BY 1`),
    db.execute<{ division: string; quantity: number }>(sql`
      SELECT coalesce(a.division, 'Unassigned') AS division, sum(e.quantity)::int AS quantity
      FROM scan_events e LEFT JOIN articles a ON a.id = e."articleId" WHERE ${ACTIVE_STOCKTAKE} ${mine} GROUP BY 1 ORDER BY 2 DESC`),
    db.execute<{ sku: string; quantity: number }>(sql`
      SELECT coalesce(e."articleCode", '?') || '-' || coalesce(e."colourCode", '?') || '-' || coalesce(e."sizeLabel", '?') AS sku, sum(e.quantity)::int AS quantity
      FROM scan_events e WHERE ${ACTIVE_STOCKTAKE} ${mine} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    db.execute<{ type: string; count: number }>(sql`
      SELECT e."entryType" AS type, count(*)::int AS count FROM scan_events e WHERE ${ACTIVE_STOCKTAKE} ${mine} GROUP BY 1`),
    userId ? Promise.resolve({ rows: [] as Array<Record<string, unknown>> }) : db.execute<Record<string, unknown>>(sql`
      SELECT e."userName" AS "user", count(*)::int AS scans, sum(e.quantity)::int AS quantity
      FROM scan_events e WHERE ${ACTIVE_STOCKTAKE} GROUP BY 1 ORDER BY 2 DESC`),
  ])
  return {
    scansOverTime: fill14Days(time.rows),
    divisionBreakdown: div.rows.map((r) => ({ division: r.division, quantity: Number(r.quantity) })),
    topSKUs: sku.rows.map((r) => ({ sku: r.sku, quantity: Number(r.quantity) })),
    entryTypeBreakdown: type.rows.map((r) => ({ type: r.type, count: Number(r.count) })),
    scansByUser: users.rows.map((r) => ({ user: String(r.user), scans: Number(r.scans), quantity: Number(r.quantity) })),
  }
}

export async function getScannedChartData(): Promise<{
  scansOverTime: ScansOverTimePoint[]
  divisionBreakdown: DivisionBreakdownItem[]
  topSKUs: TopSKUItem[]
  entryTypeBreakdown: EntryTypeItem[]
}> {
  const u = await requirePermission('inventory.view')
  const d = await chartData(u.id)
  return { scansOverTime: d.scansOverTime, divisionBreakdown: d.divisionBreakdown, topSKUs: d.topSKUs, entryTypeBreakdown: d.entryTypeBreakdown }
}

export async function getOverallChartData(): Promise<{
  scansOverTime: ScansOverTimePoint[]
  divisionBreakdown: DivisionBreakdownItem[]
  topSKUs: TopSKUItem[]
  entryTypeBreakdown: EntryTypeItem[]
  scansByUser: ScansByUserItem[]
}> {
  await requirePermission('inventory.view.all')
  return chartData(null)
}
