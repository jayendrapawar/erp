/**
 * Stocktake scan service: every physical box is its own scan event.
 *
 * Rules (docs/architecture/inventory-foundation.md):
 *  - A device generates `clientEventId` once per scan. Re-sending it (offline retry,
 *    lost response) returns the original result and never adds stock twice.
 *  - A label whose format carries a unique id can have only one ACTIVE stocktake scan.
 *    A second attempt is refused, names the original scanner and is written to the audit log.
 *  - Carton labels are refused here; they belong to the separate carton module.
 *  - A scan whose article/colour/size is not in the master is still saved, as a
 *    "missing article" scan with no stock movement. Linking the article later posts it.
 *  - Resolved QR scans post +1 'scanned' stock. Manual entries post 'unscanned' stock.
 *  - Undo = void + reversing ledger movement. Nothing is deleted.
 *  - A box scanned while its size has CARTON stock (cartons received against a purchase bill)
 *    comes out of that carton stock: −1 carton, +1 scanned, so it is not counted twice.
 */

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { articleMrps, articles, scanEvents, stockMovements, type ScanEvent, type ScanResolution } from '@/lib/db/schema'
import type { Actor, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { normalizeArticleValue } from '@/lib/article-utils'
import { flattenFields, parseQr, type QrParseResult } from '@/lib/qr/parser'
import { mainLocationId, postMovement, reverseMovement } from './ledger'

const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`

// ── SKU resolution ─────────────────────────────────────────────────────────

export interface Resolution {
  resolution: ScanResolution
  articleId: number | null
  skuId: number | null
}

export async function resolveSku(db: DbOrTx, articleCode: string, colourCode: string, sizeLabel: string): Promise<Resolution> {
  const code = normalizeArticleValue(articleCode)
  const colour = normalizeArticleValue(colourCode)
  if (!code || !colour) return { resolution: 'missing_article', articleId: null, skuId: null }
  const r = await db.execute<{ articleId: number; skuId: number | null }>(sql`
    SELECT a.id AS "articleId", s.id AS "skuId"
    FROM articles a
    LEFT JOIN article_sizes s ON s."articleId" = a.id AND s."sizeLabel" = ${sizeLabel} AND s.active
    WHERE ${NORM(sql`a."artCode"`)} = ${code} AND ${NORM(sql`a."colorCode"`)} = ${colour} AND a.active
    LIMIT 1`)
  const row = r.rows[0]
  if (!row) return { resolution: 'missing_article', articleId: null, skuId: null }
  if (row.skuId == null) return { resolution: 'missing_size', articleId: Number(row.articleId), skuId: null }
  return { resolution: 'resolved', articleId: Number(row.articleId), skuId: Number(row.skuId) }
}

// ── Recording ──────────────────────────────────────────────────────────────

export interface BoxScanInput {
  clientEventId: string
  rawInput: string
  source?: 'app' | 'offline_sync' | 'legacy_import'
  flag?: string | null
  notes?: string | null
  deviceAt?: Date | null
  locationId?: number | null
  legacyScanId?: number | null
  /** Legacy import only: keep the original scan time. */
  createdAt?: Date | null
}

export type BoxScanOutcome =
  | { status: 'saved'; event: ScanEvent; replay: boolean }
  | { status: 'duplicate'; original: { id: number; userName: string; createdAt: Date } }
  | { status: 'rejected'; reason: 'carton' | 'unrecognised' | 'invalid'; message: string; parse: QrParseResult }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function recordBoxScan(db: DbOrTx, actor: Actor, input: BoxScanInput): Promise<BoxScanOutcome> {
  if (!UUID.test(input.clientEventId)) throw new Error('clientEventId must be a UUID.')
  const parse = parseQr(input.rawInput)

  if (parse.kind === 'carton') {
    await audit(db, { actor, action: 'scan.rejected', entityType: 'scan_input', entityId: input.clientEventId, after: { raw: input.rawInput, formatId: parse.formatId }, reason: 'carton label in box scanner' })
    return { status: 'rejected', reason: 'carton', message: 'This is an outer-carton label. Scan the individual footwear boxes, or use Carton Checking.', parse }
  }
  if (parse.status === 'unrecognised' || parse.status === 'invalid') {
    await audit(db, { actor, action: 'scan.rejected', entityType: 'scan_input', entityId: input.clientEventId, after: { raw: input.rawInput, issues: parse.issues }, reason: parse.status })
    const first = parse.issues.find((i) => i.severity === 'error')
    return { status: 'rejected', reason: parse.status, message: first?.message ?? 'QR code not recognised.', parse }
  }

  return db.transaction(async (tx) => {
    const replay = await findByClientEvent(tx, input.clientEventId)
    if (replay) return { status: 'saved', event: replay, replay: true } as const

    const art = parse.fields.articleCode?.value ?? ''
    const colour = parse.fields.colourCode?.value ?? ''
    const size = parse.fields.size?.value ?? ''
    const res = await resolveSku(tx, art, colour, size)
    const locationId = input.locationId ?? await mainLocationId(tx)

    const inserted = await tx.insert(scanEvents).values({
      clientEventId: input.clientEventId,
      entryType: 'scan',
      source: input.source ?? 'app',
      rawInput: input.rawInput,
      payload: parse.payload,
      dedupeKey: parse.dedupeKey,
      formatId: parse.formatId,
      parserVersion: parse.parserVersion,
      parseStatus: parse.status === 'parsed' ? 'parsed' : 'partial',
      parsed: { fields: flattenFields(parse.fields), unknown: parse.unknown, issues: parse.issues, wrapper: parse.wrapper, codePrefix: parse.codePrefix },
      articleCode: normalizeArticleValue(art) || null,
      colourCode: normalizeArticleValue(colour) || null,
      sizeLabel: size || null,
      mrp: parse.fields.mrp ? parse.fields.mrp.value.toFixed(2) : null,
      mfgMonth: parse.fields.mfgMonth?.value ?? null,
      mfgYear: parse.fields.mfgYear?.value ?? null,
      quantity: 1,
      resolution: res.resolution,
      articleId: res.articleId,
      skuId: res.skuId,
      locationId,
      flag: input.flag || null,
      notes: input.notes || null,
      userId: actor.id,
      userName: actor.name,
      deviceAt: input.deviceAt ?? null,
      legacyScanId: input.legacyScanId ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    }).onConflictDoNothing().returning()

    if (!inserted.length) {
      const again = await findByClientEvent(tx, input.clientEventId)
      if (again) return { status: 'saved', event: again, replay: true } as const
      const [orig] = parse.dedupeKey
        ? await tx.select({ id: scanEvents.id, userName: scanEvents.userName, createdAt: scanEvents.createdAt }).from(scanEvents)
          .where(and(eq(scanEvents.dedupeKey, parse.dedupeKey), eq(scanEvents.status, 'active'))).limit(1)
        : []
      if (!orig) throw new Error('Scan could not be saved and no conflicting scan was found.')
      await audit(tx, { actor, action: 'scan.duplicate_attempt', entityType: 'scan_event', entityId: orig.id, after: { raw: input.rawInput, clientEventId: input.clientEventId }, metadata: { originalBy: orig.userName } })
      return { status: 'duplicate', original: orig } as const
    }

    const event = inserted[0]
    if (event.resolution === 'resolved') await postScanMovement(tx, event, actor.id)
    if (parse.fields.mrp && art) await rememberMrp(tx, art, parse.fields.mrp.value, parse.fields.mfgYear?.value, parse.fields.mfgMonth?.value)
    return { status: 'saved', event, replay: false } as const
  })
}

export interface ManualEntryInput {
  clientEventId: string
  articleCode: string
  colourCode: string
  sizeLabel: string
  quantity: number
  mrp?: number | null
  mfgMonth?: number | null
  mfgYear?: number | null
  notes?: string | null
  flag?: string | null
  source?: 'app' | 'offline_sync' | 'legacy_import'
  locationId?: number | null
  legacyScanId?: number | null
  createdAt?: Date | null
}

/** Manual count (damaged or unreadable label). Posts as UNSCANNED stock: not QR-verified. */
export async function recordManualEntry(db: DbOrTx, actor: Actor, input: ManualEntryInput): Promise<{ event: ScanEvent; replay: boolean }> {
  if (!UUID.test(input.clientEventId)) throw new Error('clientEventId must be a UUID.')
  const qty = Number(input.quantity)
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw new Error('Quantity must be a whole number from 1 to 10000.')
  const code = normalizeArticleValue(input.articleCode)
  const colour = normalizeArticleValue(input.colourCode)
  const size = String(Number.parseInt(input.sizeLabel, 10) || input.sizeLabel.trim().toUpperCase())
  if (!code) throw new Error('Article code is required.')

  return db.transaction(async (tx) => {
    const replay = await findByClientEvent(tx, input.clientEventId)
    if (replay) return { event: replay, replay: true }
    const res = await resolveSku(tx, code, colour, size)
    const [event] = await tx.insert(scanEvents).values({
      clientEventId: input.clientEventId,
      entryType: 'manual',
      source: input.source ?? 'app',
      parseStatus: 'manual',
      articleCode: code,
      colourCode: colour || null,
      sizeLabel: size || null,
      mrp: input.mrp != null && input.mrp > 0 ? input.mrp.toFixed(2) : null,
      mfgMonth: input.mfgMonth && input.mfgMonth >= 1 && input.mfgMonth <= 12 ? input.mfgMonth : null,
      mfgYear: input.mfgYear || null,
      quantity: qty,
      resolution: res.resolution,
      articleId: res.articleId,
      skuId: res.skuId,
      locationId: input.locationId ?? await mainLocationId(tx),
      flag: input.flag || null,
      notes: input.notes || null,
      userId: actor.id,
      userName: actor.name,
      legacyScanId: input.legacyScanId ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    }).onConflictDoNothing().returning()
    if (!event) {
      const again = await findByClientEvent(tx, input.clientEventId)
      if (!again) throw new Error('Manual entry could not be saved.')
      return { event: again, replay: true }
    }
    if (event.resolution === 'resolved') await postScanMovement(tx, event, actor.id)
    return { event, replay: false }
  })
}

async function findByClientEvent(db: DbOrTx, clientEventId: string): Promise<ScanEvent | undefined> {
  const [row] = await db.select().from(scanEvents).where(eq(scanEvents.clientEventId, clientEventId)).limit(1)
  return row
}

function postKey(eventId: number) { return `scan_event:${eventId}:post` }

function fromCartonKey(eventId: number) { return `scan_event:${eventId}:from_carton` }

async function postScanMovement(db: DbOrTx, event: ScanEvent, userId: string | null) {
  if (!event.skuId) return
  const legacy = event.source === 'legacy_import'
  if (event.entryType === 'scan' && !legacy) {
    // Same per-SKU lock as corrections, billing and carton receiving.
    await db.execute(sql`SELECT pg_advisory_xact_lock(7301, ${event.skuId})`)
    const carton = await db.execute<{ q: number }>(sql`
      SELECT quantity AS q FROM stock_balances WHERE "skuId" = ${event.skuId} AND "locationId" = ${event.locationId} AND provenance = 'carton'`)
    if (Number(carton.rows[0]?.q ?? 0) >= event.quantity) {
      await postMovement(db, {
        skuId: event.skuId, locationId: event.locationId, provenance: 'carton', quantity: -event.quantity,
        movementType: 'provenance_transfer', sourceType: 'scan_event', sourceId: event.id,
        idempotencyKey: fromCartonKey(event.id), userId, reason: 'box scanned from a received carton',
      })
    }
  }
  await postMovement(db, {
    skuId: event.skuId,
    locationId: event.locationId,
    provenance: event.entryType === 'scan' ? 'scanned' : 'unscanned',
    quantity: event.quantity,
    movementType: legacy ? 'legacy_import' : event.entryType === 'scan' ? 'stocktake_scan' : 'stocktake_manual',
    sourceType: 'scan_event',
    sourceId: event.id,
    idempotencyKey: postKey(event.id),
    userId,
  })
}

/** Remember an MRP seen on a box, with when and the newest manufacture month (latest MRP in the shop). */
async function rememberMrp(db: DbOrTx, articleCode: string, mrp: number, mfgYear?: number, mfgMonth?: number) {
  const code = normalizeArticleValue(articleCode)
  const [known] = await db.select({ id: articles.id }).from(articles).where(sql`${NORM(articles.artCode)} = ${code}`).limit(1)
  if (!known) return
  const ym = mfgYear && mfgYear >= 2000 && mfgYear <= 2100 && mfgMonth && mfgMonth >= 1 && mfgMonth <= 12 ? mfgYear * 100 + mfgMonth : null
  await db.insert(articleMrps).values({ artCode: code, mrp: mrp.toFixed(2), mfgYm: ym, lastSeenAt: sql`now()` })
    .onConflictDoUpdate({
      target: [articleMrps.artCode, articleMrps.mrp],
      set: { lastSeenAt: sql`now()`, mfgYm: sql`greatest(${articleMrps.mfgYm}, excluded."mfgYm")` },
    })
}

// ── Resolving missing-article scans after the master is fixed ──────────────

/** Re-resolve active unresolved scans for one article code + colour and post their stock. */
export async function resolvePendingScans(db: DbOrTx, actor: Actor, articleCode: string, colourCode: string): Promise<{ resolved: number; stillMissing: number }> {
  const code = normalizeArticleValue(articleCode)
  const colour = normalizeArticleValue(colourCode)
  return db.transaction(async (tx) => {
    const pending = await tx.select().from(scanEvents).where(and(
      eq(scanEvents.articleCode, code), eq(scanEvents.colourCode, colour),
      eq(scanEvents.status, 'active'), ne(scanEvents.resolution, 'resolved'),
    )).for('update')
    let resolved = 0
    for (const ev of pending) {
      const res = await resolveSku(tx, code, colour, ev.sizeLabel ?? '')
      if (res.resolution === ev.resolution && res.skuId === ev.skuId) continue
      const [updated] = await tx.update(scanEvents).set({ resolution: res.resolution, articleId: res.articleId, skuId: res.skuId })
        .where(eq(scanEvents.id, ev.id)).returning()
      if (updated.resolution === 'resolved') {
        await postScanMovement(tx, updated, actor.id)
        resolved++
      }
    }
    if (resolved) await audit(tx, { actor, action: 'scan.resolved_after_link', entityType: 'article_code', entityId: `${code}|${colour}`, after: { resolved } })
    const stillMissing = pending.length - resolved
    return { resolved, stillMissing }
  })
}

// ── Void (undo) ────────────────────────────────────────────────────────────

export const OWN_VOID_WINDOW_HOURS = 24

export type VoidOutcome =
  | { ok: true; alreadyVoided: boolean; reversed: boolean; articleDeactivated?: { articleId: number; artCode: string; colorCode: string } }
  | { ok: false; error: 'NOT_FOUND' | 'FORBIDDEN' | 'WINDOW_EXPIRED' | 'ARTICLE_IN_USE' | 'NOT_CREATED_BY_SCAN'; message: string }

export async function voidScanEvent(
  db: DbOrTx,
  actor: Actor,
  opts: { eventId: number; reason: string; canVoidAny: boolean; removeCreatedArticle?: boolean; canRemoveArticle?: boolean },
): Promise<VoidOutcome> {
  const reason = opts.reason.trim()
  if (!reason) throw new Error('A reason is required to undo a scan.')
  return db.transaction(async (tx) => {
    const [ev] = await tx.select().from(scanEvents).where(eq(scanEvents.id, opts.eventId)).for('update')
    if (!ev) return { ok: false, error: 'NOT_FOUND', message: 'Scan not found.' } as const
    if (!opts.canVoidAny) {
      if (ev.userId !== actor.id) return { ok: false, error: 'FORBIDDEN', message: 'You can only undo your own scans.' } as const
      if (Date.now() - ev.createdAt.getTime() > OWN_VOID_WINDOW_HOURS * 3600_000) {
        return { ok: false, error: 'WINDOW_EXPIRED', message: `Scans older than ${OWN_VOID_WINDOW_HOURS} hours need a supervisor to undo.` } as const
      }
    }
    if (ev.status === 'voided') return { ok: true, alreadyVoided: true, reversed: false } as const

    await tx.update(scanEvents).set({ status: 'voided', voidedAt: new Date(), voidedBy: actor.id, voidReason: reason }).where(eq(scanEvents.id, ev.id))
    const [posted] = await tx.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.idempotencyKey, postKey(ev.id))).limit(1)
    let reversed = false
    if (posted) {
      await reverseMovement(tx, posted.id, { idempotencyKey: `scan_event:${ev.id}:void`, userId: actor.id, reason })
      reversed = true
    }
    // The box goes back to carton stock if it had come out of it.
    const [fromCarton] = await tx.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.idempotencyKey, fromCartonKey(ev.id))).limit(1)
    if (fromCarton) await reverseMovement(tx, fromCarton.id, { idempotencyKey: `scan_event:${ev.id}:void_from_carton`, userId: actor.id, reason })
    await audit(tx, { actor, action: 'scan.voided', entityType: 'scan_event', entityId: ev.id, before: { status: 'active' }, after: { status: 'voided', reversed }, reason })

    let articleDeactivated: { articleId: number; artCode: string; colorCode: string } | undefined
    if (opts.removeCreatedArticle) {
      if (!opts.canRemoveArticle) throw new ArticleRemovalError('FORBIDDEN', 'Only an admin can remove an article created from a scan.')
      articleDeactivated = await deactivateArticleCreatedByScan(tx, actor, ev, reason)
    }
    return { ok: true, alreadyVoided: false, reversed, articleDeactivated } as const
  }).catch((e) => {
    if (e instanceof ArticleRemovalError) return { ok: false, error: e.code, message: e.message } as const
    throw e
  })
}

class ArticleRemovalError extends Error {
  constructor(public code: 'ARTICLE_IN_USE' | 'NOT_CREATED_BY_SCAN' | 'FORBIDDEN', message: string) { super(message) }
}

/**
 * Feature 01 exception: an admin who created an article through the new-article dialog
 * may remove it together with the scan that created it — only when nothing else uses it.
 * The scan's ledger lines (post + reversal) must stay, so "remove" means deactivate.
 * Throws (rolling back the void) if the conditions are not met.
 */
async function deactivateArticleCreatedByScan(db: DbOrTx, actor: Actor, ev: ScanEvent, reason: string) {
  const link = await db.execute<{ articleId: number }>(sql`
    SELECT "articleId" FROM article_scan_links WHERE "scanEventId" = ${ev.id} AND action = 'created' LIMIT 1`)
  const articleId = link.rows[0]?.articleId
  if (!articleId) throw new ArticleRemovalError('NOT_CREATED_BY_SCAN', 'This scan did not create an article, so only the scan was undone.')
  const [art] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1)
  if (!art) throw new ArticleRemovalError('NOT_CREATED_BY_SCAN', 'The created article no longer exists.')

  const otherScans = await db.select({ id: scanEvents.id }).from(scanEvents)
    .where(and(eq(scanEvents.articleId, articleId), ne(scanEvents.id, ev.id))).limit(1)
  const otherMovements = await db.execute(sql`
    SELECT 1 FROM stock_movements m JOIN article_sizes s ON s.id = m."skuId"
    WHERE s."articleId" = ${articleId} AND NOT (m."sourceType" = 'scan_event' AND m."sourceId" = ${String(ev.id)}) LIMIT 1`)
  const orderUse = await db.execute(sql`
    SELECT 1 FROM order_items WHERE upper(btrim("artNumber")) = upper(btrim(${art.artName})) AND upper(coalesce("colorNumber", '')) IN (upper(${art.color}), upper(${art.colorCode})) LIMIT 1`)
  if (otherScans.length || otherMovements.rows.length || orderUse.rows.length) {
    throw new ArticleRemovalError('ARTICLE_IN_USE', 'Other scans, stock or orders use this article. Undo the scan only, or correct the article in Master.')
  }
  await db.update(articles).set({ active: false }).where(eq(articles.id, articleId))
  await audit(db, { actor, action: 'article.deactivated', entityType: 'article', entityId: articleId, before: art, after: { active: false }, reason: `Removed with the scan that created it: ${reason}` })
  return { articleId, artCode: art.artCode, colorCode: art.colorCode }
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function recentScansForUser(db: DbOrTx, userId: string, limit: number) {
  return db.select({
    event: scanEvents,
    artName: articles.artName,
    colorName: articles.color,
    division: articles.division,
  }).from(scanEvents)
    .leftJoin(articles, eq(articles.id, scanEvents.articleId))
    .where(and(eq(scanEvents.userId, userId), eq(scanEvents.status, 'active')))
    .orderBy(desc(scanEvents.id))
    .limit(Math.min(Math.max(limit, 1), 200))
}

export async function scanEventsByIds(db: DbOrTx, ids: number[]) {
  if (!ids.length) return []
  return db.select().from(scanEvents).where(inArray(scanEvents.id, ids))
}
