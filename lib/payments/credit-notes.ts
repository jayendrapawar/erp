// Credit notes (owner, 24 Nov 2026; migration 0018). Server only. docs/architecture/payments.md.
//
//   money   discount / rate difference: the amount BEFORE GST is typed; GST is added at the bill's
//           saved rates — or, with no bill, at the chosen bill type's rates (Master defaults).
//   return  goods sent back: boxes of the bill are scanned; each goes back into stock (its stock-out
//           is reversed) and is marked 'returned' on its bill. The amount is what those boxes were
//           billed at (the bill's line discount, bill discount and GST rates). A return needs a bill.
//
// Saving: one transaction — lock the party, note number (CN series), the note + lines, the ledger
// entry (−), set against its bill first and then the oldest unpaid bills (the rest is advance),
// stock back for returns, audit. The browser's clientId makes a retry save once. ~9 statements.
// A money note can be cancelled with a reason (ledger reversed); a goods return cannot.

import { sql } from 'drizzle-orm'
import type { Actor, DbOrTx, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { readBoxLabel } from '@/lib/billing/box-label'
import { billRatesFor, bpToPct, computeBillTotals, ratesBp, toBp, type BillRates, type TaxType } from '@/lib/billing/bill-totals'
import { defaultBillRates, isTaxType } from '@/lib/billing/sale-bill'
import { allocateCredit, lockParty, partySummary, type PartySummary } from './payments'
import { moneyNoteTotals, type NoteTotals } from './credit-note-math'

const J = (v: unknown) => JSON.stringify(v)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IST_TODAY = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`

export { moneyNoteTotals, type NoteTotals } from './credit-note-math'

export interface NoteBill {
  saleBillId: number; orderId: number; billNo: string; billDate: string; retailerId: string | null; taxType: TaxType
  lineDiscPct: number; rates: BillRates; grandTotalPaise: number; status: string
}

async function loadBill(db: DbOrTx, saleBillId: number): Promise<NoteBill | null> {
  const r = (await db.execute<{ id: string; orderId: number; billNo: string; billDate: string; retailerId: string | null; taxType: TaxType
    lineDiscPct: string; discountPct: string; cgstPct: string; sgstPct: string; igstPct: string; grandTotalPaise: string; status: string }>(sql`
    SELECT id, "orderId", "billNo", "billDate"::text AS "billDate", "retailerId", "taxType", "lineDiscPct", "discountPct", "cgstPct", "sgstPct", "igstPct",
      "grandTotalPaise", status FROM sale_bills WHERE id = ${saleBillId}`)).rows[0]
  if (!r) return null
  return {
    saleBillId: Number(r.id), orderId: Number(r.orderId), billNo: r.billNo, billDate: r.billDate, retailerId: r.retailerId, taxType: r.taxType,
    lineDiscPct: Number(r.lineDiscPct), grandTotalPaise: Number(r.grandTotalPaise), status: r.status,
    // A bill's saved rates: its GST % are 0 for the taxes it does not have, so take the defaults for those.
    rates: { discountPct: Number(r.discountPct), cgstPct: Number(r.cgstPct) || 2.5, sgstPct: Number(r.sgstPct) || 2.5, igstPct: Number(r.igstPct) || 5 },
  }
}

export interface ReturnBox { id: number; dedupeKey: string; articleCode: string; mrp: number; raw: string }

/** A scanned box: it must be on this bill and not returned yet. 1 query. */
export async function checkReturnBox(db: DbOrTx, saleBillId: number, raw: string): Promise<ReturnBox> {
  const read = readBoxLabel(raw)
  if (!read.ok) throw new Error(read.message)
  const r = (await db.execute<{ id: string; status: string; articleCode: string; mrp: string; billNo: string; creditNoteId: string | null }>(sql`
    SELECT b.id, b.status, b."articleCode", b.mrp, sb."billNo", b."creditNoteId"
    FROM sale_bills sb JOIN bill_scans b ON b."orderId" = sb."orderId" AND b."dedupeKey" = ${read.box.dedupeKey}
    WHERE sb.id = ${saleBillId} LIMIT 1`)).rows[0]
  if (!r) throw new Error(`This box (${read.box.articleCode}) is not on this bill.`)
  if (r.status === 'returned') throw new Error('This box was already returned on an earlier credit note.')
  if (r.status !== 'active') throw new Error('This box is no longer on the bill (it was taken off).')
  return { id: Number(r.id), dedupeKey: read.box.dedupeKey, articleCode: r.articleCode, mrp: Number(r.mrp), raw: read.box.raw }
}

export interface CreditNoteInput {
  clientId: string
  retailerId: string
  noteDate: string
  kind: 'money' | 'return'
  reason: string
  /** The original bill (required for a return). */
  saleBillId?: number | null
  /** Money note: amount before GST. */
  taxablePaise?: number
  /** Money note without a bill: its bill type (rates from Master). */
  taxType?: TaxType
  /** Return: the scanned boxes (QR text). */
  boxes?: string[]
}

export interface SavedCreditNote { creditNoteId: number; noteNo: string; totals: NoteTotals; repeated: boolean; party: PartySummary }

export async function createCreditNote(tx: Tx, actor: Actor, raw: unknown): Promise<SavedCreditNote> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const clientId = String(r.clientId ?? '').trim()
  if (!UUID.test(clientId)) throw new Error('Bad request: missing note id. Reload the page.')
  const retailerId = String(r.retailerId ?? '').trim()
  if (!retailerId) throw new Error('Choose the party.')
  const kind = r.kind === 'return' ? 'return' : r.kind === 'money' ? 'money' : null
  if (!kind) throw new Error('Choose money or goods returned.')
  const noteDate = String(r.noteDate ?? '').trim()
  if (!DATE.test(noteDate) || Number.isNaN(Date.parse(noteDate))) throw new Error('Choose the date.')
  const reason = String(r.reason ?? '').trim().slice(0, 300)
  if (!reason) throw new Error('Type the reason for the credit note.')
  const saleBillId = r.saleBillId == null || r.saleBillId === '' ? null : Number(r.saleBillId)
  if (saleBillId !== null && (!Number.isInteger(saleBillId) || saleBillId <= 0)) throw new Error('Choose the bill again.')
  if (kind === 'return' && saleBillId === null) throw new Error('Goods returned need the bill they were sold on.')

  const party = await lockParty(tx, retailerId)
  const prev = (await tx.execute<{ id: string; noteNo: string; retailerId: string }>(sql`SELECT id, "noteNo", "retailerId" FROM credit_notes WHERE "clientId" = ${clientId}`)).rows[0]
  if (prev) {
    if (prev.retailerId !== retailerId) throw new Error('This form was already used for another credit note. Reload the page.')
    const t = await noteTotalsOf(tx, Number(prev.id))
    return { creditNoteId: Number(prev.id), noteNo: prev.noteNo, totals: t, repeated: true, party: await partySummary(tx, retailerId) }
  }

  const bill = saleBillId === null ? null : await loadBill(tx, saleBillId)
  if (saleBillId !== null) {
    if (!bill) throw new Error('Bill not found.')
    if (bill.status !== 'active') throw new Error(`Bill ${bill.billNo} is cancelled.`)
    if (bill.retailerId !== retailerId) throw new Error(`Bill ${bill.billNo} is not this party's bill.`)
  }

  let totals: NoteTotals, taxType: TaxType
  let lines: Array<{ artNumber: string; mrp: number; qty: number }> = []
  const boxes: ReturnBox[] = []
  if (kind === 'money') {
    const taxable = Number(r.taxablePaise)
    if (!Number.isInteger(taxable) || taxable <= 0 || taxable > 1_000_000_000_00) throw new Error('Type the amount before GST.')
    if (bill) { taxType = bill.taxType; totals = moneyNoteTotals(taxable, taxType, bill.rates) }
    else {
      if (!isTaxType(r.taxType)) throw new Error('Choose the bill type (GST) for a note without a bill.')
      taxType = r.taxType
      totals = moneyNoteTotals(taxable, taxType, billRatesFor(taxType, await defaultBillRates(tx)))
    }
  } else {
    const raws = Array.isArray(r.boxes) ? r.boxes.map((x) => String(x ?? '')).filter(Boolean).slice(0, 2000) : []
    if (!raws.length) throw new Error('Scan the boxes that came back.')
    const seen = new Set<string>()
    for (const x of raws) {
      const b = await checkReturnBox(tx, bill!.saleBillId, x)
      if (seen.has(b.dedupeKey)) throw new Error('The same box is scanned twice.')
      seen.add(b.dedupeKey); boxes.push(b)
    }
    const m = new Map<string, { artNumber: string; mrp: number; qty: number }>()
    for (const b of boxes) {
      const k = `${b.articleCode}__${b.mrp.toFixed(2)}`
      const cur = m.get(k)
      if (cur) cur.qty++
      else m.set(k, { artNumber: b.articleCode, mrp: b.mrp, qty: 1 })
    }
    lines = [...m.values()]
    taxType = bill!.taxType
    const t = computeBillTotals(lines, bill!.lineDiscPct, taxType, ratesBp(bill!.rates))
    totals = { ...t, totalPaise: t.grandTotalPaise }
  }

  const seq = (await tx.execute<{ prefix: string; n: string; padding: number }>(sql`
    UPDATE document_sequences SET next = next + 1 WHERE name = 'credit_note' RETURNING prefix, next - 1 AS n, padding`)).rows[0]
  if (!seq) throw new Error('Credit note numbering is not set up (document_sequences).')
  const noteNo = `${seq.prefix}${String(seq.n).padStart(seq.padding, '0')}`
  const t = totals
  const id = Number((await tx.execute<{ id: string }>(sql`
    INSERT INTO credit_notes ("clientId", "noteNo", "noteDate", "retailerId", "saleBillId", kind, reason, "taxType", "totalQty", "lineDiscPct",
      "grossPaise", "discountPct", "discountPaise", "taxablePaise", "cgstPct", "cgstPaise", "sgstPct", "sgstPaise", "igstPct", "igstPaise",
      "roundOffPaise", "totalPaise", "createdBy", "createdByName")
    VALUES (${clientId}, ${noteNo}, ${noteDate}::date, ${retailerId}, ${saleBillId}, ${kind}, ${reason}, ${taxType}, ${t.totalQty},
      ${kind === 'return' ? String(bill!.lineDiscPct) : null}, ${t.grossPaise}, ${bpToPct(t.discountBp)}, ${t.discountPaise}, ${t.taxablePaise},
      ${bpToPct(t.cgstBp)}, ${t.cgstPaise}, ${bpToPct(t.sgstBp)}, ${t.sgstPaise}, ${bpToPct(t.igstBp)}, ${t.igstPaise},
      ${t.roundOffPaise}, ${t.totalPaise}, ${actor.id}, ${actor.name})
    RETURNING id`)).rows[0].id)
  if (lines.length) {
    await tx.execute(sql`
      INSERT INTO credit_note_lines ("creditNoteId", "artNumber", mrp, qty, hsn)
      SELECT ${id}, x.a, x.m, x.q,
        (SELECT a.hsn FROM articles a WHERE a.hsn <> '' AND (upper(btrim(a."artCode")) = upper(btrim(x.a)) OR upper(btrim(a."artName")) = upper(btrim(x.a)))
         ORDER BY (upper(btrim(a."artCode")) = upper(btrim(x.a))) DESC, a.active DESC LIMIT 1)
      FROM json_to_recordset(${J(lines.map((l) => ({ a: l.artNumber, m: l.mrp, q: l.qty })))}::json) AS x(a text, m numeric, q int)`)
  }
  // Ledger: one − entry; set against its bill first, then the oldest unpaid bills.
  const entryId = Number((await tx.execute<{ id: string }>(sql`
    INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "creditNoteId", "refNo", note, "idempotencyKey", "createdBy", "createdByName")
    VALUES (${retailerId}, 'credit_note', ${-t.totalPaise}, ${noteDate}::date, ${id}, ${noteNo},
      ${bill ? `Against bill ${bill.billNo}: ${reason}` : reason}, ${`credit_note:${id}`}, ${actor.id}, ${actor.name})
    RETURNING id`)).rows[0].id)
  let set = 0
  if (bill) {
    const open = (await tx.execute<{ entryId: string; openPaise: string }>(sql`
      SELECT oi.id AS "entryId", oi."openPaise" FROM party_open_items oi JOIN party_ledger_entries e ON e.id = oi.id
      WHERE e."saleBillId" = ${bill.saleBillId} AND e.kind = 'bill' AND oi.side = 'debit'`)).rows[0]
    const take = open ? Math.min(Number(open.openPaise), t.totalPaise) : 0
    if (take > 0) set += await allocateCredit(tx, actor, retailerId, entryId, t.totalPaise, [{ entryId: Number(open!.entryId), amountPaise: take }])
  }
  if (t.totalPaise - set > 0) set += await allocateCredit(tx, actor, retailerId, entryId, t.totalPaise - set)
  // Goods back into stock: each box's stock-out is reversed; the box stays on its bill as 'returned'.
  if (boxes.length) {
    const ids = boxes.map((b) => b.id)
    await tx.execute(sql`
      INSERT INTO stock_movements ("skuId", "locationId", provenance, quantity, "movementType", "sourceType", "sourceId", "idempotencyKey", "reversalOfId", "userId", reason)
      SELECT m."skuId", m."locationId", m.provenance, -m.quantity, 'reversal', m."sourceType", m."sourceId", 'bill_scan:' || b.id || ':return:' || m.id, m.id, ${actor.id},
             ${`Returned on credit note ${noteNo}`}
      FROM bill_scans b JOIN stock_movements m ON m.id = b."movementId"
      WHERE b.id IN (SELECT (x)::bigint FROM json_array_elements_text(${J(ids)}::json) x)
        AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r."reversalOfId" = m.id)`)
    const u = await tx.execute(sql`
      UPDATE bill_scans SET status = 'returned', "creditNoteId" = ${id}
      WHERE id IN (SELECT (x)::bigint FROM json_array_elements_text(${J(ids)}::json) x) AND status = 'active'`)
    if ((u.rowCount ?? 0) !== ids.length) throw new Error('A box changed meanwhile. Scan the boxes again.')
  }
  await audit(tx, {
    actor, action: 'credit_note.created', entityType: 'credit_note', entityId: id,
    after: { noteNo, retailerId, partyName: party.partyName, kind, saleBillId, billNo: bill?.billNo, totalPaise: t.totalPaise, boxes: boxes.length, setAgainstPaise: set },
    reason,
  })
  return { creditNoteId: id, noteNo, totals: t, repeated: false, party: await partySummary(tx, retailerId) }
}

