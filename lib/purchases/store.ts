// Purchases (server only): expected stock from supplier bills, carton receiving and verification.
// See db/migrations/0007_purchases.sql and docs/architecture/purchases.md.
//
// A received carton adds stock only at the moment it is received (its line has a carton
// assortment and every size is in the article master). Otherwise it is CHECKED against the bill
// only and its stock comes from scanning the boxes inside with the warehouse scanner. It is never
// posted later: its boxes may already have been scanned, which would count the pairs twice.
//
// Every write is one transaction with an audit row. Statements per action do not grow with the
// number of lines or cartons (set-based SQL).

import { and, eq, sql } from 'drizzle-orm'
import { purchaseBillLines, purchaseBills, type AssortmentSize } from '@/lib/db/schema'
import type { Actor, Db, DbOrTx, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { parseQr } from '@/lib/qr/parser'
import { normalizeArticleValue } from '@/lib/article-utils'
import { mainLocationId } from '@/lib/inventory/ledger'
import { addDays, type ParsedBill } from './relaxo-bill'
import { addArticleToAssortment } from '@/lib/catalog/assortment-store'
import { expandSizeRange } from '@/lib/catalog/sizes'
import { coverRankSql, lineChoices, proposeLineAssortments, type AssortmentChoice } from './assortment-match'
import { NeedsAssortment, settleLineAssortment, type AssortmentAnswer } from './assortment-entry'

export const DAYS_TO_ARRIVE = 5
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`
const J = (v: unknown) => JSON.stringify(v)
const TODAY_IST = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`

// ── Bills ────────────────────────────────────────────────────────────────────

export type SaveBillOutcome = { status: 'saved'; id: number; refNo: string; lines: number; assortmentsFound: number } | { status: 'duplicate'; id: number; refNo: string }

/**
 * Save a parsed bill and its lines. Duplicate = same reference or same file. Each line gets the
 * carton assortment the rule proposes (assortment-match.ts); every received carton is still confirmed.
 */
export async function saveBill(db: Db, actor: Actor, bill: ParsedBill, file: { name: string; sha256: string; source?: 'upload' | 'mail' }, division: string): Promise<SaveBillOutcome> {
  return db.transaction(async (tx) => {
    const dup = await tx.execute<{ id: number; refNo: string }>(sql`
      SELECT id, "refNo" FROM purchase_bills WHERE "refNo" = ${bill.refNo} OR "fileSha256" = ${file.sha256} LIMIT 1`)
    if (dup.rows[0]) return { status: 'duplicate', id: Number(dup.rows[0].id), refNo: dup.rows[0].refNo } as const
    const [b] = await tx.insert(purchaseBills).values({
      supplier: bill.supplier, docType: bill.docType, refNo: bill.refNo, invoiceNo: bill.invoiceNo, billDate: bill.billDate,
      soNo: bill.soNo, soDate: bill.soDate, poNo: bill.poNo, customerCode: bill.customerCode, division,
      expectedOn: addDays(bill.billDate, DAYS_TO_ARRIVE), totalCartons: bill.totalCartons, totalPairs: bill.totalPairs,
      grossAmount: bill.grossAmount != null ? String(bill.grossAmount) : null, source: file.source ?? 'upload',
      fileName: file.name.slice(0, 200), fileSha256: file.sha256, uploadedBy: actor.id, uploadedByName: actor.name,
    }).returning({ id: purchaseBills.id })
    await tx.insert(purchaseBillLines).values(bill.lines.map((l) => ({
      billId: b.id, lineNo: l.lineNo, hsn: l.hsn, articleCode: l.articleCode, colourCode: l.colourCode, sizeFrom: l.sizeFrom, sizeTo: l.sizeTo,
      packLetter: l.packLetter, description: l.description, cartons: l.cartons, pairsPerCarton: l.pairsPerCarton, pairs: l.pairs,
      mrp: String(l.mrp), rate: String(l.rate), amount: String(l.amount),
    })))
    const found = await proposeLineAssortments(tx, b.id)
    // HSN for the sale bill (migration 0016): fill it on articles that have none yet. 1 statement.
    await tx.execute(sql`
      UPDATE articles a SET hsn = l.hsn
      FROM (SELECT DISTINCT ON (upper(btrim("articleCode"))) upper(btrim("articleCode")) AS code, btrim(hsn) AS hsn
            FROM purchase_bill_lines WHERE "billId" = ${b.id} AND btrim(coalesce(hsn, '')) ~ '^[0-9]{4,8}$'
            ORDER BY upper(btrim("articleCode")), "lineNo") l
      WHERE upper(btrim(a."artCode")) = l.code AND a.hsn = ''`)
    await audit(tx, { actor, action: 'purchase_bill.saved', entityType: 'purchase_bill', entityId: b.id, after: { refNo: bill.refNo, lines: bill.lines.length, cartons: bill.totalCartons, pairs: bill.totalPairs, division, file: file.name } })
    return { status: 'saved', id: b.id, refNo: bill.refNo, lines: bill.lines.length, assortmentsFound: found } as const
  })
}

export interface BillRow {
  id: number
  refNo: string
  invoiceNo: string
  docType: string
  billDate: string
  expectedOn: string
  division: string
  status: string
  overdue: boolean
  totalCartons: number
  totalPairs: number
  receivedCartons: number
  receivedPairs: number
  pendingStock: number
  grossAmount: number | null
}

/** Bills newest first (open ones, or all). One query. */
export async function listBills(db: DbOrTx, opts: { open?: boolean; limit?: number } = {}): Promise<BillRow[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT b.id, b."refNo", b."invoiceNo", b."docType", b."billDate"::text, b."expectedOn"::text, b.division, b.status,
           b."totalCartons", b."totalPairs", b."grossAmount",
           (b.status IN ('expected', 'partial') AND b."expectedOn" < ${TODAY_IST}) AS overdue,
           coalesce(rc.cartons, 0)::int AS "receivedCartons", coalesce(rc.pairs, 0)::int AS "receivedPairs", coalesce(rc.pending, 0)::int AS "pendingStock"
    FROM purchase_bills b
    LEFT JOIN LATERAL (
      SELECT count(*) AS cartons, sum(l."pairsPerCarton") AS pairs, count(*) FILTER (WHERE c."postedAt" IS NULL) AS pending
      FROM carton_receipts c JOIN purchase_bill_lines l ON l.id = c."billLineId"
      WHERE c."billId" = b.id AND c.status = 'active') rc ON TRUE
    ${opts.open ? sql`WHERE b.status IN ('expected', 'partial')` : sql``}
    ORDER BY b."billDate" DESC, b.id DESC
    LIMIT ${Math.min(opts.limit ?? 200, 500)}`)
  return r.rows.map((x) => ({
    id: Number(x.id), refNo: String(x.refNo), invoiceNo: String(x.invoiceNo ?? ''), docType: String(x.docType), billDate: String(x.billDate),
    expectedOn: String(x.expectedOn), division: String(x.division ?? ''), status: String(x.status), overdue: Boolean(x.overdue),
    totalCartons: Number(x.totalCartons), totalPairs: Number(x.totalPairs), receivedCartons: Number(x.receivedCartons),
    receivedPairs: Number(x.receivedPairs), pendingStock: Number(x.pendingStock), grossAmount: x.grossAmount != null ? Number(x.grossAmount) : null,
  }))
}

export interface PurchaseSummary { openBills: number; overdueBills: number; cartonsExpected: number; pairsExpected: number; unexpectedCartons: number; cartonsCheckedOnly: number }

/** Header figures. One query. */
export async function purchaseSummary(db: DbOrTx): Promise<PurchaseSummary> {
  const r = await db.execute<Record<string, unknown>>(sql`
    WITH open AS (SELECT * FROM purchase_bills WHERE status IN ('expected', 'partial')),
    rem AS (
      SELECT l.cartons - coalesce((SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active'), 0) AS ctn, l."pairsPerCarton" AS ppc
      FROM purchase_bill_lines l JOIN open b ON b.id = l."billId")
    SELECT (SELECT count(*) FROM open)::int AS open,
           (SELECT count(*) FROM open WHERE "expectedOn" < ${TODAY_IST})::int AS overdue,
           (SELECT coalesce(sum(greatest(ctn, 0)), 0) FROM rem)::int AS cartons,
           (SELECT coalesce(sum(greatest(ctn, 0) * ppc), 0) FROM rem)::int AS pairs,
           (SELECT count(*) FROM carton_receipts WHERE status = 'active' AND match = 'unexpected')::int AS unexpected,
           (SELECT count(*) FROM carton_receipts WHERE status = 'active' AND match = 'matched' AND "postedAt" IS NULL)::int AS checked`)
  const x = r.rows[0] ?? {}
  return {
    openBills: Number(x.open ?? 0), overdueBills: Number(x.overdue ?? 0), cartonsExpected: Number(x.cartons ?? 0),
    pairsExpected: Number(x.pairs ?? 0), unexpectedCartons: Number(x.unexpected ?? 0), cartonsCheckedOnly: Number(x.checked ?? 0),
  }
}

/** Article codes / families it is only for ('' = any); covers = it already applies to this line's article. */
export type AssortmentOption = AssortmentChoice

export interface BillLineDetail {
  id: number
  lineNo: number
  articleCode: string
  colourCode: string
  sizeFrom: string
  sizeTo: string
  packLetter: string
  description: string
  cartons: number
  pairsPerCarton: number
  pairs: number
  mrp: number
  receivedCartons: number
  postedCartons: number
  articleName: string | null
  assortment: AssortmentOption | null
  /** Active assortments that fit when none is chosen (division, pairs per carton, size range), any segment. */
  options: AssortmentOption[]
  /** Of the options, the one the rule proposes (null = choose). */
  suggestedId: number | null
  /** Segment of the article in the master. */
  articleSegment: string | null
}

export interface ReceiptRow {
  id: number
  at: string
  articleCode: string
  colourCode: string
  sizeFrom: string
  sizeTo: string
  packLetter: string
  mrp: number | null
  match: 'matched' | 'unexpected'
  billId: number | null
  refNo: string | null
  lineNo: number | null
  posted: boolean
  postedPairs: number | null
  userName: string
}

export interface BillDetail { bill: BillRow & { soNo: string | null; poNo: string | null; fileName: string | null; uploadedByName: string }; lines: BillLineDetail[]; receipts: ReceiptRow[] }

/** One bill with its lines, progress, assortment choices and received cartons. Four queries (last three in parallel). */
export async function billDetail(db: DbOrTx, billId: number): Promise<BillDetail | null> {
  const [row] = (await listBillsById(db, billId))
  if (!row) return null
  const [lines, choices, receipts] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      SELECT l.id, l."lineNo", l."articleCode", l."colourCode", l."sizeFrom", l."sizeTo", l."packLetter", l.description,
             l.cartons, l."pairsPerCarton", l.pairs, l.mrp,
             (SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active')::int AS received,
             (SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active' AND c."postedAt" IS NOT NULL)::int AS posted,
             (SELECT a."artName" FROM articles a WHERE ${NORM(sql`a."artCode"`)} = l."articleCode" AND ${NORM(sql`a."colorCode"`)} = l."colourCode" AND a.active LIMIT 1) AS "articleName",
             (SELECT json_build_object('id', a.id, 'segment', a.segment, 'version', a.version, 'sizes', a.sizes, 'onlyFor', a."onlyFor", 'covers', true) FROM carton_assortments a WHERE a.id = l."assortmentId") AS assortment
      FROM purchase_bill_lines l
      WHERE l."billId" = ${billId} ORDER BY l."lineNo"`),
    // Options and the proposal for every multi-size line (one query).
    lineChoices(db, { billId }),
    listReceipts(db, { billId, limit: 300 }),
  ])
  return {
    bill: row,
    lines: lines.rows.map((x) => {
      const ch = choices.get(Number(x.id))
      const assortment = (x.assortment as AssortmentOption | null) ?? null
      return {
        id: Number(x.id), lineNo: Number(x.lineNo), articleCode: String(x.articleCode), colourCode: String(x.colourCode),
        sizeFrom: String(x.sizeFrom), sizeTo: String(x.sizeTo), packLetter: String(x.packLetter), description: String(x.description ?? ''),
        cartons: Number(x.cartons), pairsPerCarton: Number(x.pairsPerCarton), pairs: Number(x.pairs), mrp: Number(x.mrp),
        receivedCartons: Number(x.received), postedCartons: Number(x.posted), articleName: (x.articleName as string) ?? null,
        assortment, options: assortment ? [] : ch?.options ?? [], suggestedId: assortment ? null : ch?.proposal?.id ?? null,
        articleSegment: ch?.articleSegment ?? null,
      }
    }),
    receipts,
  }
}

