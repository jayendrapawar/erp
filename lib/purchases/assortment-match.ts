// Which carton assortment fits a bill line (server only). One rule everywhere — bill import, the
// bill screen, carton receiving and manual entry — mirroring rankAssortments() in
// lib/catalog/assortments.ts:
//   • fits = same division (the bill's) + pairs per carton + size code;
//   • the article's segment (from the article master) must match, or the assortment is for "Any";
//   • "only for" must allow the article: its code listed, or its family ("PUB*"), or '' = any;
//   • the most specific wins: code > family > any article, then own segment > "Any".
// Owner (22 Nov 2026): every scanned carton still asks the receiver to confirm the proposal.

import { sql, type SQL } from 'drizzle-orm'
import type { AssortmentSize } from '@/lib/db/schema'
import type { DbOrTx } from '@/lib/db/types'
import { rankAssortments } from '@/lib/catalog/assortments'

const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`

/** 2 = code listed, 1 = family listed ("PUB*"), 0 = any article, -1 = not for this article. */
export const coverRankSql = (articleCode: SQL, onlyFor: SQL) => sql`(CASE
  WHEN ${onlyFor} = '' THEN 0
  WHEN ${articleCode} = ANY(string_to_array(${onlyFor}, ',')) THEN 2
  WHEN EXISTS (SELECT 1 FROM unnest(string_to_array(${onlyFor}, ',')) AS f(x) WHERE right(f.x, 1) = '*' AND ${articleCode} LIKE left(f.x, -1) || '%') THEN 1
  ELSE -1 END)`

/** 1 = same segment, 0 = "Any" or the article has no segment yet, -1 = another segment. */
export const segmentRankSql = (assortmentSegment: SQL, articleSegment: SQL) => sql`(CASE
  WHEN ${articleSegment} IS NULL THEN 0 WHEN ${assortmentSegment} = ${articleSegment} THEN 1 WHEN ${assortmentSegment} = 'Any' THEN 0 ELSE -1 END)`

/** Segment of a bill line's article: this colour first, else any colour of the code. */
export const articleSegmentSql = (articleCode: SQL, colourCode: SQL) => sql`coalesce(
  (SELECT v.segment FROM articles v WHERE ${NORM(sql`v."artCode"`)} = ${articleCode} AND ${NORM(sql`v."colorCode"`)} = ${colourCode} AND v.active AND v.segment IS NOT NULL LIMIT 1),
  (SELECT v.segment FROM articles v WHERE ${NORM(sql`v."artCode"`)} = ${articleCode} AND v.active AND v.segment IS NOT NULL ORDER BY v.id LIMIT 1))`

/**
 * Give lines of a bill without an assortment the one the rule proposes (when the best group has one
 * content). Received cartons still ask for confirmation. One statement; returns how many were set.
 */
export function proposeLineAssortments(tx: DbOrTx, billId: number): Promise<number> {
  return propose(tx, sql`l2."billId" = ${billId}`)
}

/** Same, for open bills' lines of one carton kind (after a new assortment was entered). One statement. */
export function proposeOpenLines(tx: DbOrTx, kind: { division: string; packing: number; code: string }): Promise<number> {
  return propose(tx, sql`b.status IN ('expected', 'partial') AND b.division = ${kind.division} AND l2."pairsPerCarton" = ${kind.packing}
    AND l2."sizeFrom" || lpad(l2."sizeTo", 2, '0') = ${kind.code}`)
}

async function propose(tx: DbOrTx, where: SQL): Promise<number> {
  const r = await tx.execute(sql`
    WITH cand AS (
      SELECT l2.id AS line_id, a.id AS a_id, a.sizes::text AS sz,
             ${coverRankSql(sql`l2."articleCode"`, sql`a."onlyFor"`)} AS cover,
             ${segmentRankSql(sql`a.segment`, sql`s.seg`)} AS segr
        FROM purchase_bill_lines l2
        JOIN purchase_bills b ON b.id = l2."billId"
        CROSS JOIN LATERAL (SELECT ${articleSegmentSql(sql`l2."articleCode"`, sql`l2."colourCode"`)} AS seg) s
        JOIN carton_assortments a ON a.active AND a.division = b.division AND a.packing = l2."pairsPerCarton"
         AND a.code = l2."sizeFrom" || lpad(l2."sizeTo", 2, '0')
       WHERE ${where} AND l2."assortmentId" IS NULL AND l2."sizeFrom" <> l2."sizeTo"),
    top AS (
      SELECT *, rank() OVER (PARTITION BY line_id ORDER BY cover DESC, segr DESC) AS r
        FROM cand WHERE cover >= 0 AND segr >= 0)
    UPDATE purchase_bill_lines l SET "assortmentId" = x.id
      FROM (SELECT line_id, min(a_id) AS id FROM top WHERE r = 1 GROUP BY line_id HAVING count(DISTINCT sz) = 1) x
     WHERE l.id = x.line_id`)
  return r.rowCount ?? 0
}

export interface AssortmentChoice {
  id: number; segment: string; version: number; sizes: AssortmentSize[]
  /** Article codes / families it is only for ('' = any); covers = it applies to this article. */
  onlyFor: string; covers: boolean
}

export interface LineChoices {
  /** Segment of the article in the master (null = not set). */
  articleSegment: string | null
  /** Every active assortment with this division, pairs per carton and size code (any segment, any "only for"). */
  options: AssortmentChoice[]
  /** The one to propose: the line's own, else the best by the rule (null = the user chooses or enters one). */
  proposal: AssortmentChoice | null
}

type Row = { lineId: number; assortmentId: number | null; articleCode: string; seg: string | null; options: AssortmentChoice[] | null }

/** Choices for multi-size bill lines: some lines, or every line of a bill (one query). */
export async function lineChoices(db: DbOrTx, sel: { lineIds: number[] } | { billId: number }): Promise<Map<number, LineChoices>> {
  const out = new Map<number, LineChoices>()
  if ('lineIds' in sel && !sel.lineIds.length) return out
  const where = 'billId' in sel
    ? sql`l."billId" = ${sel.billId} AND l."sizeFrom" <> l."sizeTo"`
    : sql`l.id IN (SELECT json_array_elements_text(${JSON.stringify(sel.lineIds)}::json)::int)`
  const r = await db.execute<Row>(sql`
    SELECT l.id AS "lineId", l."assortmentId", l."articleCode", s.seg,
           (SELECT json_agg(json_build_object('id', a.id, 'segment', a.segment, 'version', a.version, 'sizes', a.sizes, 'onlyFor', a."onlyFor",
                                              'covers', ${coverRankSql(sql`l."articleCode"`, sql`a."onlyFor"`)} >= 0) ORDER BY a.segment, a."onlyFor", a.id)
              FROM carton_assortments a
             WHERE a.active AND a.division = b.division AND a.packing = l."pairsPerCarton" AND a.code = l."sizeFrom" || lpad(l."sizeTo", 2, '0')) AS options
      FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l."billId"
      CROSS JOIN LATERAL (SELECT ${articleSegmentSql(sql`l."articleCode"`, sql`l."colourCode"`)} AS seg) s
     WHERE ${where}`)
  for (const x of r.rows) {
    const options = (x.options ?? []).map((o) => ({ ...o, id: Number(o.id), version: Number(o.version), onlyFor: o.onlyFor ?? '' }))
    const own = x.assortmentId != null ? options.find((o) => o.id === Number(x.assortmentId)) ?? null : null
    const proposal = own ?? rankAssortments(options, { code: x.articleCode, segment: x.seg }).pick
    out.set(Number(x.lineId), { articleSegment: x.seg ?? null, options, proposal })
  }
  return out
}