async function noteTotalsOf(db: DbOrTx, id: number): Promise<NoteTotals> {
  const r = (await db.execute<Record<string, string>>(sql`
    SELECT "totalQty", "grossPaise", "discountPct", "discountPaise", "taxablePaise", "cgstPct", "cgstPaise", "sgstPct", "sgstPaise", "igstPct", "igstPaise",
      "roundOffPaise", "totalPaise" FROM credit_notes WHERE id = ${id}`)).rows[0]
  const N = (k: string) => Number(r[k])
  return {
    totalQty: N('totalQty'), grossPaise: N('grossPaise'), discountBp: toBp(r.discountPct), discountPaise: N('discountPaise'), taxablePaise: N('taxablePaise'),
    cgstBp: toBp(r.cgstPct), cgstPaise: N('cgstPaise'), sgstBp: toBp(r.sgstPct), sgstPaise: N('sgstPaise'), igstBp: toBp(r.igstPct), igstPaise: N('igstPaise'),
    roundOffPaise: N('roundOffPaise'), totalPaise: N('totalPaise'),
  }
}

/** Cancel a money credit note (its ledger entry reversed; what it paid is unpaid again). */
export async function cancelCreditNote(tx: Tx, actor: Actor, id: number, reason: unknown): Promise<{ noteNo: string; party: PartySummary }> {
  const why = String(reason ?? '').trim().slice(0, 500)
  if (!why) throw new Error('Type the reason.')
  const n = (await tx.execute<{ noteNo: string; retailerId: string; kind: string; status: string }>(sql`
    SELECT "noteNo", "retailerId", kind, status FROM credit_notes WHERE id = ${id}`)).rows[0]
  if (!n) throw new Error('Credit note not found.')
  if (n.status !== 'active') throw new Error(`Credit note ${n.noteNo} is already cancelled.`)
  if (n.kind !== 'money') throw new Error('A goods return cannot be cancelled. If the boxes go out again, bill them again.')
  await lockParty(tx, n.retailerId)
  await tx.execute(sql`UPDATE credit_notes SET status = 'cancelled', "cancelledAt" = now(), "cancelledBy" = ${actor.id}, "cancelReason" = ${why} WHERE id = ${id}`)
  await tx.execute(sql`
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", "reversalOfId", method, "createdBy")
    SELECT a."retailerId", a."debitEntryId", a."creditEntryId", -a."amountPaise", a.id, 'reversal', ${actor.id}
    FROM party_allocations a JOIN party_ledger_entries e ON e.id = a."creditEntryId"
    WHERE e."creditNoteId" = ${id} AND e.kind = 'credit_note' AND a."reversalOfId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM party_allocations r WHERE r."reversalOfId" = a.id)`)
  await tx.execute(sql`
    WITH r AS (
      INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "reversalOfId", "refNo", reason, "idempotencyKey", "createdBy", "createdByName")
      SELECT "retailerId", 'reversal', -"amountPaise", ${IST_TODAY}, id, "refNo", ${`Credit note cancelled: ${why}`}, 'reversal:' || id, ${actor.id}, ${actor.name}
      FROM party_ledger_entries WHERE "creditNoteId" = ${id} AND kind = 'credit_note'
      RETURNING id, "retailerId", "reversalOfId", "amountPaise"
    )
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
    SELECT "retailerId", id, "reversalOfId", abs("amountPaise"), 'auto', ${actor.id} FROM r`)
  await audit(tx, { actor, action: 'credit_note.cancelled', entityType: 'credit_note', entityId: id, after: { noteNo: n.noteNo }, reason: why })
  return { noteNo: n.noteNo, party: await partySummary(tx, n.retailerId) }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export interface PartyBill { saleBillId: number; billNo: string; billDate: string; taxType: TaxType; grandTotalPaise: number; unpaidPaise: number; lineDiscPct: number; rates: BillRates }

/** The party's bills (newest first, up to 300) to pick the original bill from. 1 query. */
export async function listPartyBills(db: DbOrTx, retailerId: string): Promise<PartyBill[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT sb.id, sb."billNo", sb."billDate"::text AS "billDate", sb."taxType", sb."grandTotalPaise", sb."lineDiscPct", sb."discountPct", sb."cgstPct", sb."sgstPct", sb."igstPct",
      coalesce(e."amountPaise" - (SELECT coalesce(sum(a."amountPaise"), 0) FROM party_allocations a WHERE a."debitEntryId" = e.id), 0) AS unpaid
    FROM sale_bills sb LEFT JOIN party_ledger_entries e ON e."saleBillId" = sb.id AND e.kind = 'bill'
    WHERE sb."retailerId" = ${retailerId} AND sb.status = 'active'
    ORDER BY sb."billDate" DESC, sb.id DESC LIMIT 300`)).rows
  return rows.map((r) => ({
    saleBillId: Number(r.id), billNo: r.billNo, billDate: r.billDate, taxType: r.taxType as TaxType, grandTotalPaise: Number(r.grandTotalPaise),
    unpaidPaise: Number(r.unpaid), lineDiscPct: Number(r.lineDiscPct),
    rates: { discountPct: Number(r.discountPct), cgstPct: Number(r.cgstPct) || 2.5, sgstPct: Number(r.sgstPct) || 2.5, igstPct: Number(r.igstPct) || 5 },
  }))
}

export interface CreditNoteRow {
  id: number; noteNo: string; noteDate: string; retailerId: string; partyName: string; kind: 'money' | 'return'; reason: string
  billNo: string | null; totalPaise: number; totalQty: number; status: string; createdByName: string
}

/** Credit notes, newest first (up to 300). 1 query. */
export async function listCreditNotes(db: DbOrTx, q = ''): Promise<CreditNoteRow[]> {
  const s = String(q).trim().slice(0, 80)
  const like = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT n.id, n."noteNo", n."noteDate"::text AS "noteDate", n."retailerId", r."partyName", n.kind, n.reason, sb."billNo", n."totalPaise", n."totalQty", n.status, n."createdByName"
    FROM credit_notes n JOIN retailers r ON r.id = n."retailerId" LEFT JOIN sale_bills sb ON sb.id = n."saleBillId"
    WHERE (${s} = '' OR r."partyName" ILIKE ${like} OR n."noteNo" ILIKE ${like} OR sb."billNo" ILIKE ${like})
    ORDER BY n."noteDate" DESC, n.id DESC LIMIT 300`)).rows
  return rows.map((r) => ({
    id: Number(r.id), noteNo: r.noteNo, noteDate: r.noteDate, retailerId: r.retailerId, partyName: r.partyName, kind: r.kind as 'money' | 'return',
    reason: r.reason, billNo: r.billNo ?? null, totalPaise: Number(r.totalPaise), totalQty: Number(r.totalQty), status: r.status, createdByName: r.createdByName,
  }))
}

