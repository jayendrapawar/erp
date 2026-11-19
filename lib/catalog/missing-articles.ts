// Scanned code/colour pairs that are not (fully) in the article master (Master → Articles → Missing articles).
import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'
import { sortSizes } from '@/lib/catalog/sizes'

export type MissingArticle = {
  artCode: string
  colorCode: string
  boxCount: number
  scanCount: number
  sizes: string[]
  mrps: string[]
  rawQr: string
  /** 'missing_article': code/colour unknown. 'missing_size': article known, size not configured. */
  kind: 'missing_article' | 'missing_size'
  firstSeen: string
  lastSeen: string
  scannedBy: string[]
  reviewStatus: 'open' | 'ignored'
  reviewNote: string
}

/**
 * Scanned code/colour pairs that are not (fully) in the article master. Built from warehouse scan
 * events plus boxes billed in Direct Billing whose article/colour is not in the master (a box
 * the warehouse also scanned is counted once).
 */
export async function listMissingArticles(db: DbOrTx): Promise<MissingArticle[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    WITH e AS (
      SELECT s."articleCode", s."colourCode", s.quantity, s."sizeLabel", s.mrp, s."rawInput", s.resolution, s."createdAt", s."userName"
      FROM scan_events s
      WHERE s.status = 'active' AND s.resolution <> 'resolved' AND s."articleCode" IS NOT NULL
      UNION ALL
      SELECT b."articleCode", b."colourCode", 1, b."sizeLabel", b.mrp, b."rawInput", 'missing_article', b."createdAt", b."userName"
      FROM bill_scans b
      WHERE b.status = 'active' AND b."articleCode" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.active
              AND upper(regexp_replace(btrim(a."artCode"), '\\s+', ' ', 'g')) = b."articleCode"
              AND upper(regexp_replace(btrim(a."colorCode"), '\\s+', ' ', 'g')) = coalesce(b."colourCode", ''))
        AND NOT EXISTS (SELECT 1 FROM scan_events s WHERE s."dedupeKey" = b."dedupeKey" AND s.status = 'active')
    )
    SELECT e."articleCode", e."colourCode",
           sum(e.quantity)::int AS boxes, count(*)::int AS scans,
           array_remove(array_agg(DISTINCT e."sizeLabel"), NULL) AS sizes,
           array_remove(array_agg(DISTINCT e.mrp::text), NULL) AS mrps,
           (array_agg(e."rawInput" ORDER BY e."createdAt" DESC) FILTER (WHERE e."rawInput" IS NOT NULL))[1] AS raw,
           bool_or(e.resolution = 'missing_article') AS "anyMissingArticle",
           min(e."createdAt") AS first, max(e."createdAt") AS last,
           array_agg(DISTINCT e."userName") AS users,
           coalesce(max(r.status), 'open') AS "reviewStatus", coalesce(max(r.note), '') AS "reviewNote"
    FROM e
    LEFT JOIN missing_article_reviews r ON r."articleCode" = e."articleCode" AND r."colourCode" = coalesce(e."colourCode", '')
    GROUP BY e."articleCode", e."colourCode"
    ORDER BY max(e."createdAt") DESC
    LIMIT 500`)
  return r.rows.map((x) => ({
    artCode: x.articleCode as string,
    colorCode: (x.colourCode as string) ?? '',
    boxCount: Number(x.boxes),
    scanCount: Number(x.scans),
    sizes: sortSizes((x.sizes as string[]) ?? []),
    mrps: ((x.mrps as string[]) ?? []).sort((a, b) => Number(a) - Number(b)),
    rawQr: (x.raw as string) ?? '',
    kind: x.anyMissingArticle ? 'missing_article' : 'missing_size',
    firstSeen: new Date(x.first as string).toISOString(),
    lastSeen: new Date(x.last as string).toISOString(),
    scannedBy: ((x.users as string[]) ?? []).filter(Boolean),
    reviewStatus: x.reviewStatus as 'open' | 'ignored',
    reviewNote: x.reviewNote as string,
  }))
}