async function listBillsById(db: DbOrTx, billId: number) {
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT b.id, b."refNo", b."invoiceNo", b."docType", b."billDate"::text, b."expectedOn"::text, b.division, b.status,
           b."totalCartons", b."totalPairs", b."grossAmount", b."soNo", b."poNo", b."fileName", b."uploadedByName",
           (b.status IN ('expected', 'partial') AND b."expectedOn" < ${TODAY_IST}) AS overdue,
           (SELECT count(*) FROM carton_receipts c WHERE c."billId" = b.id AND c.status = 'active')::int AS "receivedCartons",
           (SELECT coalesce(sum(l."pairsPerCarton"), 0) FROM carton_receipts c JOIN purchase_bill_lines l ON l.id = c."billLineId" WHERE c."billId" = b.id AND c.status = 'active')::int AS "receivedPairs",
           (SELECT count(*) FROM carton_receipts c WHERE c."billId" = b.id AND c.status = 'active' AND c."postedAt" IS NULL)::int AS "pendingStock"
    FROM purchase_bills b WHERE b.id = ${billId}`)
  return r.rows.map((x) => ({
    id: Number(x.id), refNo: String(x.refNo), invoiceNo: String(x.invoiceNo ?? ''), docType: String(x.docType), billDate: String(x.billDate),
    expectedOn: String(x.expectedOn), division: String(x.division ?? ''), status: String(x.status), overdue: Boolean(x.overdue),
    totalCartons: Number(x.totalCartons), totalPairs: Number(x.totalPairs), receivedCartons: Number(x.receivedCartons),
    receivedPairs: Number(x.receivedPairs), pendingStock: Number(x.pendingStock), grossAmount: x.grossAmount != null ? Number(x.grossAmount) : null,
    soNo: (x.soNo as string) ?? null, poNo: (x.poNo as string) ?? null, fileName: (x.fileName as string) ?? null, uploadedByName: String(x.uploadedByName ?? ''),
  }))
}

/** Received cartons, newest first: of one bill, the unexpected ones, or all. One query. */
export async function listReceipts(db: DbOrTx, f: { billId?: number; unexpected?: boolean; limit?: number } = {}): Promise<ReceiptRow[]> {
  // Cartons counted at stocktake (Warehouse Scanner) are not receipts.
  const conds = [sql`c.status = 'active'`, sql`c.match <> 'stocktake'`]
  if (f.billId) conds.push(sql`c."billId" = ${f.billId}`)
  if (f.unexpected) conds.push(sql`c.match = 'unexpected'`)
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT c.id, c."createdAt", c."articleCode", c."colourCode", c."sizeFrom", c."sizeTo", c."packLetter", c.mrp, c.match,
           c."billId", b."refNo", l."lineNo", c."postedAt", c."postedPairs", c."userName"
    FROM carton_receipts c LEFT JOIN purchase_bills b ON b.id = c."billId" LEFT JOIN purchase_bill_lines l ON l.id = c."billLineId"
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY c.id DESC LIMIT ${Math.min(f.limit ?? 100, 500)}`)
  return r.rows.map((x) => ({
    id: Number(x.id), at: new Date(x.createdAt as string).toISOString(), articleCode: String(x.articleCode), colourCode: String(x.colourCode),
    sizeFrom: String(x.sizeFrom), sizeTo: String(x.sizeTo), packLetter: String(x.packLetter ?? ''), mrp: x.mrp != null ? Number(x.mrp) : null,
    match: x.match as 'matched' | 'unexpected', billId: x.billId != null ? Number(x.billId) : null, refNo: (x.refNo as string) ?? null,
    lineNo: x.lineNo != null ? Number(x.lineNo) : null, posted: x.postedAt != null, postedPairs: x.postedPairs != null ? Number(x.postedPairs) : null,
    userName: String(x.userName ?? ''),
  }))
}

