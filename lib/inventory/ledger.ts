import { eq, sql } from 'drizzle-orm'
import { stockMovements, type MovementType, type Provenance } from '@/lib/db/schema'
import type { DbOrTx } from '@/lib/db/types'

export const MAIN_LOCATION_CODE = 'MAIN'

export interface MovementInput {
  skuId: number
  locationId: number
  provenance: Provenance
  quantity: number
  movementType: Exclude<MovementType, 'reversal'>
  sourceType: string
  sourceId: string | number
  /** Same key ⇒ same movement. A retried request can never post twice. */
  idempotencyKey: string
  userId: string | null
  reason?: string | null
}

/** Insert one ledger line. Returns the existing line when the key was already posted. */
export async function postMovement(db: DbOrTx, m: MovementInput): Promise<{ id: number; created: boolean }> {
  if (!Number.isInteger(m.quantity) || m.quantity === 0) throw new Error('Movement quantity must be a non-zero whole number.')
  const inserted = await db.insert(stockMovements).values({
    skuId: m.skuId,
    locationId: m.locationId,
    provenance: m.provenance,
    quantity: m.quantity,
    movementType: m.movementType,
    sourceType: m.sourceType,
    sourceId: String(m.sourceId),
    idempotencyKey: m.idempotencyKey,
    userId: m.userId,
    reason: m.reason ?? null,
  }).onConflictDoNothing({ target: stockMovements.idempotencyKey }).returning({ id: stockMovements.id })
  if (inserted.length) return { id: inserted[0].id, created: true }
  const [existing] = await db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.idempotencyKey, m.idempotencyKey)).limit(1)
  return { id: existing.id, created: false }
}

/** Post the exact opposite of a movement. A movement can be reversed once. */
export async function reverseMovement(
  db: DbOrTx,
  movementId: number,
  opts: { idempotencyKey: string; userId: string | null; reason: string },
): Promise<{ id: number; created: boolean }> {
  const [orig] = await db.select().from(stockMovements).where(eq(stockMovements.id, movementId)).limit(1)
  if (!orig) throw new Error(`Movement ${movementId} not found.`)
  if (orig.movementType === 'reversal') throw new Error('A reversal cannot itself be reversed; post a new movement.')
  const inserted = await db.insert(stockMovements).values({
    skuId: orig.skuId,
    locationId: orig.locationId,
    provenance: orig.provenance,
    quantity: -orig.quantity,
    movementType: 'reversal',
    sourceType: orig.sourceType,
    sourceId: orig.sourceId,
    idempotencyKey: opts.idempotencyKey,
    reversalOfId: orig.id,
    userId: opts.userId,
    reason: opts.reason,
  }).onConflictDoNothing().returning({ id: stockMovements.id })
  if (inserted.length) return { id: inserted[0].id, created: true }
  const [existing] = await db.select({ id: stockMovements.id }).from(stockMovements)
    .where(sql`${stockMovements.idempotencyKey} = ${opts.idempotencyKey} OR ${stockMovements.reversalOfId} = ${orig.id}`).limit(1)
  return { id: existing.id, created: false }
}

export async function mainLocationId(db: DbOrTx): Promise<number> {
  const r = await db.execute<{ id: number }>(sql`SELECT id FROM locations WHERE code = ${MAIN_LOCATION_CODE} LIMIT 1`)
  const id = r.rows[0]?.id
  if (!id) throw new Error('The MAIN location is missing. Run the database migrations.')
  return Number(id)
}
