// Database side of carton assortments (server only). Used by app/actions/assortments.ts and
// scripts/catalog/import-assortments.ts. Every write runs in one transaction with an audit row.

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { cartonAssortments, type AssortmentSize } from '@/lib/db/schema'
import type { Actor, Db, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { DIVISIONS, assortmentKey, planAssortmentUpload, sameSizes, validateAssortment, type AssortmentInput, type SheetRow, type UploadLine } from './assortments'

export interface Assortment {
  id: number
  division: string
  segment: string
  packing: number
  code: string
  sizes: AssortmentSize[]
  version: number
  note: string
  /** Article codes this assortment is only for ('' = any article). */
  onlyFor: string
  source: 'manual' | 'upload'
  createdAt: Date
}

const COLUMNS = {
  id: cartonAssortments.id, division: cartonAssortments.division, segment: cartonAssortments.segment,
  packing: cartonAssortments.packing, code: cartonAssortments.code, sizes: cartonAssortments.sizes,
  version: cartonAssortments.version, note: cartonAssortments.note, onlyFor: cartonAssortments.onlyFor, source: cartonAssortments.source,
  createdAt: cartonAssortments.createdAt,
}

/** Active assortments in a stable order (division, segment, pairs, code). One query. */
export function listActiveAssortments(db: DbOrTx): Promise<Assortment[]> {
  return db.select(COLUMNS).from(cartonAssortments).where(eq(cartonAssortments.active, true))
    .orderBy(asc(cartonAssortments.division), asc(cartonAssortments.segment), asc(cartonAssortments.packing), asc(cartonAssortments.code))
}

/** The fixed division list plus any division already holding assortments. */
export function divisionsFrom(active: { division: string }[]): string[] {
  return [...new Set([...DIVISIONS, ...active.map(a => a.division)])]
}

const LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('carton_assortments'))`

function friendly(e: unknown): never {
  const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code
  if (code === '23505') throw new Error('An active assortment with this division, segment, pairs per carton, code and "only for" articles already exists. Edit that one instead.')
  throw e
}

/**
 * Add a new assortment, or (with `id`) save a new version of an active one.
 * The key (division, segment, pairs, code) of an existing assortment cannot change: retire it and add a new one.
 * New: 1 transaction, ~4 statements. Edit: ~6 statements.
 */
export async function saveAssortment(db: Db, actor: Actor, input: AssortmentInput & { id?: number }, allowNewDivision = false): Promise<{ id: number; changed: boolean }> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(LOCK)
      const active = await listActiveAssortments(tx)
      const divisions = allowNewDivision && input.division.trim() ? [...divisionsFrom(active), input.division.trim()] : divisionsFrom(active)
      const v = validateAssortment(input, divisions)
      if (v.errors.length) throw new Error(v.errors.join(' '))
      const value = v.value
      if (input.id) {
        const cur = active.find(a => a.id === input.id)
        if (!cur) throw new Error('This assortment was changed or removed by someone else. Reload and try again.')
        if (assortmentKey({ ...cur, onlyFor: '' }) !== assortmentKey({ ...value, onlyFor: '' })) throw new Error('Division, segment, pairs per carton and code cannot be changed. Remove this assortment and add a new one.')
        if (sameSizes(cur.sizes, value.sizes) && cur.note === (value.note ?? '') && cur.onlyFor === (value.onlyFor ?? '')) return { id: cur.id, changed: false }
        const [next] = await replace(tx, actor, [{ current: cur, value, source: 'manual', sourceFile: null }])
        return { id: next, changed: true }
      }
      const [row] = await tx.insert(cartonAssortments).values({
        ...value, note: value.note ?? '', source: 'manual', createdBy: actor.id,
        version: sql`(SELECT coalesce(max(version), 0) + 1 FROM carton_assortments WHERE division = ${value.division} AND segment = ${value.segment} AND packing = ${value.packing} AND code = ${value.code} AND "onlyFor" = ${value.onlyFor ?? ''})`,
      }).returning({ id: cartonAssortments.id })
      await audit(tx, { actor, action: 'assortment.created', entityType: 'carton_assortment', entityId: row.id, after: value })
      return { id: row.id, changed: true }
    })
  } catch (e) { friendly(e) }
}

/** Retire the current rows and insert their next versions (set-based). Returns the new ids in order. */
async function replace(tx: DbOrTx, actor: Actor, items: { current: { id: number; version: number; sizes: AssortmentSize[]; note: string }; value: AssortmentInput; source: 'manual' | 'upload'; sourceFile: string | null }[]): Promise<number[]> {
  if (!items.length) return []
  const ids = items.map(i => i.current.id)
  await tx.update(cartonAssortments).set({ active: false, retiredAt: sql`now()`, retiredBy: actor.id, retiredReason: 'Replaced by a new version' })
    .where(and(inArray(cartonAssortments.id, ids), eq(cartonAssortments.active, true)))
  const inserted = await tx.insert(cartonAssortments).values(items.map(i => ({
    ...i.value, note: i.value.note ?? '', version: i.current.version + 1, source: i.source, sourceFile: i.sourceFile, createdBy: actor.id,
  }))).returning({ id: cartonAssortments.id })
  const pairs = items.map((i, n) => ({ old: i.current.id, new: inserted[n].id }))
  await tx.execute(sql`UPDATE carton_assortments c SET "replacedById" = p.new
    FROM json_to_recordset(${JSON.stringify(pairs)}::json) AS p(old int, new int) WHERE c.id = p.old`)
  for (const [n, i] of items.entries()) {
    await audit(tx, { actor, action: 'assortment.new_version', entityType: 'carton_assortment', entityId: inserted[n].id,
      before: { id: i.current.id, version: i.current.version, sizes: i.current.sizes, note: i.current.note },
      after: { version: i.current.version + 1, sizes: i.value.sizes, note: i.value.note ?? '' } })
  }
  return inserted.map(r => r.id)
}

/**
 * "Use this assortment for this article too": add an article code to an "only for" assortment
 * (owner, 20 Nov 2026). Sizes do not change, so no new version; audited. Inside the caller's transaction.
 */
export async function addArticleToAssortment(tx: DbOrTx, actor: Actor, id: number, articleCode: string): Promise<void> {
  const code = articleCode.trim().toUpperCase()
  const [row] = await tx.select({ onlyFor: cartonAssortments.onlyFor }).from(cartonAssortments).where(and(eq(cartonAssortments.id, id), eq(cartonAssortments.active, true))).for('update')
  if (!row) throw new Error('That assortment is no longer active. Reload and try again.')
  if (!row.onlyFor || row.onlyFor.split(',').includes(code)) return
  const next = [...new Set([...row.onlyFor.split(','), code])].sort().join(',')
  await tx.update(cartonAssortments).set({ onlyFor: next }).where(eq(cartonAssortments.id, id))
  await audit(tx, { actor, action: 'assortment.article_added', entityType: 'carton_assortment', entityId: id, before: { onlyFor: row.onlyFor }, after: { onlyFor: next } })
}

/** Remove an assortment from use (kept as history). 1 transaction, 2 statements. */
export async function retireAssortment(db: Db, actor: Actor, id: number, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(cartonAssortments)
      .set({ active: false, retiredAt: sql`now()`, retiredBy: actor.id, retiredReason: reason.trim() || 'Removed' })
      .where(and(eq(cartonAssortments.id, id), eq(cartonAssortments.active, true)))
      .returning(COLUMNS)
    if (!row) throw new Error('This assortment was already removed.')
    await audit(tx, { actor, action: 'assortment.retired', entityType: 'carton_assortment', entityId: id, before: row, reason })
  })
}

/** Compare sheet rows with the database. Read-only, one query. */
export async function previewUpload(db: DbOrTx, rows: SheetRow[]): Promise<UploadLine[]> {
  const active = await listActiveAssortments(db)
  return planAssortmentUpload(rows, active, divisionsFrom(active))
}

export interface UploadResult { created: number; updated: number; unchanged: number }

/**
 * Apply an uploaded sheet: new keys are inserted, changed ones get a new version, identical ones
 * are left alone. Assortments not in the sheet are untouched. Refuses the whole sheet when any
 * row has an error. The plan is recomputed inside the transaction under a lock.
 * One transaction: lock, 1 read, ≤4 set-based writes, 1 summary audit + 1 audit per changed row.
 */
export async function applyUpload(db: Db, actor: Actor, rows: SheetRow[], sourceFile: string): Promise<UploadResult> {
  return db.transaction(async (tx) => {
    await tx.execute(LOCK)
    const lines = await previewUpload(tx, rows)
    const bad = lines.filter(l => l.status === 'error')
    if (bad.length) throw new Error(`${bad.length} row(s) have errors (first: row ${bad[0].row} — ${bad[0].errors[0]}). Nothing was saved.`)
    const created = lines.filter(l => l.status === 'new')
    const changed = lines.filter(l => l.status === 'changed')
    if (created.length) {
      const ins = await tx.insert(cartonAssortments).values(created.map(l => ({
        ...l.value, note: l.value.note ?? '', source: 'upload' as const, sourceFile, createdBy: actor.id,
        version: sql`(SELECT coalesce(max(version), 0) + 1 FROM carton_assortments WHERE division = ${l.value.division} AND segment = ${l.value.segment} AND packing = ${l.value.packing} AND code = ${l.value.code} AND "onlyFor" = ${l.value.onlyFor ?? ''})`,
      }))).returning({ id: cartonAssortments.id })
      await audit(tx, { actor, action: 'assortment.created', entityType: 'carton_assortment', entityId: ins.map(r => r.id).join(','), after: created.map(l => l.value), metadata: { sourceFile } })
    }
    await replace(tx, actor, changed.map(l => ({ current: l.current!, value: l.value, source: 'upload', sourceFile })))
    const result = { created: created.length, updated: changed.length, unchanged: lines.filter(l => l.status === 'same').length }
    await audit(tx, { actor, action: 'assortment.upload', entityType: 'carton_assortment', entityId: sourceFile, after: result, metadata: { rows: lines.length } })
    return result
  }).catch(friendly)
}
