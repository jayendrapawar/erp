/**
 * Stocktake cartons (owner, 26 Nov 2026; migration 0021). A sealed outer carton already on the
 * shelf is counted in the Warehouse Scanner instead of opening it and scanning every box.
 *
 *  1. Scan the carton label → `checkStocktakeCarton` (one read, nothing saved): the carton's sizes,
 *     the assortments that fit (division + size code, any pairs per carton), the proposal, and
 *     warnings (expected on an open bill, sizes not in the master, pairs seen on earlier invoices).
 *  2. The worker confirms / chooses an assortment or types the pairs per size →
 *     `countStocktakeCarton` (one transaction): a carton_receipts row with match 'stocktake' and
 *     +pairs per size as provenance 'carton', movement 'stocktake_carton'.
 *
 * Rules
 *  - One active row per carton label (shared with receiving): a label counted at stocktake cannot
 *    be received on a bill, nor counted twice, and the other way round.
 *  - Boxes later scanned from the carton move carton → scanned (scan-service.ts), so the pairs are
 *    never counted twice. Only SEALED cartons may be counted (a box scanned before the carton label
 *    cannot be detected — the screen says so).
 *  - Pairs per carton: when earlier invoices show one value for this article + size range, a typed
 *    carton must add up to it. Typed pairs are saved to Master → Assortments exactly as at receiving.
 *  - Every size must be in the article master; otherwise nothing is counted (scan the boxes instead:
 *    they are kept as missing articles).
 *  - Undo = void + reversing movements (voidCartonReceipt), refused if its pairs were already
 *    scanned or sold out of carton stock.
 */

