// Edit a billed bill by scanning boxes on or off (owner, 24 Nov 2026). Server only.
// docs/architecture/billing-stock.md → "Edit bill".
//
// Owner decisions: billers and admins, only while the bill is 'billed' (not yet dispatched); the bill
// keeps its number AND its date; money already set against it is set against the edited bill again
// (oldest first, up to the new total; the rest stays advance); no reason is asked (the change is
// written as "Bill edited: +2 / −1 boxes").
//
// One transaction, ~18 statements whatever the number of boxes:
//   lock + read (1) → boxes off: reverse their stock movements (2) → boxes on (1) and out of stock (~4)
//   → bill lines rewritten (3) → old frozen bill cancelled, its ledger entry reversed (3 + audit)
//   → new frozen bill + ledger entry, same number and date (3 + audit) → payments re-attached (1) → audit.

import { eq, sql } from 'drizzle-orm'
import { billLines, orders } from '@/lib/db/schema'
import type { Actor, Db, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { stampBillLineHsn } from './bill-number'
import { insertOrderBoxes, postOrderScans, releaseOrderScans, type StockOutCounts } from './bill-stock'
import { readBoxLabel, type BoxLabel } from './box-label'
import { applyBoxChanges, reattachAmounts, type EditLine } from './bill-edit'
import { cancelSaleBill, freezeSaleBill, type BillParty } from './sale-bill'
import type { BillRates, BillTotalsPaise, TaxType } from './bill-totals'

const J = (v: unknown) => JSON.stringify(v)
/** The rates saved on a sale_bills row (an edited bill keeps them, whatever the Master defaults are now). */
const savedRates = (b: { discountPct: string | null; cgstPct: string | null; sgstPct: string | null; igstPct: string | null }): BillRates => ({
  discountPct: Number(b.discountPct ?? 0), cgstPct: Number(b.cgstPct ?? 0), sgstPct: Number(b.sgstPct ?? 0), igstPct: Number(b.igstPct ?? 0),
})
const MAX_CHANGES = 2000

export interface EditableBox { dedupeKey: string; articleCode: string; colourCode: string | null; sizeLabel: string | null; mrp: number | null }

export interface BillForEdit {
  orderId: number
  orderNumber: string
  billNo: string
  status: string
  shopkeeperName: string
  taxType: TaxType
  lineDiscPct: number
  /** Bill discount saved on the bill (4.75 % on party bills, typed on walk-in bills). */
  discountPct: number
  /** The discount and GST rates the bill was made with; an edit keeps them. */
  rates: BillRates
  grandTotalPaise: number
  lines: EditLine[]
  boxes: EditableBox[]
}

/** What the Edit bill screen needs. 1 query. Null when the order has no saved (frozen) bill. */
export async function loadBillForEdit(db: DbOrTx, orderId: number): Promise<BillForEdit | null> {
  const r = (await db.execute<{
    orderNumber: string; status: string; shopkeeperName: string; billNo: string | null; taxType: TaxType | null
    lineDiscPct: string | null; discountPct: string | null; cgstPct: string | null; sgstPct: string | null; igstPct: string | null; grandTotalPaise: string | null
    lines: { artNumber: string; mrp: string | number; qty: number; hsn: string | null }[]
    boxes: { dedupeKey: string; articleCode: string; colourCode: string | null; sizeLabel: string | null; mrp: string | number | null }[]
  }>(sql`
    SELECT o."orderNumber", o.status, o."shopkeeperName", b."billNo", b."taxType", b."lineDiscPct", b."discountPct", b."cgstPct", b."sgstPct", b."igstPct", b."grandTotalPaise",
      coalesce((SELECT json_agg(json_build_object('artNumber', l."artNumber", 'mrp', l.mrp, 'qty', l.qty, 'hsn', l.hsn) ORDER BY l.id)
                FROM bill_lines l WHERE l."orderId" = o.id), '[]') AS lines,
      coalesce((SELECT json_agg(json_build_object('dedupeKey', s."dedupeKey", 'articleCode', s."articleCode", 'colourCode', s."colourCode", 'sizeLabel', s."sizeLabel", 'mrp', s.mrp) ORDER BY s.id)
                FROM bill_scans s WHERE s."orderId" = o.id AND s.status = 'active'), '[]') AS boxes
    FROM orders o LEFT JOIN sale_bills b ON b."orderId" = o.id AND b.status = 'active'
    WHERE o.id = ${orderId}`)).rows[0]
  if (!r || !r.billNo || !r.taxType) return null
  return {
    orderId, orderNumber: r.orderNumber, billNo: r.billNo, status: r.status, shopkeeperName: r.shopkeeperName, taxType: r.taxType,
    lineDiscPct: Number(r.lineDiscPct), discountPct: Number(r.discountPct), rates: savedRates(r), grandTotalPaise: Number(r.grandTotalPaise),
    lines: r.lines.map((l) => ({ artNumber: l.artNumber, mrp: Number(l.mrp), qty: Number(l.qty), hsn: l.hsn })),
    boxes: r.boxes.map((b) => ({ ...b, mrp: b.mrp == null ? null : Number(b.mrp) })),
  }
}

export interface EditedBill {
  billNo: string
  totals: BillTotalsPaise
  lines: EditLine[]
  added: number
  removed: number
  stock: StockOutCounts
  /** Money set against the edited bill again (paise). */
  reattachedPaise: number
}

/** Save the scanned changes: `add` raw box labels, `remove` dedupe keys of boxes on the bill. */
export async function editBillByScan(db: Db, actor: Actor, orderId: number, input: { add: string[]; remove: string[] }): Promise<EditedBill> {
  const addRaw = Array.isArray(input.add) ? input.add.map(String) : []
  const removeIn = Array.isArray(input.remove) ? input.remove.map(String) : []
  if (addRaw.length + removeIn.length > MAX_CHANGES) throw new Error(`At most ${MAX_CHANGES} boxes can change in one edit.`)

  return db.transaction(async (tx) => {
    const cur = (await tx.execute<{
      status: string; orderNumber: string; saleBillId: string | null; source: 'invoice' | 'direct' | 'backfill'; taxType: TaxType
      retailerId: string | null; customerName: string; customerPhone: string; paidMode: 'cash' | 'upi' | null
      discountPct: string; cgstPct: string; sgstPct: string; igstPct: string; lineDiscPct: string; billDate: string; billNo: string; grandTotalPaise: string; hasDiscount: boolean
      lines: { artNumber: string; mrp: string | number; qty: number; hsn: string | null }[]
      boxes: { dedupeKey: string; articleCode: string; mrp: string | number | null }[]
      paid: { id: string | number; amountPaise: string | number }[]
    }>(sql`
      SELECT o.status, o."orderNumber", b.id AS "saleBillId", b.source, b."taxType", b."retailerId", b."customerName", b."customerPhone", b."paidMode",
        b."discountPct", b."cgstPct", b."sgstPct", b."igstPct", b."lineDiscPct", b."billDate"::text AS "billDate", b."billNo", b."grandTotalPaise",
        EXISTS (SELECT 1 FROM party_ledger_entries e WHERE e."saleBillId" = b.id AND e.kind = 'discount'
                AND NOT EXISTS (SELECT 1 FROM party_ledger_entries r WHERE r."reversalOfId" = e.id)) AS "hasDiscount",
        coalesce((SELECT json_agg(json_build_object('artNumber', l."artNumber", 'mrp', l.mrp, 'qty', l.qty, 'hsn', l.hsn) ORDER BY l.id)
                  FROM bill_lines l WHERE l."orderId" = o.id), '[]') AS lines,
        coalesce((SELECT json_agg(json_build_object('dedupeKey', s."dedupeKey", 'articleCode', s."articleCode", 'mrp', s.mrp))
                  FROM bill_scans s WHERE s."orderId" = o.id AND s.status = 'active'), '[]') AS boxes,
        -- Money set against this bill now (payments, advance, opening credits), oldest first.
        coalesce((SELECT json_agg(json_build_object('id', x.id, 'amountPaise', x.amt) ORDER BY x."entryDate", x.id) FROM (
                    SELECT c.id, c."entryDate", sum(a."amountPaise") AS amt
                    FROM party_allocations a
                    JOIN party_ledger_entries d ON d.id = a."debitEntryId"
                    JOIN party_ledger_entries c ON c.id = a."creditEntryId"
                    WHERE d."saleBillId" = b.id AND d.kind = 'bill' AND c."saleBillId" IS NULL
                    GROUP BY c.id, c."entryDate" HAVING sum(a."amountPaise") > 0) x), '[]') AS paid
      FROM orders o LEFT JOIN sale_bills b ON b."orderId" = o.id AND b.status = 'active'
      WHERE o.id = ${orderId}
      FOR UPDATE OF o`)).rows[0]
    if (!cur) throw new Error('Order not found.')
    if (cur.status !== 'billed') throw new Error(`Only bills not yet dispatched can be edited (this one is ${cur.status}).`)
    if (!cur.saleBillId) throw new Error('This bill was made before bill amounts were saved. Cancel it and bill again.')
    if (cur.hasDiscount) throw new Error('This bill has an early-payment discount entered against it. Ask the accountant to undo the discount first.')

    // Boxes off: must be on this bill now.
    const onBill = new Map(cur.boxes.map((b) => [b.dedupeKey, b]))
    const removeKeys = [...new Set(removeIn)]
    for (const k of removeKeys) if (!onBill.has(k)) throw new Error('A box you scanned off is no longer on this bill. Close and open the bill again.')
    // Boxes on: valid labels with an MRP, not on this bill already.
    const seen = new Set<string>()
    const adding: BoxLabel[] = []
    for (const raw of addRaw) {
      const l = readBoxLabel(raw)
      if (!l.ok) throw new Error(`A scanned box could not be read: ${l.message}`)
      if (seen.has(l.box.dedupeKey)) continue
      seen.add(l.box.dedupeKey)
      if (l.box.mrp == null) throw new Error(`The box ${l.box.articleCode} has no MRP on its label. Bill it from a new bill with the MRP typed.`)
      if (onBill.has(l.box.dedupeKey) && !removeKeys.includes(l.box.dedupeKey)) throw new Error(`The box ${l.box.articleCode} size ${l.box.sizeLabel} is already on this bill.`)
      adding.push(l.box)
    }
    // A box scanned off and on again in the same edit: no change.
    const back = new Set(adding.filter((b) => removeKeys.includes(b.dedupeKey)).map((b) => b.dedupeKey))
    const added = adding.filter((b) => !back.has(b.dedupeKey))
    const removedKeys = removeKeys.filter((k) => !back.has(k))
    if (!added.length && !removedKeys.length) throw new Error('Nothing changed on this bill.')

    const lineDiscPct = Number(cur.lineDiscPct)
    const lines = applyBoxChanges(
      cur.lines.map((l) => ({ artNumber: l.artNumber, mrp: Number(l.mrp), qty: Number(l.qty), hsn: l.hsn })),
      added.map((b) => ({ dedupeKey: b.dedupeKey, articleCode: b.articleCode, mrp: b.mrp })),
      removedKeys.map((k) => { const b = onBill.get(k)!; return { dedupeKey: k, articleCode: b.articleCode, mrp: b.mrp == null ? null : Number(b.mrp) } }),
    )
    if (!lines.length) throw new Error('Every item would be off this bill. Cancel the bill instead.')

    const plural = (n: number) => `${n} box${n === 1 ? '' : 'es'}`
    const note = `Bill edited: ${[added.length ? `+${plural(added.length)}` : '', removedKeys.length ? `−${plural(removedKeys.length)}` : ''].filter(Boolean).join(' / ')}`

    // Stock: boxes off go back, boxes on go out.
    await releaseOrderScans(tx, actor, orderId, note, removedKeys)
    await insertOrderBoxes(tx, actor, orderId, cur.orderNumber, added)
    const stock = await postOrderScans(tx, actor, orderId, cur.orderNumber)

    // Lines (HSN kept; new lines get theirs from the article).
    await tx.delete(billLines).where(eq(billLines.orderId, orderId))
    await tx.insert(billLines).values(lines.map((l) => ({ orderId, artNumber: l.artNumber, mrp: String(l.mrp), qty: l.qty, hsn: l.hsn ?? null, lineDiscPct: String(lineDiscPct) })))
    await stampBillLineHsn(tx, orderId)

    // Amounts: old bill cancelled (ledger entry reversed, money freed), new one frozen with the same number and date.
    await cancelSaleBill(tx, actor, orderId, note)
    const party: BillParty = cur.retailerId
      ? { retailerId: cur.retailerId, taxType: cur.taxType }
      : { walkIn: { name: cur.customerName, phone: cur.customerPhone, paidMode: cur.paidMode ?? 'cash', discountPct: Number(cur.discountPct) } }
    // Same rates as the old bill (walk-in bills use walkIn.discountPct and ignore rates).
    const bill = await freezeSaleBill(tx, actor, { orderId, source: cur.source, lines, lineDiscPct, party, billDate: cur.billDate, rates: savedRates(cur) })

    // Money that was set against the old bill: against the edited bill again (deferred checks at commit).
    const reattach = cur.retailerId
      ? reattachAmounts(cur.paid.map((p) => ({ id: Number(p.id), amountPaise: Number(p.amountPaise) })), bill.totals.grandTotalPaise)
      : []
    if (reattach.length) {
      await tx.execute(sql`
        INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
        SELECT e."retailerId", e.id, x.id, x."amountPaise", 'auto', ${actor.id}
        FROM party_ledger_entries e, json_to_recordset(${J(reattach)}::json) AS x(id bigint, "amountPaise" bigint)
        WHERE e."saleBillId" = ${bill.saleBillId} AND e.kind = 'bill'`)
    }
    const reattachedPaise = reattach.reduce((s, r) => s + r.amountPaise, 0)

    await tx.update(orders).set({ updatedAt: sql`now()` }).where(eq(orders.id, orderId))
    await audit(tx, {
      actor, action: 'bill.edited', entityType: 'order', entityId: orderId,
      before: { billNo: cur.billNo, grandTotalPaise: Number(cur.grandTotalPaise) },
      after: { billNo: bill.billNo, grandTotalPaise: bill.totals.grandTotalPaise, added: added.length, removed: removedKeys.length, stock, reattachedPaise },
      reason: note,
    })
    return { billNo: bill.billNo, totals: bill.totals, lines, added: added.length, removed: removedKeys.length, stock, reattachedPaise }
  })
}
