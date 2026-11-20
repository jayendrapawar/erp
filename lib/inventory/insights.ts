// Inventory → Overview (owner, 20 Nov 2026): old stock, cut-size stock, non-moving / dead stock,
// top movers and size-wise reorder suggestions. Read-only; nothing is cached or stored.
//
// Rules (owner's choices):
//   • Old stock: age from the MANUFACTURING month on each box label still in stock. Bands 0–6,
//     6–12, 12+ months (12+ = old). Pairs never scanned box by box (carton / hand-counted) are
//     "age unknown".
//   • Cut size: an article colour in stock where some size of its range has HALF OR LESS of the
//     pairs of its fullest size (0 counts). Filters on screen: any short size / missing sizes /
//     half or more sizes short.
//   • Non-moving ≥ 60 days, dead ≥ 180 days without a sale, counted from the later of the last
//     sale and the first time the stock came in (new arrivals are not flagged).
//   • Top movers: pairs billed in the last 7 / 30 / 90 days (undone bills subtracted).
//   • Reorder: per size, last 30 days' sales rate; suggested when stock covers < 30 days; amount
//     to cover 60 days. A size is "selling ahead" when its share of sales exceeds its share of
//     stock by 10+ points.
//
// Database work: 2 queries in parallel per Overview open (stock + sales per size; box ages).
// Both read the ledger once; fine at today's volume — measure before adding summaries.

import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'

export const INSIGHT_RULES = {
  oldMonths: 12,
  midMonths: 6,
  nonMovingDays: 60,
  deadDays: 180,
  reorderCoverDays: 30,
  reorderTargetDays: 60,
  salesWindowDays: 30,
  aheadPoints: 10,
  listLimit: 200,
} as const

const DIVISION = sql`coalesce(nullif(a.division, ''), initcap(c.brand), '')`

export interface InsightSize { skuId: number; size: string; pairs: number; sold7: number; sold30: number; sold90: number }
export interface InsightVariant {
  articleId: number
  artName: string
  artCode: string
  color: string
  colorCode: string
  segment: string | null
  division: string
  pairs: number
  sizes: InsightSize[]
}
export interface OldRow extends InsightVariant { bands: { lt6: number; m6to12: number; old: number; unknown: number }; oldestMfg: string | null }
export interface CutRow extends InsightVariant { fullest: number; missing: string[]; short: string[] }
export interface IdleRow extends InsightVariant { idleDays: number; lastSale: string | null; since: string }
export interface MoverRow extends InsightVariant { sold: number }
export interface ReorderRow { articleId: number; artName: string; artCode: string; color: string; size: string; pairs: number; sold30: number; coverDays: number | null; suggest: number }
export interface ShareRow { key: string; sold: number; pairs: number; soldShare: number; stockShare: number; ahead: boolean }

export interface InventoryInsights {
  generatedAt: string
  rules: typeof INSIGHT_RULES
  /** Date of the first stock movement: before it there is no history (non-moving needs time). */
  historySince: string | null
  old: { totals: { lt6: number; m6to12: number; old: number; unknown: number }; rows: OldRow[] }
  cut: { count: number; rows: CutRow[] }
  idle: { nonMoving: { count: number; pairs: number }; dead: { count: number; pairs: number }; rows: IdleRow[] }
  movers: Record<7 | 30 | 90, { pairs: number; rows: MoverRow[] }>
  sizes: ShareRow[]
  colours: ShareRow[]
  reorder: { count: number; rows: ReorderRow[] }
}

const DAY = 86_400_000

