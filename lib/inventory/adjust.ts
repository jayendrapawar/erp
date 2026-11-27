// Stock corrections by hand (admin / supervisor). Always through the ledger, never by editing
// balances. A correction never takes a size below zero, and can be undone once.
//
// Provenance: pairs added by hand are 'unscanned' (no box label was read). Pairs removed come
// out of 'unscanned' first, then 'scanned', then 'carton', so no provenance goes negative.

import { eq, sql } from 'drizzle-orm'
import { articleSizes } from '@/lib/db/schema'
import type { Provenance } from '@/lib/db/schema'
import type { Actor, Db } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { mainLocationId, postMovement, reverseMovement } from './ledger'
import { skuBalance } from './stock-queries'

export const MAX_CORRECTION = 10_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMOVE_ORDER: Provenance[] = ['unscanned', 'scanned', 'carton']

/** Serialise every stock change of one SKU inside the current transaction. */
const lockSku = (skuId: number) => sql`SELECT pg_advisory_xact_lock(7301, ${skuId})`

export interface CorrectionInput {
  skuId: number
  /** Pairs to add (positive) or remove (negative). */
  delta: number
  reason: string
  /** Client-generated UUID: a retried request never posts twice. */
  requestId: string
}

export async function correctStock(db: Db, actor: Actor, input: CorrectionInput): Promise<{ posted: boolean; pairsNow: number }> {
  const delta = Number(input.delta)
  const reason = String(input.reason ?? '').trim()
  if (!Number.isInteger(delta) || delta === 0) throw new Error('Enter a whole number of pairs to add or remove.')
  if (Math.abs(delta) > MAX_CORRECTION) throw new Error(`At most ${MAX_CORRECTION} pairs in one correction.`)
  if (reason.length < 3) throw new Error('Write a reason (at least 3 letters).')
  if (!UUID_RE.test(input.requestId)) throw new Error('Invalid request.')
  return db.transaction(async (tx) => {
    await tx.execute(lockSku(input.skuId))
    const [sku] = await tx.select({ id: articleSizes.id }).from(articleSizes).where(eq(articleSizes.id, input.skuId)).limit(1)
    if (!sku) throw new Error('This size no longer exists.')
    const loc = await mainLocationId(tx)
    // Already posted (retry): report the current state.
    const done = await tx.execute(sql`SELECT 1 FROM stock_movements WHERE "sourceType" = 'adjustment' AND "sourceId" = ${input.requestId} LIMIT 1`)
    const bal = await skuBalance(tx, input.skuId, loc)
    const onHand = Object.values(bal).reduce((n, q) => n + q, 0)
    if (done.rows.length) return { posted: false, pairsNow: onHand }

    const parts: { provenance: Provenance; quantity: number }[] = []
    if (delta > 0) parts.push({ provenance: 'unscanned', quantity: delta })
    else {
      if (onHand + delta < 0) throw new Error(`Only ${onHand} pair${onHand === 1 ? '' : 's'} in stock for this size; cannot remove ${-delta}.`)
      let left = -delta
      for (const p of REMOVE_ORDER) {
        const take = Math.min(left, Math.max(bal[p] ?? 0, 0))
        if (take > 0) { parts.push({ provenance: p, quantity: -take }); left -= take }
      }
      if (left > 0) throw new Error('Stock changed while saving. Try again.')
    }
    for (const part of parts) {
      await postMovement(tx, {
        skuId: input.skuId, locationId: loc, provenance: part.provenance, quantity: part.quantity,
        movementType: 'adjustment', sourceType: 'adjustment', sourceId: input.requestId,
        idempotencyKey: `adjustment:${input.requestId}:${part.provenance}`, userId: actor.id, reason,
      })
    }
    await audit(tx, { actor, action: 'stock.corrected', entityType: 'sku', entityId: input.skuId, before: { pairs: onHand }, after: { pairs: onHand + delta, parts }, reason })
    return { posted: true, pairsNow: onHand + delta }
  })
}

/** Undo one correction movement (a reversal with a reason). Refuses if it would take stock below zero. */
export async function undoCorrection(db: Db, actor: Actor, movementId: number, reason: string): Promise<{ pairsNow: number }> {
  const why = String(reason ?? '').trim()
  if (why.length < 3) throw new Error('Write a reason (at least 3 letters).')
  return db.transaction(async (tx) => {
    const r = await tx.execute<{ skuId: number; locationId: number; quantity: number; movementType: string; sourceType: string; provenance: string; undone: boolean }>(sql`
      SELECT "skuId", "locationId", quantity, "movementType", "sourceType", provenance,
             EXISTS (SELECT 1 FROM stock_movements r WHERE r."reversalOfId" = m.id) AS undone
      FROM stock_movements m WHERE id = ${movementId}`)
    const m = r.rows[0]
    if (!m) throw new Error('Movement not found.')
    if (m.movementType !== 'adjustment' || m.sourceType !== 'adjustment') throw new Error('Only hand corrections can be undone here. Undo a scan from the scanner.')
    await tx.execute(lockSku(Number(m.skuId)))
    // Checked after the lock, so two people undoing at once cannot both pass.
    const again = await tx.execute(sql`SELECT 1 FROM stock_movements WHERE "reversalOfId" = ${movementId} LIMIT 1`)
    if (m.undone || again.rows.length) throw new Error('This correction was already undone.')
    const bal = await skuBalance(tx, Number(m.skuId), Number(m.locationId))
    const after = (bal[m.provenance] ?? 0) - Number(m.quantity)
    if (after < 0) throw new Error(`Undoing this would leave ${after} pairs (${m.provenance}). Correct the stock instead.`)
    await reverseMovement(tx, movementId, { idempotencyKey: `adjustment-undo:${movementId}`, userId: actor.id, reason: why })
    await audit(tx, { actor, action: 'stock.correction_undone', entityType: 'stock_movement', entityId: movementId, before: { quantity: Number(m.quantity) }, reason: why })
    const total = Object.values(await skuBalance(tx, Number(m.skuId), Number(m.locationId))).reduce((n, q) => n + q, 0)
    return { pairsNow: total }
  })
}