export interface ExpectedStockRow { articleCode: string; colourCode: string; articleName: string | null; sizeFrom: string; sizeTo: string; cartons: number; pairs: number; bills: number; earliest: string }

/** Pairs still to arrive, per article + colour + size range, across open bills. One query. */
export async function expectedStock(db: DbOrTx, search = ''): Promise<ExpectedStockRow[]> {
  const q = search.trim().slice(0, 40)
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
  const r = await db.execute<Record<string, unknown>>(sql`
    WITH rem AS (
      SELECT l."articleCode", l."colourCode", l."sizeFrom", l."sizeTo", l."pairsPerCarton", b.id AS bill, b."expectedOn",
             greatest(l.cartons - (SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active'), 0) AS ctn
      FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l."billId"
      WHERE b.status IN ('expected', 'partial') ${q ? sql`AND (l."articleCode" ILIKE ${like} OR l."colourCode" ILIKE ${like} OR l.description ILIKE ${like})` : sql``})
    SELECT r."articleCode", r."colourCode", r."sizeFrom", r."sizeTo", sum(r.ctn)::int AS cartons, sum(r.ctn * r."pairsPerCarton")::int AS pairs,
           count(DISTINCT r.bill)::int AS bills, min(r."expectedOn")::text AS earliest,
           (SELECT a."artName" FROM articles a WHERE ${NORM(sql`a."artCode"`)} = r."articleCode" AND ${NORM(sql`a."colorCode"`)} = r."colourCode" AND a.active LIMIT 1) AS "articleName"
    FROM rem r WHERE r.ctn > 0
    GROUP BY r."articleCode", r."colourCode", r."sizeFrom", r."sizeTo"
    ORDER BY r."articleCode", r."colourCode", r."sizeFrom"::int
    LIMIT 1000`)
  return r.rows.map((x) => ({
    articleCode: String(x.articleCode), colourCode: String(x.colourCode), articleName: (x.articleName as string) ?? null,
    sizeFrom: String(x.sizeFrom), sizeTo: String(x.sizeTo), cartons: Number(x.cartons), pairs: Number(x.pairs), bills: Number(x.bills), earliest: String(x.earliest),
  }))
}

