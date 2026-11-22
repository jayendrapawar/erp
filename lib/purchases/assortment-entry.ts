// The receiver's answer to "which assortment is in this carton?" (server only), shared by scanned
// cartons (store.ts receiveCarton) and manual entry (manual-carton.ts). Owner, 22 Nov 2026: every
// carton shows the proposed assortment to confirm; when none fits, the receiver types the pairs per
// size and it is saved to Master → Assortments.
//
// Runs inside the caller's transaction with the bill line locked. Statements: confirm an existing
// assortment 1–3; a new one ~6 (lock, read, insert, audit, propose for other open lines, segment).

import { sql } from 'drizzle-orm'
import type { AssortmentSize } from '@/lib/db/schema'
import type { Actor, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { expandSizeRange } from '@/lib/catalog/sizes'
import { SEGMENTS, sameSizes, validateAssortment } from '@/lib/catalog/assortments'
import { addArticleToAssortment } from '@/lib/catalog/assortment-store'
import { coverRankSql, proposeOpenLines } from './assortment-match'

const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`
export const rangeCode = (from: string, to: string) => `${from}${to.padStart(2, '0')}`

export interface AssortmentAnswer {
  /** Use this active assortment (one of the carton's options). */
  assortmentId?: number | null
  /** The chosen assortment is "only for" other articles: use it for this article too. */
  addArticle?: boolean
  /** Or the pairs per size typed by the receiver (none fits, or none is right). */
  newAssortment?: { segment: string; sizes: AssortmentSize[] } | null
}

export interface LockedLine {
  id: number; refNo: string; division: string; articleCode: string
  pairsPerCarton: number; sizeFrom: string; sizeTo: string; assortmentId: number | null
}

export class NeedsAssortment extends Error {}

/** Apply the answer to the line; returns the assortment id its cartons now use. */
export async function settleLineAssortment(tx: DbOrTx, actor: Actor, line: LockedLine, answer: AssortmentAnswer, from: string): Promise<number> {
  const code = rangeCode(line.sizeFrom, line.sizeTo)
  let id: number
  if (answer.assortmentId) {
    const ok = await tx.execute<{ cover: number }>(sql`
      SELECT ${coverRankSql(sql`${line.articleCode}::text`, sql`"onlyFor"`)} AS cover FROM carton_assortments
       WHERE id = ${answer.assortmentId} AND active AND division = ${line.division} AND packing = ${line.pairsPerCarton} AND code = ${code}`)
    if (!ok.rows.length) throw new Error('That assortment does not fit this carton (division, pairs per carton and size range must match). Reload and try again.')
    if (Number(ok.rows[0].cover) < 0) {
      if (!answer.addArticle) throw new Error(`That assortment is only for other articles. Confirm using it for ${line.articleCode} too, or enter the pairs per size.`)
      await addArticleToAssortment(tx, actor, answer.assortmentId, line.articleCode)
    }
    id = answer.assortmentId
  } else if (answer.newAssortment) {
    id = await createFromCarton(tx, actor, line, code, answer.newAssortment, from)
  } else {
    throw new NeedsAssortment('Enter the pairs in each size of this carton.')
  }
  if (line.assortmentId !== id) {
    await tx.execute(sql`UPDATE purchase_bill_lines SET "assortmentId" = ${id} WHERE id = ${line.id}`)
    await audit(tx, { actor, action: 'purchase_bill.line_assortment', entityType: 'purchase_bill_line', entityId: line.id, before: { assortmentId: line.assortmentId }, after: { assortmentId: id, from } })
  }
  return id
}

async function createFromCarton(tx: DbOrTx, actor: Actor, line: LockedLine, code: string, entered: { segment: string; sizes: AssortmentSize[] }, from: string): Promise<number> {
  if (!line.division) throw new Error(`Bill ${line.refNo} has no division. Set it on the bill first (Purchases → Bills).`)
  const range = expandSizeRange(line.sizeFrom, line.sizeTo)
  const sizes = range.ok ? range.sizes : [line.sizeFrom]
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('carton_assortments'))`)
  // Anything else with these pairs already exists: the typed one is for this article only, so it
  // never changes what other articles get (and wins for this article next time).
  const others = await tx.execute(sql`SELECT 1 FROM carton_assortments WHERE active AND division = ${line.division} AND packing = ${line.pairsPerCarton} AND code = ${code} LIMIT 1`)
  const v = validateAssortment({
    division: line.division, segment: entered.segment, packing: Number(line.pairsPerCarton), code, sizes: entered.sizes,
    note: `Entered at ${from} (bill ${line.refNo})`, onlyFor: others.rows.length ? line.articleCode : '',
  })
  if (v.errors.length) throw new Error(v.errors.join(' '))
  if (v.value.sizes.some((s) => !sizes.includes(s.size))) throw new Error(`Only sizes ${sizes.join(', ')} belong to this carton.`)
  const same = await tx.execute<{ id: number; sizes: AssortmentSize[] }>(sql`
    SELECT id, sizes FROM carton_assortments WHERE active AND division = ${v.value.division} AND segment = ${v.value.segment}
       AND packing = ${v.value.packing} AND code = ${v.value.code} AND "onlyFor" = ${v.value.onlyFor ?? ''}`)
  if (same.rows[0]) {
    if (sameSizes(same.rows[0].sizes, v.value.sizes)) return Number(same.rows[0].id)
    throw new Error(`${line.articleCode} already has its own ${v.value.segment} assortment for ${v.value.packing} pairs · code ${code} with other pairs per size. Choose it above, or change it in Master → Assortments.`)
  }
  const ins = await tx.execute<{ id: number }>(sql`
    INSERT INTO carton_assortments (division, segment, packing, code, sizes, note, "onlyFor", source, "createdBy", version)
    VALUES (${v.value.division}, ${v.value.segment}, ${v.value.packing}, ${v.value.code}, ${JSON.stringify(v.value.sizes)}::jsonb, ${v.value.note ?? ''}, ${v.value.onlyFor ?? ''}, 'manual', ${actor.id},
            (SELECT coalesce(max(version), 0) + 1 FROM carton_assortments WHERE division = ${v.value.division} AND segment = ${v.value.segment} AND packing = ${v.value.packing} AND code = ${v.value.code} AND "onlyFor" = ${v.value.onlyFor ?? ''}))
    RETURNING id`)
  const id = Number(ins.rows[0].id)
  await audit(tx, { actor, action: 'assortment.created', entityType: 'carton_assortment', entityId: id, after: { ...v.value, from } })
  // Other open lines of this kind without an assortment get a proposal now (still confirmed per carton).
  await proposeOpenLines(tx, { division: v.value.division, packing: v.value.packing, code: v.value.code })
  // The article gets this segment if it has none yet.
  if ((SEGMENTS as readonly string[]).includes(v.value.segment)) {
    await tx.execute(sql`UPDATE articles SET segment = ${v.value.segment} WHERE ${NORM(sql`"artCode"`)} = ${line.articleCode} AND segment IS NULL`)
  }
  return id
}