import { sql } from 'drizzle-orm'
import type { AssortmentSize } from '@/lib/db/schema'
import type { Actor, Db, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { normalizeArticleValue } from '@/lib/article-utils'
import { parseQr } from '@/lib/qr/parser'
import { divisionForArticleCode } from '@/lib/qr-config'
import { expandSizeRange } from '@/lib/catalog/sizes'
import { rankAssortments } from '@/lib/catalog/assortments'
import { addArticleToAssortment } from '@/lib/catalog/assortment-store'
import { articleSegmentSql, coverRankSql, type AssortmentChoice } from '@/lib/purchases/assortment-match'
import { createTypedAssortment, rangeCode, type AssortmentAnswer } from '@/lib/purchases/assortment-entry'
import { voidCartonReceipt } from '@/lib/purchases/store'
import { mainLocationId } from './ledger'
import { sessionStamp } from './stocktake-sessions'

const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`
const J = (v: unknown) => JSON.stringify(v)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const STOCKTAKE_CARTON_UNDO_HOURS = 24

/** A user-facing refusal (shown as is). */
export class CartonCountError extends Error {}

export interface StocktakeOption extends AssortmentChoice { packing: number }

export interface StocktakeCartonAsk {
  status: 'confirm'
  label: string
  articleCode: string; colourCode: string; articleName: string | null
  mrp: number | null
  /** Sizes of the carton's range (11–1 wraps for children). */
  sizes: string[]
  /** Sizes of the range not in the article master (a carton using them cannot be counted). */
  missingSizes: string[]
  division: string
  articleSegment: string | null
  /** Pairs per carton seen on earlier invoices for this article + range (null = none or several). */
  invoicePairs: number | null
  options: StocktakeOption[]
  proposal: StocktakeOption | null
  warnings: string[]
}

export type StocktakeCheck =
  | StocktakeCartonAsk
  | { status: 'duplicate'; label: string; message: string }
  | { status: 'rejected'; message: string }

export type StocktakeCount =
  | { status: 'counted'; receiptId: number; label: string; pairs: number; sizes: AssortmentSize[]; replay: boolean }
  | { status: 'duplicate'; label: string; message: string }
  | { status: 'rejected'; message: string }

interface ReadLabel { art: string; col: string; from: string; to: string; pack: string; mrp: number | null; key: string; label: string; sizes: string[] }

function readLabel(raw: string): { ok: false; message: string } | ({ ok: true } & ReadLabel) {
  const p = parseQr(String(raw ?? '').trim())
  if (p.kind !== 'carton') return { ok: false, message: p.kind === 'box' ? 'This is a box label, not a carton label.' : 'Not a carton label.' }
  if (p.status === 'invalid' || p.status === 'unrecognised') return { ok: false, message: p.issues.find((i) => i.severity === 'error')?.message ?? 'Carton label not readable.' }
  const art = normalizeArticleValue(p.fields.articleCode?.value ?? '')
  const col = normalizeArticleValue(p.fields.colourCode?.value ?? '')
  const from = p.fields.sizeFrom?.value ?? ''
  const to = p.fields.sizeTo?.value ?? ''
  if (!art || !col || !from || !to) return { ok: false, message: 'The carton label is missing the article, colour or size range.' }
  const pack = (p.fields.packCode?.value ?? '').toUpperCase()
  const range = expandSizeRange(from, to)
  return {
    ok: true, art, col, from, to, pack, mrp: p.fields.mrp?.value ?? null,
    key: p.dedupeKey ?? `raw:${p.payload}`,
    label: `${art} ${col} ${from === to ? from : `${from}–${to}`}${pack ? ` ${pack}` : ''}`,
    sizes: range.ok ? range.sizes : from === to ? [from] : [from, to],
  }
}

function heldMessage(h: { match: string; userName: string; createdAt: string; refNo: string | null }): string {
  const at = new Date(h.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  return h.match === 'stocktake'
    ? `Already counted in stocktake by ${h.userName || 'someone'} at ${at}.`
    : `Already received${h.refNo ? ` on bill ${h.refNo}` : ''} by ${h.userName || 'someone'} at ${at} — it is in stock.`
}

type Facts = {
  known: boolean; articleName: string | null; division: string | null; seg: string | null
  held: { match: string; userName: string; createdAt: string; refNo: string | null } | null
  masterSizes: string[] | null; packings: number[] | null
  openBill: { refNo: string; cartons: number; received: number } | null
  options: Array<StocktakeOption & { id: number; version: number }> | null
}

/** Everything the confirm card needs, in one statement. */
async function cartonFacts(db: DbOrTx, l: ReadLabel): Promise<Facts & { divisionUsed: string }> {
  const fallback = divisionForArticleCode(l.art)
  const code = rangeCode(l.from, l.to)
  const r = await db.execute<Facts & { divisionUsed: string }>(sql`
    WITH art AS (
      SELECT EXISTS (SELECT 1 FROM articles a WHERE ${NORM(sql`a."artCode"`)} = ${l.art} AND ${NORM(sql`a."colorCode"`)} = ${l.col} AND a.active) AS known,
             (SELECT a."artName" FROM articles a WHERE ${NORM(sql`a."artCode"`)} = ${l.art} AND a.active ORDER BY (${NORM(sql`a."colorCode"`)} = ${l.col}) DESC, a.id LIMIT 1) AS "articleName",
             (SELECT nullif(btrim(a.division), '') FROM articles a WHERE ${NORM(sql`a."artCode"`)} = ${l.art} AND a.active AND nullif(btrim(a.division), '') IS NOT NULL
               ORDER BY (${NORM(sql`a."colorCode"`)} = ${l.col}) DESC, a.id LIMIT 1) AS division,
             ${articleSegmentSql(sql`${l.art}::text`, sql`${l.col}::text`)} AS seg)
    SELECT art.known, art."articleName", art.division, art.seg, coalesce(art.division, ${fallback}) AS "divisionUsed",
      (SELECT json_build_object('match', c.match, 'userName', c."userName", 'createdAt', c."createdAt", 'refNo', b."refNo")
         FROM carton_receipts c LEFT JOIN purchase_bills b ON b.id = c."billId"
        WHERE c."dedupeKey" = ${l.key} AND c.status = 'active' LIMIT 1) AS held,
      (SELECT json_agg(s."sizeLabel") FROM articles a JOIN article_sizes s ON s."articleId" = a.id AND s.active
        WHERE ${NORM(sql`a."artCode"`)} = ${l.art} AND ${NORM(sql`a."colorCode"`)} = ${l.col} AND a.active) AS "masterSizes",
      (SELECT json_agg(DISTINCT pl."pairsPerCarton") FROM purchase_bill_lines pl JOIN purchase_bills pb ON pb.id = pl."billId"
        WHERE pb.status <> 'cancelled' AND pl."articleCode" = ${l.art} AND pl."sizeFrom" = ${l.from} AND pl."sizeTo" = ${l.to}) AS packings,
      (SELECT json_build_object('refNo', pb."refNo", 'cartons', pl.cartons,
              'received', (SELECT count(*) FROM carton_receipts x WHERE x."billLineId" = pl.id AND x.status = 'active'))
         FROM purchase_bill_lines pl JOIN purchase_bills pb ON pb.id = pl."billId"
        WHERE pb.status IN ('expected', 'partial') AND pl."articleCode" = ${l.art} AND pl."colourCode" = ${l.col}
          AND pl."sizeFrom" = ${l.from} AND pl."sizeTo" = ${l.to}
          AND pl.cartons > (SELECT count(*) FROM carton_receipts x WHERE x."billLineId" = pl.id AND x.status = 'active')
        ORDER BY pb."expectedOn", pb.id LIMIT 1) AS "openBill",
      (SELECT json_agg(json_build_object('id', a.id, 'segment', a.segment, 'version', a.version, 'sizes', a.sizes, 'onlyFor', a."onlyFor", 'packing', a.packing,
                                         'covers', ${coverRankSql(sql`${l.art}::text`, sql`a."onlyFor"`)} >= 0) ORDER BY a.packing, a.segment, a."onlyFor", a.id)
         FROM carton_assortments a WHERE a.active AND a.division = coalesce(art.division, ${fallback}) AND a.code = ${code}) AS options
    FROM art`)
  return r.rows[0]
}

/** Step 1: read the label and what fits. Reads only (one statement). */
export async function checkStocktakeCarton(db: DbOrTx, raw: string): Promise<StocktakeCheck> {
  const l = readLabel(raw)
  if (!l.ok) return { status: 'rejected', message: l.message }
  const f = await cartonFacts(db, l)
  if (f.held) return { status: 'duplicate', label: l.label, message: heldMessage(f.held) }
  if (!f.known) {
    return { status: 'rejected', message: `${l.art} ${l.col} is not in the article master, so this carton cannot be counted. Ask an admin to add it, or open the carton and scan its boxes.` }
  }
  const warnings: string[] = []
  if (f.openBill) {
    warnings.push(`A carton like this is expected on open bill ${f.openBill.refNo} (${f.openBill.received} of ${f.openBill.cartons} received). If it came with that bill, receive it in Purchases → Receive instead.`)
  }
  if (l.pack && l.pack !== 'A') warnings.push(`Pack letter "${l.pack}" (not A) — possibly factory seconds; check the carton.`)
  if (!f.division) warnings.push(`${l.art} has no division in the article master; showing ${f.divisionUsed} assortments.`)
  const master = new Set((f.masterSizes ?? []).map(String))
  const missingSizes = l.sizes.filter((s) => !master.has(s))
  if (missingSizes.length) warnings.push(`Size ${missingSizes.join(', ')} of ${l.art} ${l.col} is not in the article master.`)
  const packings = [...new Set((f.packings ?? []).map(Number))]
  const invoicePairs = packings.length === 1 ? packings[0] : null
  if (packings.length > 1) warnings.push(`Earlier invoices show ${packings.sort((a, b) => a - b).join(' or ')} pairs for this carton — check which it is.`)
  const options: StocktakeOption[] = (f.options ?? []).map((o) => ({ ...o, id: Number(o.id), version: Number(o.version), packing: Number(o.packing), onlyFor: o.onlyFor ?? '' }))
  const pickFrom = invoicePairs != null ? options.filter((o) => o.packing === invoicePairs) : options
  const proposal = l.from === l.to ? null : rankAssortments(pickFrom, { code: l.art, segment: f.seg }).pick
  return {
    status: 'confirm', label: l.label, articleCode: l.art, colourCode: l.col, articleName: f.articleName, mrp: l.mrp,
    sizes: l.sizes, missingSizes, division: f.divisionUsed, articleSegment: f.seg ?? null, invoicePairs, options, proposal, warnings,
  }
}

export interface StocktakeCountInput {
  rawInput: string
  clientEventId: string
  flag?: string | null
  /** Stocktake session (rack count); its rack name becomes the flag. */
  sessionId?: number | null
  /** An assortment (one of the options), or typed pairs per size. A single-size carton: typed. */
  answer: AssortmentAnswer
}

/** Step 2: count the carton. One transaction; a retried clientEventId returns the first result. */
export async function countStocktakeCarton(db: Db, actor: Actor, input: StocktakeCountInput): Promise<StocktakeCount> {
  if (!UUID_RE.test(input.clientEventId)) throw new Error('Invalid request.')
  const l = readLabel(input.rawInput)
  if (!l.ok) return { status: 'rejected', message: l.message }
  try {
    return await db.transaction(async (tx) => {
      const replay = await tx.execute<{ id: number; match: string; postedPairs: number }>(sql`
        SELECT id, match, "postedPairs" FROM carton_receipts WHERE "clientEventId" = ${input.clientEventId}::uuid`)
      if (replay.rows[0]) {
        if (replay.rows[0].match !== 'stocktake') throw new CartonCountError('This scan was already used for another carton.')
        const id = Number(replay.rows[0].id)
        return { status: 'counted', receiptId: id, label: l.label, pairs: Number(replay.rows[0].postedPairs ?? 0), sizes: await countedSizes(tx, id), replay: true } as const
      }
      const f = await cartonFacts(tx, l)
      if (f.held) return { status: 'duplicate', label: l.label, message: heldMessage(f.held) } as const
      if (!f.known) throw new CartonCountError(`${l.art} ${l.col} is not in the article master, so this carton cannot be counted.`)
      const packings = [...new Set((f.packings ?? []).map(Number))]
      const invoicePairs = packings.length === 1 ? packings[0] : null

      // What is inside: a fitting assortment, or the typed pairs per size.
      let sizes: AssortmentSize[]
      let assortmentId: number | null = null
      const a = input.answer ?? {}
      if (a.assortmentId) {
        const opt = (f.options ?? []).find((o) => Number(o.id) === a.assortmentId)
        if (!opt) throw new CartonCountError('That assortment does not fit this carton (division and size range must match). Scan the carton again.')
        if (!opt.covers) {
          if (!a.addArticle) throw new CartonCountError(`That assortment is only for other articles. Confirm using it for ${l.art} too, or enter the pairs per size.`)
          await addArticleToAssortment(tx, actor, Number(opt.id), l.art)
        }
        assortmentId = Number(opt.id)
        sizes = opt.sizes.map((s) => ({ size: String(s.size), pairs: Number(s.pairs) }))
      } else if (a.newAssortment) {
        sizes = cleanTyped(a.newAssortment.sizes, l.sizes)
        const total = sizes.reduce((n, s) => n + s.pairs, 0)
        if (invoicePairs != null && total !== invoicePairs) throw new CartonCountError(`The pairs add up to ${total}; earlier invoices show ${invoicePairs} pairs in this carton.`)
        if (l.from !== l.to) {
          // Saved to Master → Assortments as at receiving, so the next carton like it is proposed.
          if (!f.division) throw new CartonCountError(`${l.art} has no division in the article master. Set it in Master → Articles, or choose an assortment above.`)
          assortmentId = await createTypedAssortment(tx, actor, {
            division: f.division, articleCode: l.art, pairsPerCarton: total, sizeFrom: l.from, sizeTo: l.to, note: `Entered at stocktake (carton ${l.label})`,
          }, rangeCode(l.from, l.to), { segment: a.newAssortment.segment, sizes }, 'stocktake')
        }
      } else {
        throw new CartonCountError('Choose the assortment in this carton, or enter the pairs per size.')
      }

      // Every size must be a known SKU of this article + colour.
      const sk = await tx.execute<{ size: string; skuId: number | null }>(sql`
        SELECT k.size, (SELECT s.id FROM articles a JOIN article_sizes s ON s."articleId" = a.id AND s."sizeLabel" = k.size AND s.active
                         WHERE ${NORM(sql`a."artCode"`)} = ${l.art} AND ${NORM(sql`a."colorCode"`)} = ${l.col} AND a.active LIMIT 1) AS "skuId"
          FROM json_array_elements_text(${J(sizes.map((s) => s.size))}::json) AS k(size)`)
      const skuOf = new Map(sk.rows.filter((r) => r.skuId != null).map((r) => [String(r.size), Number(r.skuId)]))
      const missing = sizes.filter((s) => !skuOf.has(s.size)).map((s) => s.size)
      if (missing.length) throw new CartonCountError(`Size ${missing.join(', ')} of ${l.art} ${l.col} is not in the article master, so this carton cannot be counted. Ask an admin to add the size, or scan the boxes.`)

      const pairs = sizes.reduce((n, s) => n + s.pairs, 0)
      const stamp = await sessionStamp(tx, input.sessionId)
      const ins = await tx.execute<{ id: number }>(sql`
        INSERT INTO carton_receipts ("clientEventId", "rawInput", "dedupeKey", "articleCode", "colourCode", "sizeFrom", "sizeTo", "packLetter", mrp, match,
                                     "assortmentId", "postedAt", "postedPairs", flag, "sessionId", "userId", "userName")
        VALUES (${input.clientEventId}::uuid, ${String(input.rawInput).trim()}, ${l.key}, ${l.art}, ${l.col}, ${l.from}, ${l.to}, ${l.pack}, ${l.mrp}, 'stocktake',
                ${assortmentId}, now(), ${pairs}, ${stamp?.flag ?? (input.flag?.trim() || null)}, ${stamp?.sessionId ?? null}, ${actor.id}, ${actor.name})
        ON CONFLICT DO NOTHING RETURNING id`)
      if (!ins.rows[0]) return { status: 'duplicate', label: l.label, message: 'Already counted (scanned twice at the same moment).' } as const
      const receiptId = Number(ins.rows[0].id)

      const moves = sizes.map((s) => ({ sku: skuOf.get(s.size)!, qty: s.pairs }))
      const skus = [...new Set(moves.map((m) => m.sku))].sort((x, y) => x - y)
      // Same per-SKU lock as box scans, billing and carton receiving.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7301, x::int) FROM json_array_elements_text(${J(skus)}::json) x ORDER BY x::int`)
      const loc = await mainLocationId(tx)
      await tx.execute(sql`
        INSERT INTO stock_movements ("skuId", "locationId", provenance, quantity, "movementType", "sourceType", "sourceId", "idempotencyKey", "userId", reason)
        SELECT x.sku, ${loc}, 'carton', x.qty, 'stocktake_carton', 'carton_receipt', ${String(receiptId)}, 'carton_receipt:' || ${receiptId} || ':' || x.sku, ${actor.id}, 'carton counted at stocktake'
        FROM json_to_recordset(${J(moves)}::json) AS x(sku int, qty int)`)
      await audit(tx, { actor, action: 'carton.stocktake_counted', entityType: 'carton_receipt', entityId: receiptId, after: { label: l.label, assortmentId, sizes, pairs, sessionId: stamp?.sessionId ?? null } })
      return { status: 'counted', receiptId, label: l.label, pairs, sizes, replay: false } as const
    })
  } catch (e) {
    if (e instanceof CartonCountError) return { status: 'rejected', message: e.message }
    throw e
  }
}