export async function refreshBillStatus(tx: DbOrTx, billId: number) {
  await tx.execute(sql`
    UPDATE purchase_bills b SET
      status = CASE WHEN x.n = 0 THEN 'expected' WHEN x.n < b."totalCartons" THEN 'partial' ELSE 'received' END,
      "receivedAt" = CASE WHEN x.n >= b."totalCartons" THEN coalesce(b."receivedAt", now()) ELSE NULL END
    FROM (SELECT count(*) AS n FROM carton_receipts WHERE "billId" = ${billId} AND status = 'active' AND match = 'matched') x
    WHERE b.id = ${billId} AND b.status <> 'cancelled'`)
}

export async function setBillDivision(db: Db, actor: Actor, billId: number, division: string): Promise<void> {
  const d = division.trim().slice(0, 60)
  await db.transaction(async (tx) => {
    const r = await tx.update(purchaseBills).set({ division: d }).where(eq(purchaseBills.id, billId)).returning({ id: purchaseBills.id })
    if (!r.length) throw new Error('Bill not found.')
    // Re-fit assortments for cartons received from now on (received cartons keep what they used).
    await tx.execute(sql`UPDATE purchase_bill_lines SET "assortmentId" = NULL WHERE "billId" = ${billId}`)
    await proposeLineAssortments(tx, billId)
    await audit(tx, { actor, action: 'purchase_bill.division', entityType: 'purchase_bill', entityId: billId, after: { division: d } })
  })
}

