// Read side of inventory (server only). Every figure is aggregated in SQL from the ledger
// (stock_movements) and its trigger-maintained balances (stock_balances); nothing is cached.
//
// Value at MRP: per SKU, pairs on hand × the average MRP of that SKU's scanned boxes
// (net of undone scans). Pairs of a SKU that has never been scanned with an MRP are "unvalued".

import { sql, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'

export const PAGE_SIZE = 50

export interface StockSize { skuId: number; size: string; pairs: number }

export interface StockVariant {
  articleId: number
  artName: string
  artCode: string
  color: string
  colorCode: string
  division: string
  active: boolean
  pairs: number
  value: number
  unvaluedPairs: number
  sizes: StockSize[]
  lastMovementAt: string | null
}

export interface StockFilters {
  search?: string
  division?: string
  /** Default true: only variants whose pairs on hand are not zero. */
  inStockOnly?: boolean
  page?: number
  /** One variant only (detail view). */
  articleId?: number
}

export interface StockSummary {
  pairs: number
  value: number
  unvaluedPairs: number
  variantsInStock: number
  sizesInStock: number
  negativeSizes: number
  waitingScans: number
  waitingPairs: number
  movementsToday: number
  /** Billed boxes that were never in stock (bill_scans 'unscanned_dispatch'). */
  unscannedDispatch: number
}

// Division: the variant's own division, else the catalogue brand ("SPARX" → "Sparx").
const DIVISION = sql`coalesce(nullif(a.division, ''), initcap(c.brand), '')`

/** Average MRP per SKU from scanned boxes and received cartons (net of undos). */
const AVG_MRP = (skuFilter: SQL) => sql`
  SELECT x."skuId", sum(x.quantity * x.mrp) / nullif(sum(x.quantity), 0) AS mrp
  FROM (
    SELECT m."skuId", m.quantity, e.mrp FROM stock_movements m
    JOIN scan_events e ON m."sourceType" = 'scan_event' AND e.id::text = m."sourceId"
    WHERE e.mrp IS NOT NULL AND m."movementType" <> 'provenance_transfer' AND ${skuFilter}
    UNION ALL
    SELECT m."skuId", m.quantity, c.mrp FROM stock_movements m
    JOIN carton_receipts c ON m."sourceType" = 'carton_receipt' AND c.id::text = m."sourceId"
    WHERE c.mrp IS NOT NULL AND ${skuFilter}
  ) x
  GROUP BY x."skuId"
  HAVING sum(x.quantity) > 0`

/** One page of variants with their sizes, pairs and value. One query. */
export async function listStock(db: DbOrTx, f: StockFilters): Promise<{ rows: StockVariant[]; total: number }> {
  const page = Math.max(0, Math.floor(f.page ?? 0))
  const q = (f.search ?? '').trim().slice(0, 60)
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
  const inStockOnly = f.inStockOnly !== false
  const where = sql.join([
    sql`TRUE`,
    q ? sql`(a."artName" ILIKE ${like} OR a."artCode" ILIKE ${like} OR a.color ILIKE ${like} OR a."colorCode" ILIKE ${like})` : sql`TRUE`,
    f.division ? sql`${DIVISION} = ${f.division}` : sql`TRUE`,
    f.articleId ? sql`a.id = ${f.articleId}` : sql`TRUE`,
  ], sql` AND `)
  const r = await db.execute<Record<string, unknown>>(sql`
    WITH bal AS (SELECT "skuId", sum(quantity)::int AS q, max("updatedAt") AS at FROM stock_balances GROUP BY 1),
    v AS (
      SELECT a.id, a."artName", a."artCode", a.color, a."colorCode", a.active, ${DIVISION} AS division,
             coalesce(sum(bal.q), 0)::int AS pairs, max(bal.at) AS at,
             count(*) OVER () AS total
      FROM articles a
      LEFT JOIN catalog_articles c ON c.id = a."catalogArticleId"
      JOIN article_sizes s ON s."articleId" = a.id
      LEFT JOIN bal ON bal."skuId" = s.id
      WHERE ${where}
      GROUP BY a.id, c.brand
      HAVING ${f.articleId ? sql`TRUE` : inStockOnly ? sql`coalesce(sum(bal.q), 0) <> 0 OR bool_or(bal.q <> 0)` : sql`a.active OR bool_or(bal.q <> 0)`}
      ORDER BY a."artName", a."artCode", a.color, a.id
      LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}
    ),
    sz AS (
      SELECT s.id AS "skuId", s."articleId", s."sizeLabel", s."sortOrder", coalesce(bal.q, 0) AS q
      FROM article_sizes s JOIN v ON v.id = s."articleId" LEFT JOIN bal ON bal."skuId" = s.id
      WHERE s.active OR coalesce(bal.q, 0) <> 0
    ),
    mrp AS (${AVG_MRP(sql`m."skuId" IN (SELECT "skuId" FROM sz)`)})
    SELECT v.*,
      (SELECT json_agg(json_build_object('skuId', sz."skuId", 'size', sz."sizeLabel", 'pairs', sz.q) ORDER BY sz."sortOrder", sz."sizeLabel")
         FROM sz WHERE sz."articleId" = v.id) AS sizes,
      (SELECT coalesce(sum(sz.q * mrp.mrp), 0) FROM sz JOIN mrp ON mrp."skuId" = sz."skuId" WHERE sz."articleId" = v.id AND sz.q > 0) AS value,
      (SELECT coalesce(sum(sz.q), 0) FROM sz LEFT JOIN mrp ON mrp."skuId" = sz."skuId" WHERE sz."articleId" = v.id AND sz.q > 0 AND mrp.mrp IS NULL)::int AS unvalued
    FROM v ORDER BY v."artName", v."artCode", v.color, v.id`)
  return { rows: r.rows.map(toVariant), total: Number(r.rows[0]?.total ?? 0) }
}

function toVariant(x: Record<string, unknown>): StockVariant {
  return {
    articleId: Number(x.id),
    artName: String(x.artName ?? ''),
    artCode: String(x.artCode ?? ''),
    color: String(x.color ?? ''),
    colorCode: String(x.colorCode ?? ''),
    division: String(x.division ?? ''),
    active: Boolean(x.active),
    pairs: Number(x.pairs ?? 0),
    value: Math.round(Number(x.value ?? 0) * 100) / 100,
    unvaluedPairs: Number(x.unvalued ?? 0),
    sizes: ((x.sizes as StockSize[] | null) ?? []).map((s) => ({ skuId: Number(s.skuId), size: String(s.size), pairs: Number(s.pairs) })),
    lastMovementAt: x.at ? new Date(x.at as string).toISOString() : null,
  }
}

/** Header figures for the inventory screen. One query (aggregates the whole ledger once). */
export async function stockSummary(db: DbOrTx): Promise<StockSummary> {
  const r = await db.execute<Record<string, unknown>>(sql`
    WITH bal AS (SELECT "skuId", sum(quantity)::int AS q FROM stock_balances GROUP BY 1),
    mrp AS (${AVG_MRP(sql`TRUE`)})
    SELECT
      (SELECT coalesce(sum(q), 0) FROM bal WHERE q > 0)::int AS pairs,
      (SELECT coalesce(sum(bal.q * mrp.mrp), 0) FROM bal JOIN mrp USING ("skuId") WHERE bal.q > 0) AS value,
      (SELECT coalesce(sum(bal.q), 0) FROM bal LEFT JOIN mrp USING ("skuId") WHERE bal.q > 0 AND mrp.mrp IS NULL)::int AS unvalued,
      (SELECT count(DISTINCT s."articleId") FROM bal JOIN article_sizes s ON s.id = bal."skuId" WHERE bal.q > 0)::int AS variants,
      (SELECT count(*) FROM bal WHERE q > 0)::int AS sizes,
      (SELECT count(*) FROM bal WHERE q < 0)::int AS negative,
      (SELECT count(*) FROM scan_events WHERE status = 'active' AND resolution <> 'resolved')::int AS waiting,
      (SELECT coalesce(sum(quantity), 0) FROM scan_events WHERE status = 'active' AND resolution <> 'resolved')::int AS waiting_pairs,
      (SELECT count(*) FROM stock_movements WHERE "createdAt" >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS today,
      (SELECT count(*) FROM bill_scans WHERE status = 'active' AND "stockSource" = 'unscanned_dispatch')::int AS dispatch`)
  const x = r.rows[0] ?? {}
  return {
    pairs: Number(x.pairs ?? 0),
    value: Math.round(Number(x.value ?? 0) * 100) / 100,
    unvaluedPairs: Number(x.unvalued ?? 0),
    variantsInStock: Number(x.variants ?? 0),
    sizesInStock: Number(x.sizes ?? 0),
    negativeSizes: Number(x.negative ?? 0),
    waitingScans: Number(x.waiting ?? 0),
    waitingPairs: Number(x.waiting_pairs ?? 0),
    movementsToday: Number(x.today ?? 0),
    unscannedDispatch: Number(x.dispatch ?? 0),
  }
}

export type MovementKind = 'scan' | 'received' | 'billed' | 'undo' | 'correction' | 'other'

export interface Movement {
  id: number
  at: string
  articleId: number
  artName: string
  artCode: string
  color: string
  colorCode: string
  size: string
  quantity: number
  kind: MovementKind
  movementType: string
  provenance: string
  userName: string
  reason: string | null
  mrp: number | null
  /** A correction that has not been undone yet. */
  canUndo: boolean
  undone: boolean
}

export interface MovementFilters {
  kind?: MovementKind | 'all'
  articleId?: number
  userId?: string
  search?: string
  /** YYYY-MM-DD, India time, inclusive. */
  from?: string
  to?: string
  /** Keyset: return movements with id below this. */
  before?: number
  limit?: number
}

const KIND_TYPES: Record<Exclude<MovementKind, 'other'>, string[]> = {
  scan: ['stocktake_scan', 'stocktake_manual', 'legacy_import'],
  received: ['receipt'],
  billed: ['dispatch'],
  undo: ['reversal'],
  correction: ['adjustment'],
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Newest first, keyset-paginated. One query. */
export async function listMovements(db: DbOrTx, f: MovementFilters): Promise<{ rows: Movement[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(f.limit ?? PAGE_SIZE, 1), 200)
  const q = (f.search ?? '').trim().slice(0, 60)
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
  const conds: SQL[] = [sql`TRUE`]
  if (f.kind && f.kind !== 'all') {
    conds.push(f.kind === 'other'
      ? sql`m."movementType" NOT IN ('stocktake_scan','stocktake_manual','legacy_import','receipt','dispatch','reversal','adjustment')`
      : sql`m."movementType" IN (SELECT json_array_elements_text(${JSON.stringify(KIND_TYPES[f.kind])}::json))`)
  }
  if (f.articleId) conds.push(sql`s."articleId" = ${f.articleId}`)
  if (f.userId) conds.push(sql`m."userId" = ${f.userId}`)
  if (q) conds.push(sql`(a."artName" ILIKE ${like} OR a."artCode" ILIKE ${like} OR a.color ILIKE ${like} OR a."colorCode" ILIKE ${like})`)
  if (f.from && DATE_RE.test(f.from)) conds.push(sql`m."createdAt" >= (${f.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`)
  if (f.to && DATE_RE.test(f.to)) conds.push(sql`m."createdAt" < ((${f.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`)
  if (f.before) conds.push(sql`m.id < ${f.before}`)
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT m.id, m."createdAt", m."skuId", m.quantity, m."movementType", m.provenance, m.reason, m."sourceType",
           s."sizeLabel", s."articleId", a."artName", a."artCode", a.color, a."colorCode",
           coalesce(u.name, e."userName", '') AS "userName", e.mrp,
           EXISTS (SELECT 1 FROM stock_movements r WHERE r."reversalOfId" = m.id) AS undone
    FROM stock_movements m
    JOIN article_sizes s ON s.id = m."skuId"
    JOIN articles a ON a.id = s."articleId"
    LEFT JOIN "user" u ON u.id = m."userId"
    LEFT JOIN scan_events e ON m."sourceType" = 'scan_event' AND e.id::text = m."sourceId"
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY m.id DESC
    LIMIT ${limit + 1}`)
  const rows = r.rows.slice(0, limit).map((x): Movement => {
    const type = String(x.movementType)
    const kind: MovementKind = KIND_TYPES.scan.includes(type) ? 'scan' : type === 'receipt' ? 'received' : type === 'dispatch' ? 'billed' : type === 'reversal' ? 'undo' : type === 'adjustment' ? 'correction' : 'other'
    const undone = Boolean(x.undone)
    return {
      id: Number(x.id), at: new Date(x.createdAt as string).toISOString(),
      articleId: Number(x.articleId), artName: String(x.artName ?? ''), artCode: String(x.artCode ?? ''),
      color: String(x.color ?? ''), colorCode: String(x.colorCode ?? ''), size: String(x.sizeLabel ?? ''),
      quantity: Number(x.quantity), kind, movementType: type, provenance: String(x.provenance),
      userName: String(x.userName ?? ''), reason: (x.reason as string) ?? null, mrp: x.mrp != null ? Number(x.mrp) : null,
      canUndo: kind === 'correction' && x.sourceType === 'adjustment' && !undone, undone,
    }
  })
  return { rows, hasMore: r.rows.length > limit }
}

/** Pairs on hand of one SKU at one location, all provenances. */
export async function skuBalance(db: DbOrTx, skuId: number, locationId: number): Promise<Record<string, number>> {
  const r = await db.execute<{ provenance: string; quantity: number }>(sql`
    SELECT provenance, quantity FROM stock_balances WHERE "skuId" = ${skuId} AND "locationId" = ${locationId}`)
  return Object.fromEntries(r.rows.map((x) => [x.provenance, Number(x.quantity)]))
}

export interface VariantDetail { variant: StockVariant | null; movements: Movement[]; hasMore: boolean }

export interface UnscannedDispatch {
  id: number
  at: string
  orderNumber: string
  articleCode: string
  colourCode: string
  size: string
  mrp: number | null
  artName: string | null
  color: string | null
  userName: string
  raw: string
}

/** Billed boxes that were never in stock, newest first (keyset). One query. */
export async function listUnscannedDispatch(db: DbOrTx, f: { before?: number; limit?: number } = {}): Promise<{ rows: UnscannedDispatch[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(f.limit ?? PAGE_SIZE, 1), 200)
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT b.id, b."postedAt", b."orderNumber", b."articleCode", b."colourCode", b."sizeLabel", b.mrp, b."userName", b."rawInput",
           a."artName", a.color
    FROM bill_scans b
    LEFT JOIN article_sizes s ON s.id = b."skuId"
    LEFT JOIN articles a ON a.id = s."articleId"
    WHERE b.status = 'active' AND b."stockSource" = 'unscanned_dispatch' ${f.before ? sql`AND b.id < ${f.before}` : sql``}
    ORDER BY b.id DESC
    LIMIT ${limit + 1}`)
  return {
    hasMore: r.rows.length > limit,
    rows: r.rows.slice(0, limit).map((x) => ({
      id: Number(x.id), at: new Date(x.postedAt as string).toISOString(), orderNumber: String(x.orderNumber ?? ''),
      articleCode: String(x.articleCode ?? ''), colourCode: String(x.colourCode ?? ''), size: String(x.sizeLabel ?? ''),
      mrp: x.mrp != null ? Number(x.mrp) : null, artName: (x.artName as string) ?? null, color: (x.color as string) ?? null,
      userName: String(x.userName ?? ''), raw: String(x.rawInput ?? ''),
    })),
  }
}