function cleanTyped(typed: AssortmentSize[], range: string[]): AssortmentSize[] {
  const out: AssortmentSize[] = []
  for (const s of typed ?? []) {
    const size = String(s?.size ?? '').trim()
    const pairs = Number(s?.pairs)
    if (!pairs) continue
    if (!range.includes(size)) throw new CartonCountError(`Only sizes ${range.join(', ')} belong to this carton.`)
    if (!Number.isInteger(pairs) || pairs < 0 || pairs > 500) throw new CartonCountError(`Size ${size}: pairs must be a whole number from 1 to 500.`)
    if (out.some((x) => x.size === size)) throw new CartonCountError(`Size ${size} is entered twice.`)
    out.push({ size, pairs })
  }
  if (!out.length) throw new CartonCountError('Enter the pairs in each size of this carton.')
  return out
}

async function countedSizes(db: DbOrTx, receiptId: number): Promise<AssortmentSize[]> {
  const r = await db.execute<{ size: string; pairs: number }>(sql`
    SELECT s."sizeLabel" AS size, sum(m.quantity)::int AS pairs FROM stock_movements m JOIN article_sizes s ON s.id = m."skuId"
     WHERE m."sourceType" = 'carton_receipt' AND m."sourceId" = ${String(receiptId)} AND m."movementType" = 'stocktake_carton'
     GROUP BY s."sizeLabel", s."sortOrder" ORDER BY s."sortOrder"`)
  return r.rows.map((x) => ({ size: String(x.size), pairs: Number(x.pairs) }))
}