/** Choose the carton assortment of a line, for cartons received from now on. */
export async function setLineAssortment(db: Db, actor: Actor, lineId: number, assortmentId: number, addArticle = false): Promise<void> {
  return db.transaction(async (tx) => {
    const ok = await tx.execute<{ billId: number; articleCode: string; covers: boolean }>(sql`
      SELECT l."billId", l."articleCode", ${coverRankSql(sql`l."articleCode"`, sql`a."onlyFor"`)} >= 0 AS covers
      FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l."billId" JOIN carton_assortments a ON a.id = ${assortmentId}
      WHERE l.id = ${lineId} AND a.active AND a.division = b.division AND a.packing = l."pairsPerCarton"
        AND a.code = l."sizeFrom" || lpad(l."sizeTo", 2, '0')`)
    if (!ok.rows[0]) throw new Error('That assortment does not fit this line (division, pairs per carton and size range must match).')
    if (!ok.rows[0].covers) {
      if (!addArticle) throw new Error(`That assortment is only for other articles. Confirm using it for ${ok.rows[0].articleCode} too, or enter a new assortment.`)
      await addArticleToAssortment(tx, actor, assortmentId, ok.rows[0].articleCode)
    }
    await tx.update(purchaseBillLines).set({ assortmentId }).where(eq(purchaseBillLines.id, lineId))
    await audit(tx, { actor, action: 'purchase_bill.line_assortment', entityType: 'purchase_bill_line', entityId: lineId, after: { assortmentId } })
  })
}

export async function cancelBill(db: Db, actor: Actor, billId: number, reason: string): Promise<void> {
  const why = reason.trim()
  if (why.length < 3) throw new Error('Write a reason (at least 3 letters).')
  await db.transaction(async (tx) => {
    const got = await tx.execute(sql`SELECT 1 FROM carton_receipts WHERE "billId" = ${billId} AND status = 'active' LIMIT 1`)
    if (got.rows.length) throw new Error('Cartons were already received against this bill. Undo them first.')
    const r = await tx.update(purchaseBills).set({ status: 'cancelled', cancelledAt: sql`now()`, cancelReason: why })
      .where(and(eq(purchaseBills.id, billId), sql`${purchaseBills.status} <> 'cancelled'`)).returning({ id: purchaseBills.id })
    if (!r.length) throw new Error('Bill not found or already cancelled.')
    await audit(tx, { actor, action: 'purchase_bill.cancelled', entityType: 'purchase_bill', entityId: billId, reason: why })
  })
}

// ── Receiving cartons ────────────────────────────────────────────────────────

/** A matched multi-size carton waits for the receiver to confirm (or enter) its assortment. Nothing is saved yet. */
export interface ConfirmCarton {
  status: 'confirm'; label: string; billId: number; refNo: string; lineNo: number; lineReceived: number; lineCartons: number
  articleCode: string; pairsPerCarton: number
  /** Sizes of the carton's range (11–1 wraps for children). */
  sizes: string[]
  articleSegment: string | null
  /** The proposed assortment (null = none fits or the best ones differ: choose or enter). */
  proposal: AssortmentOption | null
  /** Every assortment with this division, pairs per carton and size code. */
  options: AssortmentOption[]
  warnings: string[]
}

export type ReceiveOutcome =
  | { status: 'received'; receiptId: number; match: 'matched'; refNo: string; billId: number; lineNo: number; lineReceived: number; lineCartons: number; posted: boolean; pendingReason: string | null; postedPairs: number; label: string; warnings: string[] }
  | { status: 'received'; receiptId: number; match: 'unexpected'; label: string; reason: string; warnings: string[] }
  | ConfirmCarton
  | { status: 'duplicate'; label: string; message: string }
  | { status: 'rejected'; message: string }

/**
 * Scan one outer carton at receiving. Matches it to the oldest open bill line with the same
 * article, colour, size range and pack letter that still expects cartons (the chosen bill first).
 * Owner, 22 Nov 2026: a multi-size carton is first returned as 'confirm' with the proposed
 * assortment (nothing saved); the same call again with `answer` (the confirmed, chosen or typed
 * assortment) records it and posts its contents to stock when the articles are known.
 * Single-size and unexpected cartons are recorded at once. One transaction per call (the confirm
 * step only reads); a retried clientEventId returns the original result.
 */
