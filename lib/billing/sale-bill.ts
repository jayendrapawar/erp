// Frozen sale bills and their ledger entries (owner, 22–23 Nov 2026; migration 0017). Server only.
// docs/architecture/payments.md.
//
// freezeSaleBill runs inside the billing transaction (order invoice and Direct Bill): it works out the
// amounts once (lib/billing/bill-totals.ts), takes the bill number from the right series, and writes
// the sale_bills row and — for a party bill — the 'bill' ledger entry in ONE statement. The printed
// bill, PDF and screens read these amounts; they never change afterwards.
//
// cancelSaleBill runs inside the transaction that sends a bill back, cancels it, or bills the order
// again: the sale_bills row is marked cancelled, money already set against the bill is freed (it
// becomes advance), and every ledger entry of the bill is reversed and knocked off against its
// reversal, so neither shows as open. 3 statements + audit.

import { sql } from 'drizzle-orm'
import type { Actor, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { assignBillNo, billSeriesFor } from './bill-number'
import { bpToPct, computeBillTotals, toBp, type BillTotalsPaise, type TaxType, type TotalsLine } from './bill-totals'

export type { TaxType } from './bill-totals'
export const TAX_TYPES: readonly TaxType[] = ['intra_state', 'inter_state', 'untaxed']
export const isTaxType = (v: unknown): v is TaxType => typeof v === 'string' && (TAX_TYPES as readonly string[]).includes(v)

/** Business date in IST (bills, ledger entries). */
export const IST_TODAY = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`

/** Walk-in customer (owner, 23 Nov 2026): name only, not taxed, pays at once, bill discount typed. */
export interface WalkIn { name: string; phone?: string | null; paidMode: 'cash' | 'upi'; discountPct?: number }

export function cleanWalkIn(w: WalkIn): Required<Omit<WalkIn, 'phone'>> & { phone: string } {
  const name = String(w?.name ?? '').trim().slice(0, 200)
  if (!name) throw new Error('Type the customer\'s name.')
  if (w.paidMode !== 'cash' && w.paidMode !== 'upi') throw new Error('Choose how the customer paid: cash or UPI.')
  const d = Number(w.discountPct ?? 0)
  if (!Number.isFinite(d) || d < 0 || d > 100) throw new Error('Bill discount must be between 0 and 100 %.')
  return { name, phone: String(w.phone ?? '').trim().slice(0, 40), paidMode: w.paidMode, discountPct: Math.round(d * 100) / 100 }
}

export type BillParty = { retailerId: string; taxType: TaxType } | { walkIn: WalkIn }

export interface FreezeInput {
  orderId: number
  source: 'invoice' | 'direct'
  lines: TotalsLine[]
  lineDiscPct: number
  party: BillParty
}

export interface FrozenBill {
  saleBillId: number
  billNo: string
  billDate: string
  taxType: TaxType
  retailerId: string | null
  totals: BillTotalsPaise
}

/** Freeze the bill of an order whose bill_lines are already written. 3 statements + audit. */
export async function freezeSaleBill(tx: Tx, actor: Actor, p: FreezeInput): Promise<FrozenBill> {
  const walk = 'walkIn' in p.party ? cleanWalkIn(p.party.walkIn) : null
  const taxType: TaxType = walk ? 'untaxed' : (p.party as { taxType: TaxType }).taxType
  const retailerId = walk ? null : (p.party as { retailerId: string }).retailerId
  const t = computeBillTotals(p.lines, p.lineDiscPct, taxType, { discountBp: walk ? toBp(walk.discountPct) : undefined })
  if (t.grandTotalPaise <= 0) throw new Error('This bill comes to ₹0. Check the MRPs.')
  const billNo = await assignBillNo(tx, p.orderId, billSeriesFor(taxType))
  // Bill row and its ledger entry together (a walk-in bill has no entry: nothing is owed).
  const row = (await tx.execute<{ id: string; billDate: string }>(sql`
    WITH b AS (
      INSERT INTO sale_bills ("orderId", "retailerId", "customerName", "customerPhone", "paidMode", "billNo", "billDate", source, "taxType",
        "totalQty", "lineDiscPct", "grossPaise", "discountPct", "discountPaise", "taxablePaise",
        "cgstPct", "cgstPaise", "sgstPct", "sgstPaise", "igstPct", "igstPaise", "roundOffPaise", "grandTotalPaise", "createdBy", "createdByName")
      VALUES (${p.orderId}, ${retailerId}, ${walk?.name ?? ''}, ${walk?.phone ?? ''}, ${walk?.paidMode ?? null}, ${billNo}, ${IST_TODAY}, ${p.source}, ${taxType},
        ${t.totalQty}, ${String(p.lineDiscPct)}, ${t.grossPaise}, ${bpToPct(t.discountBp)}, ${t.discountPaise}, ${t.taxablePaise},
        ${bpToPct(t.cgstBp)}, ${t.cgstPaise}, ${bpToPct(t.sgstBp)}, ${t.sgstPaise}, ${bpToPct(t.igstBp)}, ${t.igstPaise}, ${t.roundOffPaise}, ${t.grandTotalPaise},
        ${actor.id}, ${actor.name})
      RETURNING id, "retailerId", "billNo", "billDate", "grandTotalPaise"
    ), e AS (
      INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "saleBillId", "refNo", "idempotencyKey", "createdBy", "createdByName")
      SELECT "retailerId", 'bill', "grandTotalPaise", "billDate", id, "billNo", 'sale_bill:' || id, ${actor.id}, ${actor.name}
      FROM b WHERE "retailerId" IS NOT NULL
    )
    SELECT id, "billDate"::text AS "billDate" FROM b`)).rows[0]
  const saleBillId = Number(row.id)
  await audit(tx, {
    actor, action: 'sale_bill.created', entityType: 'order', entityId: p.orderId,
    after: { saleBillId, billNo, taxType, retailerId, customerName: walk?.name, grandTotalPaise: t.grandTotalPaise, roundOffPaise: t.roundOffPaise },
  })
  return { saleBillId, billNo, billDate: row.billDate, taxType, retailerId, totals: t }
}

/**
 * Cancel the order's active sale bill, if it has one (bills made before migration 0017 have none).
 * Payments set against it become advance; its ledger entries are reversed. Returns the bill number.
 */
export async function cancelSaleBill(tx: Tx, actor: Actor, orderId: number, reason: string): Promise<{ saleBillId: number; billNo: string } | null> {
  const why = String(reason ?? '').trim().slice(0, 500)
  if (!why) throw new Error('A reason is needed to cancel a bill.')
  const b = (await tx.execute<{ id: string; billNo: string; retailerId: string | null; grandTotalPaise: string }>(sql`
    UPDATE sale_bills SET status = 'cancelled', "cancelledAt" = now(), "cancelledBy" = ${actor.id}, "cancelReason" = ${why}
    WHERE "orderId" = ${orderId} AND status = 'active'
    RETURNING id, "billNo", "retailerId", "grandTotalPaise"`)).rows[0]
  if (!b) return null
  const saleBillId = Number(b.id)
  if (b.retailerId) {
    // 1. Undo every live allocation touching an entry of this bill (the money becomes free again).
    await tx.execute(sql`
      INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", "reversalOfId", method, "createdBy")
      SELECT a."retailerId", a."debitEntryId", a."creditEntryId", -a."amountPaise", a.id, 'reversal', ${actor.id}
      FROM party_allocations a
      WHERE a."reversalOfId" IS NULL
        AND EXISTS (SELECT 1 FROM party_ledger_entries e WHERE e."saleBillId" = ${saleBillId} AND e.id IN (a."debitEntryId", a."creditEntryId"))
        AND NOT EXISTS (SELECT 1 FROM party_allocations r WHERE r."reversalOfId" = a.id)`)
    // 2. Reverse each entry of the bill (the bill, any discount on it) and knock it off against its reversal.
    await tx.execute(sql`
      WITH r AS (
        INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "reversalOfId", "refNo", reason, "idempotencyKey", "createdBy", "createdByName")
        SELECT e."retailerId", 'reversal', -e."amountPaise", ${IST_TODAY}, e.id, e."refNo", ${`Bill cancelled: ${why}`}, 'reversal:' || e.id, ${actor.id}, ${actor.name}
        FROM party_ledger_entries e
        WHERE e."saleBillId" = ${saleBillId} AND NOT EXISTS (SELECT 1 FROM party_ledger_entries x WHERE x."reversalOfId" = e.id)
        RETURNING id, "retailerId", "reversalOfId", "amountPaise"
      )
      INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
      SELECT "retailerId",
             CASE WHEN "amountPaise" > 0 THEN id ELSE "reversalOfId" END,
             CASE WHEN "amountPaise" < 0 THEN id ELSE "reversalOfId" END,
             abs("amountPaise"), 'auto', ${actor.id}
      FROM r`)
  }
  await audit(tx, {
    actor, action: 'sale_bill.cancelled', entityType: 'order', entityId: orderId,
    after: { saleBillId, billNo: b.billNo, retailerId: b.retailerId, grandTotalPaise: Number(b.grandTotalPaise) }, reason: why,
  })
  return { saleBillId, billNo: b.billNo }
}

/** The party an order is billed to: its retailer, else an exact name match. 1 query (caller locks the order). */
export async function billingPartyFor(tx: Tx, orderId: number): Promise<{ orderNumber: string; status: string; shopkeeperName: string; isEmergency: boolean; retailerId: string | null; taxType: TaxType | null } | null> {
  const r = (await tx.execute<{ orderNumber: string; status: string; shopkeeperName: string; isEmergency: boolean; retailerId: string | null; taxType: TaxType | null }>(sql`
    SELECT o."orderNumber", o.status, o."shopkeeperName", o."isEmergency", r.id AS "retailerId", r."taxType"
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT x.id, x."taxType" FROM retailers x
      WHERE x.id = o."retailerId" OR (o."retailerId" IS NULL AND lower(btrim(x."partyName")) = lower(btrim(o."shopkeeperName")))
      ORDER BY (x.id = o."retailerId") DESC LIMIT 1
    ) r ON true
    WHERE o.id = ${orderId}
    FOR UPDATE OF o`)).rows[0]
  return r ?? null
}

export function notInMasterMessage(name: string): string {
  return `"${name}" is not in the retailer master. Add the party in Master → Retailers (or pick it from the list), then bill.`
}