export async function inventoryInsights(db: DbOrTx): Promise<InventoryInsights> {
  const [skuRes, ageRes] = await Promise.all([
    // Per size of every article colour that has stock or sold in 90 days: on hand, sold 7/30/90,
    // last sale, first stock-in.
    db.execute<Record<string, unknown>>(sql`
      WITH bal AS (SELECT "skuId", sum(quantity)::int AS q FROM stock_balances GROUP BY 1),
      mv AS (
        SELECT m."skuId",
          coalesce(-sum(m.quantity) FILTER (WHERE x.sale AND m."createdAt" >= now() - interval '7 days'), 0)::int AS s7,
          coalesce(-sum(m.quantity) FILTER (WHERE x.sale AND m."createdAt" >= now() - interval '30 days'), 0)::int AS s30,
          coalesce(-sum(m.quantity) FILTER (WHERE x.sale AND m."createdAt" >= now() - interval '90 days'), 0)::int AS s90,
          max(m."createdAt") FILTER (WHERE m."movementType" = 'dispatch') AS "lastSale",
          min(m."createdAt") FILTER (WHERE m.quantity > 0 AND m."movementType" NOT IN ('provenance_transfer', 'reversal')) AS "firstIn"
        FROM stock_movements m
        LEFT JOIN stock_movements o ON m."movementType" = 'reversal' AND o.id = m."reversalOfId"
        CROSS JOIN LATERAL (SELECT (m."movementType" = 'dispatch' OR o."movementType" = 'dispatch') AS sale) x
        GROUP BY m."skuId"
      ),
      live AS (
        SELECT s."articleId" FROM article_sizes s LEFT JOIN bal ON bal."skuId" = s.id LEFT JOIN mv ON mv."skuId" = s.id
        GROUP BY s."articleId" HAVING sum(coalesce(bal.q, 0)) > 0 OR sum(coalesce(mv.s90, 0)) > 0
      )
      SELECT a.id AS "articleId", a."artName", a."artCode", a.color, a."colorCode", a.segment, ${DIVISION} AS division,
             s.id AS "skuId", s."sizeLabel" AS size, coalesce(bal.q, 0) AS q,
             coalesce(mv.s7, 0) AS s7, coalesce(mv.s30, 0) AS s30, coalesce(mv.s90, 0) AS s90, mv."lastSale", mv."firstIn",
             (SELECT min("createdAt") FROM stock_movements) AS "historySince"
      FROM live JOIN articles a ON a.id = live."articleId"
      LEFT JOIN catalog_articles c ON c.id = a."catalogArticleId"
      JOIN article_sizes s ON s."articleId" = a.id
      LEFT JOIN bal ON bal."skuId" = s.id LEFT JOIN mv ON mv."skuId" = s.id
      WHERE s.active OR coalesce(bal.q, 0) <> 0
      ORDER BY a."artName", a."artCode", a.color, a.id, s."sortOrder", s."sizeLabel"`),
    // Boxes still in stock (scanned in, not billed) with their manufacturing age in months.
    db.execute<{ skuId: number; lt6: number; m6to12: number; old: number; oldest: string | null }>(sql`
      WITH billed AS (
        SELECT b."dedupeKey" FROM bill_scans b
        WHERE EXISTS (SELECT 1 FROM stock_movements m WHERE m."sourceType" = 'bill_scan' AND m."sourceId" = b.id::text AND m."movementType" = 'dispatch'
                        AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r."reversalOfId" = m.id))
      ),
      boxes AS (
        SELECT e."skuId", (extract(year FROM now())::int * 12 + extract(month FROM now())::int) - (e."mfgYear" * 12 + e."mfgMonth") AS age, make_date(e."mfgYear", e."mfgMonth", 1) AS mfg
        FROM scan_events e
        WHERE e.status = 'active' AND e.resolution = 'resolved' AND e."skuId" IS NOT NULL AND e."mfgYear" IS NOT NULL AND e."mfgMonth" BETWEEN 1 AND 12
          AND NOT EXISTS (SELECT 1 FROM billed WHERE billed."dedupeKey" = e."dedupeKey")
      )
      SELECT "skuId",
             count(*) FILTER (WHERE age < ${INSIGHT_RULES.midMonths})::int AS lt6,
             count(*) FILTER (WHERE age >= ${INSIGHT_RULES.midMonths} AND age < ${INSIGHT_RULES.oldMonths})::int AS m6to12,
             count(*) FILTER (WHERE age >= ${INSIGHT_RULES.oldMonths})::int AS old,
             min(mfg)::text AS oldest
      FROM boxes GROUP BY "skuId"`),
  ])
  return buildInsights(skuRes.rows, ageRes.rows, new Date())
}