export async function receiveCarton(db: Db, actor: Actor, input: { rawInput: string; clientEventId: string; billId?: number | null; answer?: AssortmentAnswer | null }): Promise<ReceiveOutcome> {
  if (!UUID_RE.test(input.clientEventId)) throw new Error('Invalid request.')
  const raw = String(input.rawInput ?? '').trim()
  const p = parseQr(raw)
  if (p.kind !== 'carton') return { status: 'rejected', message: p.kind === 'box' ? 'This is a box label. Scan the outer carton label.' : 'Not a carton label.' }
  if (p.status === 'invalid' || p.status === 'unrecognised') return { status: 'rejected', message: p.issues.find((i) => i.severity === 'error')?.message ?? 'Carton label not readable.' }
  const art = normalizeArticleValue(p.fields.articleCode?.value ?? '')
  const col = normalizeArticleValue(p.fields.colourCode?.value ?? '')
  const from = p.fields.sizeFrom?.value ?? ''
  const to = p.fields.sizeTo?.value ?? ''
  const pack = (p.fields.packCode?.value ?? '').toUpperCase()
  const mrp = p.fields.mrp?.value ?? null
  if (!art || !col || !from || !to) return { status: 'rejected', message: 'The carton label is missing the article, colour or size range.' }
  const key = p.dedupeKey ?? `raw:${p.payload}`
  const label = `${art} ${col} ${from}–${to}${pack ? ` ${pack}` : ''}`
  const warnings: string[] = []

  return db.transaction(async (tx) => {
    const replay = await tx.execute<{ id: number; match: string; billId: number | null }>(sql`SELECT id, match, "billId" FROM carton_receipts WHERE "clientEventId" = ${input.clientEventId}::uuid`)
    if (replay.rows[0]) return outcomeFor(tx, Number(replay.rows[0].id), label, warnings)
    const held = await tx.execute<{ userName: string; createdAt: string; refNo: string | null; match: string }>(sql`
      SELECT c."userName", c."createdAt", b."refNo", c.match FROM carton_receipts c LEFT JOIN purchase_bills b ON b.id = c."billId"
      WHERE c."dedupeKey" = ${key} AND c.status = 'active' LIMIT 1`)
    if (held.rows[0]) {
      const h = held.rows[0]
      const at = new Date(h.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      // A carton counted at stocktake (Warehouse Scanner) is already in stock: receiving it would count it twice.
      if (h.match === 'stocktake') return { status: 'duplicate', label, message: `Already counted in stocktake by ${h.userName || 'someone'} at ${at} — it is in stock. Undo it in the Warehouse Scanner first if it belongs to a bill.` } as const
      return { status: 'duplicate', label, message: `Already received${h.refNo ? ` on bill ${h.refNo}` : ''} by ${h.userName || 'someone'} at ${at}.` } as const
    }
    // Oldest open line that still expects a carton like this one; lock it so two receivers cannot over-receive.
    const cand = await tx.execute<{ id: number; billId: number; refNo: string; mrp: string; cartons: number; received: number; lineNo: number; division: string; pairsPerCarton: number; assortmentId: number | null }>(sql`
      SELECT l.id, l."billId", b."refNo", l.mrp, l.cartons, l."lineNo", b.division, l."pairsPerCarton", l."assortmentId",
             (SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active')::int AS received
      FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l."billId"
      WHERE b.status IN ('expected', 'partial') AND l."articleCode" = ${art} AND l."colourCode" = ${col}
        AND l."sizeFrom" = ${from} AND l."sizeTo" = ${to} ${pack ? sql`AND l."packLetter" = ${pack}` : sql``}
        AND l.cartons > (SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active')
      ORDER BY (b.id = ${input.billId ?? -1}) DESC, (${mrp}::numeric IS NOT NULL AND l.mrp = ${mrp}::numeric) DESC, b."expectedOn", b.id, l."lineNo"
      LIMIT 1
      FOR UPDATE OF l`)
    const line = cand.rows[0]
    // Owner's guess (19 Nov 2026): "A" = regular stock; another letter (e.g. "B") may be factory seconds.
    if (pack && pack !== 'A') warnings.push(`Pack letter "${pack}" (not A) — possibly factory seconds; check the carton.`)
    if (line && mrp != null && Number(line.mrp) !== mrp) warnings.push(`Label MRP ₹${mrp} differs from the bill's ₹${Number(line.mrp)}.`)
    if (line && input.billId && Number(line.billId) !== input.billId) warnings.push(`Not on the chosen bill — matched to bill ${line.refNo}.`)
    // Multi-size carton: the receiver confirms (or chooses / enters) its assortment first.
    if (line && from !== to) {
      if (!input.answer) {
        const ch = (await lineChoices(tx, { lineIds: [Number(line.id)] })).get(Number(line.id))
        const range = expandSizeRange(from, to)
        const ask: ConfirmCarton = {
          status: 'confirm', label, billId: Number(line.billId), refNo: line.refNo, lineNo: Number(line.lineNo),
          lineReceived: Number(line.received), lineCartons: Number(line.cartons), articleCode: art, pairsPerCarton: Number(line.pairsPerCarton),
          sizes: range.ok ? range.sizes : [from, to], articleSegment: ch?.articleSegment ?? null,
          proposal: ch?.proposal ?? null, options: ch?.options ?? [], warnings,
        }
        return ask
      }
      try {
        await settleLineAssortment(tx, actor, {
          id: Number(line.id), refNo: line.refNo, division: line.division ?? '', articleCode: art, pairsPerCarton: Number(line.pairsPerCarton),
          sizeFrom: from, sizeTo: to, assortmentId: line.assortmentId != null ? Number(line.assortmentId) : null,
        }, input.answer, 'carton receiving')
      } catch (e) {
        if (e instanceof NeedsAssortment) return { status: 'rejected', message: e.message } as const
        throw e
      }
    }
    const ins = await tx.execute<{ id: number }>(sql`
      INSERT INTO carton_receipts ("clientEventId", "rawInput", "dedupeKey", "articleCode", "colourCode", "sizeFrom", "sizeTo", "packLetter", mrp, match, "billId", "billLineId", "userId", "userName")
      VALUES (${input.clientEventId}::uuid, ${raw}, ${key}, ${art}, ${col}, ${from}, ${to}, ${pack}, ${mrp}, ${line ? 'matched' : 'unexpected'},
              ${line ? Number(line.billId) : null}, ${line ? Number(line.id) : null}, ${actor.id}, ${actor.name})
      ON CONFLICT DO NOTHING RETURNING id`)
    if (!ins.rows[0]) return { status: 'duplicate', label, message: 'Already received (scanned twice at the same moment).' } as const
    const receiptId = Number(ins.rows[0].id)
    if (line) {
      await refreshBillStatus(tx, Number(line.billId))
      await postReceivedCartons(tx, actor, [receiptId])
    }
    await audit(tx, { actor, action: 'carton.received', entityType: 'carton_receipt', entityId: receiptId, after: { label, match: line ? 'matched' : 'unexpected', billId: line?.billId ?? null } })
    return outcomeFor(tx, receiptId, label, warnings)
  })
}

export async function outcomeFor(tx: DbOrTx, receiptId: number, label: string, warnings: string[]): Promise<ReceiveOutcome> {
  const r = await tx.execute<Record<string, unknown>>(sql`
    SELECT c.id, c.match, c."billId", b."refNo", l."lineNo", l.cartons, c."postedAt", c."postedPairs", l."assortmentId", (l."sizeFrom" = l."sizeTo") AS single,
           (SELECT count(*) FROM carton_receipts x WHERE x."billLineId" = c."billLineId" AND x.status = 'active')::int AS received
    FROM carton_receipts c LEFT JOIN purchase_bills b ON b.id = c."billId" LEFT JOIN purchase_bill_lines l ON l.id = c."billLineId"
    WHERE c.id = ${receiptId}`)
  const x = r.rows[0]
  if (x.match === 'unexpected') return { status: 'received', receiptId, match: 'unexpected', label, reason: 'Not on any open bill (or all its cartons already received). Recorded; stock not changed.', warnings }
  const posted = x.postedAt != null
  return {
    status: 'received', receiptId, match: 'matched', refNo: String(x.refNo), billId: Number(x.billId), lineNo: Number(x.lineNo),
    lineReceived: Number(x.received), lineCartons: Number(x.cartons), posted, postedPairs: Number(x.postedPairs ?? 0), warnings, label,
    pendingReason: posted ? null : x.assortmentId == null && x.single !== true
      ? 'Checked against the bill. No carton assortment for this line, so stock comes from scanning its boxes.'
      : 'Checked against the bill. Article or size not in the article master, so stock comes from scanning its boxes.',
  }
}

/**
 * Post the contents of just-received cartons to stock: +pairs per size, provenance 'carton'.
 * A carton posts only when its line has an assortment and every size resolves to an active SKU;
 * otherwise it stays checked-only (see the note at the top). Set-based.
 */
export async function postReceivedCartons(tx: Tx, actor: Actor, receiptIds: number[]): Promise<{ posted: number; pending: number }> {
  const where = sql`c.id IN (SELECT json_array_elements_text(${J(receiptIds)}::json)::bigint)`
  const rows = (await tx.execute<{ receiptId: number; assortmentId: number | null; sizes: AssortmentSize[] | null; articleCode: string; colourCode: string; sizeFrom: string; sizeTo: string; pairsPerCarton: number }>(sql`
    SELECT c.id AS "receiptId", l."assortmentId", a.sizes, c."articleCode", c."colourCode", l."sizeFrom", l."sizeTo", l."pairsPerCarton"
    FROM carton_receipts c JOIN purchase_bill_lines l ON l.id = c."billLineId" LEFT JOIN carton_assortments a ON a.id = l."assortmentId"
    WHERE ${where} AND c.status = 'active' AND c.match = 'matched' AND c."postedAt" IS NULL
    ORDER BY c.id`)).rows
  if (!rows.length) return { posted: 0, pending: 0 }
  // A single-size carton needs no assortment: every pair is that size.
  for (const r of rows) {
    if (r.assortmentId == null && r.sizeFrom === r.sizeTo) r.sizes = [{ size: r.sizeTo, pairs: Number(r.pairsPerCarton) }]
  }
  const wanted = rows.filter((r) => r.sizes?.length)
  const keys = [...new Set(wanted.flatMap((r) => r.sizes!.map((s) => `${r.articleCode}|${r.colourCode}|${s.size}`)))]
  const skuOf = new Map<string, number>()
  if (keys.length) {
    const sk = await tx.execute<{ k: string; skuId: number }>(sql`
      SELECT k.k, (SELECT s.id FROM articles a JOIN article_sizes s ON s."articleId" = a.id AND s."sizeLabel" = split_part(k.k, '|', 3) AND s.active
                   WHERE ${NORM(sql`a."artCode"`)} = split_part(k.k, '|', 1) AND ${NORM(sql`a."colorCode"`)} = split_part(k.k, '|', 2) AND a.active LIMIT 1) AS "skuId"
      FROM json_array_elements_text(${J(keys)}::json) AS k(k)`)
    for (const r of sk.rows) if (r.skuId != null) skuOf.set(r.k, Number(r.skuId))
  }
  const ready = wanted.filter((r) => r.sizes!.every((s) => skuOf.has(`${r.articleCode}|${r.colourCode}|${s.size}`)))
  if (!ready.length) return { posted: 0, pending: rows.length }
  const loc = await mainLocationId(tx)
  const moves = ready.flatMap((r) => r.sizes!.map((s) => ({ receipt: Number(r.receiptId), sku: skuOf.get(`${r.articleCode}|${r.colourCode}|${s.size}`)!, qty: s.pairs })))
  const skus = [...new Set(moves.map((m) => m.sku))].sort((a, b) => a - b)
  await tx.execute(sql`SELECT pg_advisory_xact_lock(7301, x::int) FROM json_array_elements_text(${J(skus)}::json) x ORDER BY x::int`)
  await tx.execute(sql`
    INSERT INTO stock_movements ("skuId", "locationId", provenance, quantity, "movementType", "sourceType", "sourceId", "idempotencyKey", "userId", reason)
    SELECT x.sku, ${loc}, 'carton', x.qty, 'receipt', 'carton_receipt', x.receipt::text, 'carton_receipt:' || x.receipt || ':' || x.sku, ${actor.id}, 'carton received'
    FROM json_to_recordset(${J(moves)}::json) AS x(receipt bigint, sku int, qty int)
    ON CONFLICT ("idempotencyKey") DO NOTHING`)
  await tx.execute(sql`
    UPDATE carton_receipts c SET "postedAt" = now(), "assortmentId" = x."assortmentId", "postedPairs" = x.pairs
    FROM json_to_recordset(${J(ready.map((r) => ({ id: Number(r.receiptId), assortmentId: r.assortmentId, pairs: r.sizes!.reduce((n, s) => n + s.pairs, 0) })))}::json)
         AS x(id bigint, "assortmentId" int, pairs int)
    WHERE c.id = x.id`)
  return { posted: ready.length, pending: rows.length - ready.length }
}

/**
 * Undo a carton receipt (wrong carton, scanned by mistake). Its stock comes back out — refused if
 * that would take carton stock below zero (boxes from it were already scanned or sold).
 */
export async function voidCartonReceipt(db: Db, actor: Actor, receiptId: number, reason: string): Promise<void> {
  const why = reason.trim()
  if (why.length < 3) throw new Error('Write a reason (at least 3 letters).')
  await db.transaction(async (tx) => {
    const r = await tx.execute<{ billId: number | null; status: string }>(sql`SELECT "billId", status FROM carton_receipts WHERE id = ${receiptId} FOR UPDATE`)
    const c = r.rows[0]
    if (!c || c.status !== 'active') throw new Error('Receipt not found or already undone.')
    const moves = (await tx.execute<{ id: number; skuId: number; locationId: number; quantity: number }>(sql`
      SELECT m.id, m."skuId", m."locationId", m.quantity FROM stock_movements m
      WHERE m."sourceType" = 'carton_receipt' AND m."sourceId" = ${String(receiptId)} AND m."movementType" IN ('receipt', 'stocktake_carton')
        AND NOT EXISTS (SELECT 1 FROM stock_movements x WHERE x."reversalOfId" = m.id)`)).rows
    if (moves.length) {
      const skus = [...new Set(moves.map((m) => Number(m.skuId)))].sort((a, b) => a - b)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7301, x::int) FROM json_array_elements_text(${J(skus)}::json) x ORDER BY x::int`)
      const bal = await tx.execute<{ skuId: number; q: number }>(sql`
        SELECT "skuId", quantity AS q FROM stock_balances WHERE provenance = 'carton' AND "skuId" IN (SELECT json_array_elements_text(${J(skus)}::json)::int)`)
      const have = new Map(bal.rows.map((b) => [Number(b.skuId), Number(b.q)]))
      const short = moves.filter((m) => (have.get(Number(m.skuId)) ?? 0) < Number(m.quantity))
      if (short.length) throw new Error('Boxes from this carton were already scanned or billed, so it cannot be undone. Correct the stock on the Inventory screen instead.')
      await tx.execute(sql`
        INSERT INTO stock_movements ("skuId", "locationId", provenance, quantity, "movementType", "sourceType", "sourceId", "idempotencyKey", "reversalOfId", "userId", reason)
        SELECT m."skuId", m."locationId", m.provenance, -m.quantity, 'reversal', m."sourceType", m."sourceId", 'carton_receipt:' || ${receiptId} || ':void:' || m.id, m.id, ${actor.id}, ${why}
        FROM stock_movements m WHERE m.id IN (SELECT json_array_elements_text(${J(moves.map((m) => Number(m.id)))}::json)::bigint)`)
    }
    await tx.execute(sql`UPDATE carton_receipts SET status = 'voided', "voidedAt" = now(), "voidedBy" = ${actor.id}, "voidReason" = ${why} WHERE id = ${receiptId}`)
    if (c.billId != null) await refreshBillStatus(tx, Number(c.billId))
    await audit(tx, { actor, action: 'carton.voided', entityType: 'carton_receipt', entityId: receiptId, reason: why, after: { reversedMovements: moves.length } })
  })
}