export interface CreditNotePrint {
  noteNo: string; noteDate: string; kind: 'money' | 'return'; reason: string; status: string
  party: { partyName: string; address: string; gst: string; phone: string }
  bill: { billNo: string; billDate: string } | null
  taxType: TaxType; lineDiscPct: number | null
  lines: Array<{ artNumber: string; mrp: number; qty: number; hsn: string | null }>
  totals: NoteTotals
}

/** Everything a printed credit note shows. 1 query. */
export async function creditNoteForPrint(db: DbOrTx, id: number): Promise<CreditNotePrint | null> {
  const r = (await db.execute<Record<string, unknown>>(sql`
    SELECT n.id, n."noteNo", n."noteDate"::text AS "noteDate", n.kind, n.reason, n.status, n."taxType", n."lineDiscPct",
      json_build_object('partyName', r."partyName", 'address', concat_ws(', ', nullif(r.address, ''), nullif(r.city, '')), 'gst', coalesce(r.gst, ''), 'phone', coalesce(r.phone, '')) AS party,
      CASE WHEN sb.id IS NULL THEN NULL ELSE json_build_object('billNo', sb."billNo", 'billDate', sb."billDate") END AS bill,
      coalesce((SELECT json_agg(json_build_object('artNumber', l."artNumber", 'mrp', l.mrp, 'qty', l.qty, 'hsn', l.hsn) ORDER BY l.id) FROM credit_note_lines l WHERE l."creditNoteId" = n.id), '[]') AS lines
    FROM credit_notes n JOIN retailers r ON r.id = n."retailerId" LEFT JOIN sale_bills sb ON sb.id = n."saleBillId"
    WHERE n.id = ${id}`)).rows[0]
  if (!r) return null
  const bill = r.bill as { billNo: string; billDate: string } | null
  return {
    noteNo: String(r.noteNo), noteDate: String(r.noteDate), kind: r.kind as 'money' | 'return', reason: String(r.reason), status: String(r.status),
    party: r.party as CreditNotePrint['party'], bill: bill ? { billNo: bill.billNo, billDate: String(bill.billDate).slice(0, 10) } : null,
    taxType: r.taxType as TaxType, lineDiscPct: r.lineDiscPct == null ? null : Number(r.lineDiscPct),
    lines: (r.lines as Array<{ artNumber: string; mrp: string; qty: number; hsn: string | null }>).map((l) => ({ artNumber: l.artNumber, mrp: Number(l.mrp), qty: Number(l.qty), hsn: l.hsn })),
    totals: await noteTotalsOf(db, id),
  }
}