/** Pure part (unit-testable): rows → sections. */
export function buildInsights(
  skuRows: Record<string, unknown>[],
  ageRows: { skuId: number; lt6: number; m6to12: number; old: number; oldest: string | null }[],
  now: Date,
): InventoryInsights {
  const R = INSIGHT_RULES
  const variants = new Map<number, InsightVariant & { lastSale: number | null; firstIn: number | null }>()
  let historySince: string | null = null
  for (const r of skuRows) {
    const id = Number(r.articleId)
    let v = variants.get(id)
    if (!v) {
      v = { articleId: id, artName: String(r.artName ?? ''), artCode: String(r.artCode ?? ''), color: String(r.color ?? ''), colorCode: String(r.colorCode ?? ''),
        segment: (r.segment as string | null) ?? null, division: String(r.division ?? ''), pairs: 0, sizes: [], lastSale: null, firstIn: null }
      variants.set(id, v)
    }
    const q = Number(r.q ?? 0)
    v.sizes.push({ skuId: Number(r.skuId), size: String(r.size), pairs: q, sold7: Number(r.s7 ?? 0), sold30: Number(r.s30 ?? 0), sold90: Number(r.s90 ?? 0) })
    v.pairs += Math.max(0, q)
    const ls = r.lastSale ? new Date(r.lastSale as string).getTime() : null
    const fi = r.firstIn ? new Date(r.firstIn as string).getTime() : null
    if (ls != null && (v.lastSale == null || ls > v.lastSale)) v.lastSale = ls
    if (fi != null && (v.firstIn == null || fi < v.firstIn)) v.firstIn = fi
    if (r.historySince && !historySince) historySince = new Date(r.historySince as string).toISOString()
  }
  const all = [...variants.values()]
  const strip = ({ lastSale: _l, firstIn: _f, ...v }: InsightVariant & { lastSale: number | null; firstIn: number | null }): InsightVariant => v
  const inStock = all.filter((v) => v.pairs > 0)

  // ── Old stock ──
  const ageBySku = new Map(ageRows.map((a) => [Number(a.skuId), a]))
  const oldTotals = { lt6: 0, m6to12: 0, old: 0, unknown: 0 }
  const oldRows: OldRow[] = []
  for (const v of inStock) {
    const bands = { lt6: 0, m6to12: 0, old: 0, unknown: 0 }
    let oldest: string | null = null
    for (const s of v.sizes) {
      if (s.pairs <= 0) continue
      const a = ageBySku.get(s.skuId)
      let b = { lt6: a?.lt6 ?? 0, m6to12: a?.m6to12 ?? 0, old: a?.old ?? 0 }
      // Hand corrections can leave fewer pairs than boxes on record: drop the newest first.
      let excess = b.lt6 + b.m6to12 + b.old - s.pairs
      for (const k of ['lt6', 'm6to12', 'old'] as const) { const cut = Math.min(b[k], Math.max(0, excess)); b = { ...b, [k]: b[k] - cut }; excess -= cut }
      bands.lt6 += b.lt6; bands.m6to12 += b.m6to12; bands.old += b.old
      bands.unknown += Math.max(0, s.pairs - (b.lt6 + b.m6to12 + b.old))
      if (b.old > 0 && a?.oldest && (!oldest || a.oldest < oldest)) oldest = a.oldest
    }
    for (const k of Object.keys(oldTotals) as (keyof typeof oldTotals)[]) oldTotals[k] += bands[k]
    if (bands.old > 0) oldRows.push({ ...strip(v), bands, oldestMfg: oldest })
  }
  oldRows.sort((a, b) => b.bands.old - a.bands.old)

  // ── Cut size ──
  const cutRows: CutRow[] = []
  for (const v of inStock) {
    const sized = v.sizes.filter((s) => s.pairs >= 0)
    if (sized.length < 2) continue
    const fullest = Math.max(...sized.map((s) => s.pairs))
    const short = sized.filter((s) => s.pairs <= fullest / 2).map((s) => s.size)
    if (!short.length) continue
    cutRows.push({ ...strip(v), fullest, missing: sized.filter((s) => s.pairs <= 0).map((s) => s.size), short })
  }
  cutRows.sort((a, b) => b.short.length / b.sizes.length - a.short.length / a.sizes.length || b.pairs - a.pairs)

  // ── Non-moving / dead ──
  const idleRows: IdleRow[] = []
  const idle = { nonMoving: { count: 0, pairs: 0 }, dead: { count: 0, pairs: 0 } }
  for (const v of inStock) {
    const since = Math.max(v.lastSale ?? 0, v.firstIn ?? 0)
    if (!since) continue
    const days = Math.floor((now.getTime() - since) / DAY)
    if (days < R.nonMovingDays) continue
    const bucket = days >= R.deadDays ? idle.dead : idle.nonMoving
    bucket.count++; bucket.pairs += v.pairs
    idleRows.push({ ...strip(v), idleDays: days, lastSale: v.lastSale ? new Date(v.lastSale).toISOString() : null, since: new Date(since).toISOString() })
  }
  idleRows.sort((a, b) => b.idleDays - a.idleDays || b.pairs - a.pairs)

  // ── Top movers ──
  const movers = {} as InventoryInsights['movers']
  for (const p of [7, 30, 90] as const) {
    const key = p === 7 ? 'sold7' : p === 30 ? 'sold30' : 'sold90'
    const rows = all.map((v) => ({ ...strip(v), sold: v.sizes.reduce((n, s) => n + s[key], 0) })).filter((r) => r.sold > 0).sort((a, b) => b.sold - a.sold)
    movers[p] = { pairs: rows.reduce((n, r) => n + r.sold, 0), rows: rows.slice(0, 50) }
  }

  // ── Size and colour mix (last 30 days' sales vs stock now) ──
  const share = (keyOf: (v: InsightVariant, s: InsightSize) => string): ShareRow[] => {
    const m = new Map<string, { sold: number; pairs: number }>()
    for (const v of all) for (const s of v.sizes) {
      const k = keyOf(v, s)
      const cur = m.get(k) ?? { sold: 0, pairs: 0 }
      cur.sold += s.sold30; cur.pairs += Math.max(0, s.pairs)
      m.set(k, cur)
    }
    const totSold = [...m.values()].reduce((n, x) => n + x.sold, 0)
    const totPairs = [...m.values()].reduce((n, x) => n + x.pairs, 0)
    return [...m].map(([key, x]) => {
      const soldShare = totSold ? (x.sold / totSold) * 100 : 0
      const stockShare = totPairs ? (x.pairs / totPairs) * 100 : 0
      return { key, sold: x.sold, pairs: x.pairs, soldShare: Math.round(soldShare * 10) / 10, stockShare: Math.round(stockShare * 10) / 10, ahead: x.sold > 0 && soldShare - stockShare >= R.aheadPoints }
    })
  }
  const sizeOrder = (k: string) => { const n = Number(k); return Number.isFinite(n) ? (n >= 11 ? n - 20 : n) : 100 }
  const sizes = share((_v, s) => s.size).sort((a, b) => sizeOrder(a.key) - sizeOrder(b.key))
  const colours = share((v) => v.color.trim().toUpperCase() || '—').filter((c) => c.sold > 0).sort((a, b) => b.sold - a.sold).slice(0, 20)

  // ── Reorder suggestions ──
  const reorder: ReorderRow[] = []
  for (const v of all) for (const s of v.sizes) {
    if (s.sold30 <= 0) continue
    const rate = s.sold30 / R.salesWindowDays
    const cover = s.pairs > 0 ? s.pairs / rate : 0
    if (cover >= R.reorderCoverDays) continue
    reorder.push({ articleId: v.articleId, artName: v.artName, artCode: v.artCode, color: v.color, size: s.size, pairs: s.pairs, sold30: s.sold30,
      coverDays: Math.round(cover), suggest: Math.max(1, Math.ceil(rate * R.reorderTargetDays - Math.max(0, s.pairs))) })
  }
  reorder.sort((a, b) => (a.coverDays ?? 0) - (b.coverDays ?? 0) || b.sold30 - a.sold30)

  return {
    generatedAt: now.toISOString(),
    rules: R,
    historySince,
    old: { totals: oldTotals, rows: oldRows.slice(0, R.listLimit) },
    cut: { count: cutRows.length, rows: cutRows.slice(0, 400) },
    idle: { ...idle, rows: idleRows.slice(0, R.listLimit) },
    movers,
    sizes,
    colours,
    reorder: { count: reorder.length, rows: reorder.slice(0, R.listLimit) },
  }
}