// ── Recent + undo (Warehouse Scanner → Recent) ──────────────────────────────

export interface StocktakeCartonRow {
  id: number; label: string; articleName: string | null; pairs: number; mrp: string | null; flag: string | null
  userName: string; createdAt: Date; sizes: AssortmentSize[]
}

/** The person's last counted cartons (active), newest first. One query. */
export async function recentStocktakeCartons(db: DbOrTx, userId: string, limit = 30): Promise<StocktakeCartonRow[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT c.id, c."articleCode", c."colourCode", c."sizeFrom", c."sizeTo", c."packLetter", c."postedPairs", c.mrp, c.flag, c."userName", c."createdAt",
           (SELECT a."artName" FROM articles a WHERE ${NORM(sql`a."artCode"`)} = c."articleCode" AND a.active ORDER BY a.id LIMIT 1) AS "articleName",
           (SELECT json_agg(json_build_object('size', s."sizeLabel", 'pairs', m.quantity) ORDER BY s."sortOrder")
              FROM stock_movements m JOIN article_sizes s ON s.id = m."skuId"
             WHERE m."sourceType" = 'carton_receipt' AND m."sourceId" = c.id::text AND m."movementType" = 'stocktake_carton') AS sizes
      FROM carton_receipts c
     WHERE c."userId" = ${userId} AND c.match = 'stocktake' AND c.status = 'active'
     ORDER BY c.id DESC
     LIMIT ${Math.min(Math.max(limit, 1), 100)}`)
  return r.rows.map((x) => ({
    id: Number(x.id),
    label: `${x.articleCode} ${x.colourCode} ${x.sizeFrom === x.sizeTo ? x.sizeFrom : `${x.sizeFrom}–${x.sizeTo}`}${x.packLetter ? ` ${x.packLetter}` : ''}`,
    articleName: (x.articleName as string) ?? null, pairs: Number(x.postedPairs ?? 0), mrp: (x.mrp as string) ?? null, flag: (x.flag as string) ?? null,
    userName: String(x.userName ?? ''), createdAt: new Date(x.createdAt as string),
    sizes: ((x.sizes as AssortmentSize[] | null) ?? []).map((s) => ({ size: String(s.size), pairs: Number(s.pairs) })),
  }))
}

/** Undo a counted carton: own within 24 hours, or anyone's with scan.void.any. */
export async function undoStocktakeCarton(db: Db, actor: Actor, opts: { receiptId: number; reason: string; canVoidAny: boolean }): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await db.execute<{ userId: string | null; match: string; status: string; createdAt: string }>(sql`
    SELECT "userId", match, status, "createdAt" FROM carton_receipts WHERE id = ${opts.receiptId}`)
  const c = r.rows[0]
  if (!c || c.match !== 'stocktake') return { ok: false, message: 'Counted carton not found.' }
  if (c.status !== 'active') return { ok: true }
  if (!opts.canVoidAny) {
    if (c.userId !== actor.id) return { ok: false, message: 'You can only undo cartons you counted.' }
    if (Date.now() - new Date(c.createdAt).getTime() > STOCKTAKE_CARTON_UNDO_HOURS * 3600_000) return { ok: false, message: `Cartons counted more than ${STOCKTAKE_CARTON_UNDO_HOURS} hours ago need a supervisor to undo.` }
  }
  try {
    await voidCartonReceipt(db, actor, opts.receiptId, opts.reason)
    return { ok: true }
  } catch (e) {
    // voidCartonReceipt's refusals are written for the screen.
    if (e instanceof Error && !('code' in e)) return { ok: false, message: e.message }
    throw e
  }
}
