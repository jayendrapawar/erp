// Money received from retailers (payments step 4; owner decisions 22–23 Nov 2026; migration 0017).
// Server only. Model: ERPNext's Payment Ledger — a payment is a ledger credit, set against bills
// through allocations; nothing is ever edited or deleted (a mistake is a reversal row).
//
//   recordPayment   cash / UPI / bank: counted at once — ledger credit, early-payment discounts
//                   (each against its bill), then the payment set against bills (as typed, else
//                   oldest first); the rest is advance. A cheque is only "received" (pending, not
//                   counted, no ledger entry) until it is deposited. The browser's clientId makes a
//                   retry or double tap record once. ~7 statements + audit, one transaction.
//   depositCheque   pending cheque → counted on its deposit date (same posting as above).
//   returnCheque    pending cheque given back / torn up → never counted.
//   bouncePayment   deposited cheque bounced → its ledger rows reversed (bills unpaid again) and an
//                   optional bounce charge.
//   reversePayment  recorded by mistake → its ledger rows reversed, with a reason.
//   applyAdvance    a new bill takes the party's advance, oldest first (owner: advance is applied to
//                   the next bill). Called by the billing actions, not by freezeSaleBill (Edit bill
//                   re-attaches its own payments).
//
// Every write locks the party's retailers row first, so two writes for one party never set the
// same money twice (the deferred allocation check would refuse it anyway, at commit).

import { sql } from 'drizzle-orm'
import type { Actor, DbOrTx, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { slipForDay, type SlipInto } from './slips'

export const PAY_MODES = ['cash', 'upi', 'cheque', 'bank'] as const
export type PayMode = (typeof PAY_MODES)[number]

export interface AllocationInput { entryId: number; amountPaise: number }
export interface DiscountInput { saleBillId: number; amountPaise: number }

export interface PaymentInput {
  clientId: string
  retailerId: string
  /** Day the money / cheque was handed over (YYYY-MM-DD). */
  receivedOn: string
  mode: PayMode
  amountPaise: number
  chequeNo?: string
  chequeBank?: string
  chequeDate?: string
  /** UPI reference / NEFT-RTGS UTR. */
  reference?: string
  note?: string
  /** Set against these bills (debit entries); empty / missing = oldest first. Counted payments only. */
  allocations?: AllocationInput[]
  /** Early-payment discounts, each against its bill. Counted payments only. */
  discounts?: DiscountInput[]
  /**
   * Into cash or a bank (owner, 24 Nov 2026): the payment goes on that day's cash / bank slip and is
   * counted at once (a cheque on a bank slip is a deposited cheque). Receipt no. = slip no. + line.
   */
  into?: SlipInto
}

export interface PartySummary { retailerId: string; balancePaise: number; unpaidPaise: number; advancePaise: number }

export interface RecordedPayment {
  paymentId: number
  receiptNo: string
  status: 'pending' | 'active'
  amountPaise: number
  /** Set against bills (counted payments). */
  allocatedPaise: number
  discountPaise: number
  /** True when this clientId was already recorded (a retry): nothing new was written. */
  repeated: boolean
  party: PartySummary
  /** The slip it went on (payments "into" cash / a bank). */
  slipNo?: string
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_PAISE = 1_000_000_000_00 // ₹1,000 crore: a typo guard
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const J = (v: unknown) => JSON.stringify(v)

function amount(v: unknown, label: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0 || n > MAX_PAISE) throw new Error(`${label} must be more than ₹0.`)
  return n
}
function day(v: unknown, label: string): string {
  const s = String(v ?? '').trim()
  if (!DATE.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`${label}: choose a date.`)
  return s
}
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)

function cleanList<T extends { amountPaise: number }>(raw: unknown, key: 'entryId' | 'saleBillId', label: string): (T & Record<typeof key, number>)[] {
  if (raw == null) return []
  if (!Array.isArray(raw) || raw.length > 500) throw new Error(`${label}: bad list.`)
  const seen = new Set<number>()
  return raw.map((x) => {
    const id = Number((x as Record<string, unknown>)?.[key])
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) throw new Error(`${label}: bad or repeated bill.`)
    seen.add(id)
    return { [key]: id, amountPaise: amount((x as Record<string, unknown>).amountPaise, label) } as T & Record<typeof key, number>
  })
}

/** Checks and tidies what the screen sent. Throws a message for the user. */
export function cleanPaymentInput(raw: unknown): PaymentInput {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const clientId = text(r.clientId, 40)
  if (!UUID.test(clientId)) throw new Error('Bad request: missing payment id. Reload the page.')
  const retailerId = text(r.retailerId, 64)
  if (!retailerId) throw new Error('Choose the party.')
  const mode = r.mode as PayMode
  if (!PAY_MODES.includes(mode)) throw new Error('Choose how it was paid: cash, UPI, cheque or bank.')
  const out: PaymentInput = {
    clientId, retailerId, mode,
    receivedOn: day(r.receivedOn, 'Received on'),
    amountPaise: amount(r.amountPaise, 'Amount'),
    reference: text(r.reference, 80),
    note: text(r.note, 300),
    allocations: cleanList<AllocationInput>(r.allocations, 'entryId', 'Set against'),
    discounts: cleanList<DiscountInput>(r.discounts, 'saleBillId', 'Discount'),
  }
  const into = r.into as Record<string, unknown> | undefined
  if (into != null) {
    if (into.kind === 'cash') out.into = { kind: 'cash' }
    else if (into.kind === 'bank' && Number.isInteger(Number(into.bankAccountId)) && Number(into.bankAccountId) > 0) out.into = { kind: 'bank', bankAccountId: Number(into.bankAccountId) }
    else throw new Error('Choose cash or a bank.')
    if (out.into.kind === 'cash' && mode !== 'cash') throw new Error('A cash slip takes cash only.')
    if (out.into.kind === 'bank' && mode === 'cash') throw new Error('Choose UPI, bank transfer or cheque for a bank slip.')
  }
  if (mode === 'cheque') {
    out.chequeNo = text(r.chequeNo, 20)
    out.chequeBank = text(r.chequeBank, 60)
    if (!out.chequeNo) throw new Error('Type the cheque number.')
    if (out.into) {
      // A cheque on a bank slip is a deposited cheque: its bank and date are optional.
      if (r.chequeDate) out.chequeDate = day(r.chequeDate, 'Cheque date')
    } else {
      out.chequeDate = day(r.chequeDate, 'Cheque date')
      if (!out.chequeBank) throw new Error('Type the cheque\'s bank.')
    }
  }
  const set = (out.allocations ?? []).reduce((s, a) => s + a.amountPaise, 0)
  if (set > out.amountPaise) throw new Error('More is set against bills than the amount received.')
  return out
}

// ── Shared steps ──────────────────────────────────────────────────────────────

/** Lock the party (serialises its allocations). 1 statement. */
export async function lockParty(tx: Tx, retailerId: string): Promise<{ id: string; partyName: string }> {
  const r = (await tx.execute<{ id: string; partyName: string }>(sql`
    SELECT id, "partyName" FROM retailers WHERE id = ${retailerId} FOR UPDATE`)).rows[0]
  if (!r) throw new Error('This party is not in the retailer master.')
  return r
}

/** Balance, unpaid bills and advance of one party. 1 query. */
export async function partySummary(db: DbOrTx, retailerId: string): Promise<PartySummary> {
  const r = (await db.execute<{ balance: string; unpaid: string; advance: string }>(sql`
    SELECT coalesce((SELECT "balancePaise" FROM party_balances WHERE "retailerId" = ${retailerId}), 0) AS balance,
           coalesce(sum("openPaise") FILTER (WHERE side = 'debit'), 0) AS unpaid,
           coalesce(sum("openPaise") FILTER (WHERE side = 'credit'), 0) AS advance
    FROM party_open_items WHERE "retailerId" = ${retailerId}`)).rows[0]
  return { retailerId, balancePaise: Number(r?.balance ?? 0), unpaidPaise: Number(r?.unpaid ?? 0), advancePaise: Number(r?.advance ?? 0) }
}

/**
 * Set a credit entry (payment, discount, negative opening) against the party's debits: as typed, else
 * oldest first. Returns the paise set. 1–2 statements. The party must be locked.
 */
export async function allocateCredit(tx: Tx, actor: Actor, retailerId: string, creditEntryId: number, creditPaise: number, manual: AllocationInput[] = []): Promise<number> {
  if (manual.length) {
    const open = new Map((await tx.execute<{ id: string; openPaise: string }>(sql`
      SELECT id, "openPaise" FROM party_open_items
      WHERE "retailerId" = ${retailerId} AND side = 'debit' AND id IN (SELECT (x)::bigint FROM json_array_elements_text(${J(manual.map((m) => m.entryId))}::json) x)`)).rows
      .map((r) => [Number(r.id), Number(r.openPaise)]))
    let total = 0
    for (const m of manual) {
      const o = open.get(m.entryId)
      if (o === undefined) throw new Error('A bill chosen is not unpaid any more. Reload the party.')
      if (m.amountPaise > o) throw new Error(`More is set against a bill than is unpaid on it (₹${(o / 100).toFixed(2)}).`)
      total += m.amountPaise
    }
    if (total > creditPaise) throw new Error('More is set against bills than the amount received.')
    await tx.execute(sql`
      INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
      SELECT ${retailerId}, x."entryId", ${creditEntryId}, x."amountPaise", 'manual', ${actor.id}
      FROM json_to_recordset(${J(manual)}::json) AS x("entryId" bigint, "amountPaise" bigint)`)
    return total
  }
  // Oldest first (by bill date, then entry): each debit takes what is left of the credit.
  const rows = (await tx.execute<{ amountPaise: string }>(sql`
    WITH d AS (
      SELECT id, "openPaise", sum("openPaise") OVER (ORDER BY "entryDate", id) AS run
      FROM party_open_items WHERE "retailerId" = ${retailerId} AND side = 'debit'
    )
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
    SELECT ${retailerId}, id, ${creditEntryId}, LEAST("openPaise", ${creditPaise}::bigint - (run - "openPaise")), 'auto', ${actor.id}
    FROM d WHERE run - "openPaise" < ${creditPaise}::bigint
    RETURNING "amountPaise"`)).rows
  return rows.reduce((s, r) => s + Number(r.amountPaise), 0)
}

/**
 * Post a counted payment: discounts first (each against its bill), then the payment set against bills.
 * 2–5 statements. The party must be locked.
 */
async function postCounted(
  tx: Tx, actor: Actor,
  p: { id: number; retailerId: string; receiptNo: string; amountPaise: number; countedOn: string },
  allocations: AllocationInput[], discounts: DiscountInput[],
): Promise<{ allocatedPaise: number; discountPaise: number }> {
  let discountPaise = 0
  if (discounts.length) {
    const bills = new Map((await tx.execute<{ saleBillId: string; billNo: string; entryId: string; openPaise: string }>(sql`
      SELECT s.id AS "saleBillId", s."billNo", e.id AS "entryId", oi."openPaise"
      FROM sale_bills s
      JOIN party_ledger_entries e ON e."saleBillId" = s.id AND e.kind = 'bill'
      JOIN party_open_items oi ON oi.id = e.id
      WHERE s.status = 'active' AND s."retailerId" = ${p.retailerId}
        AND s.id IN (SELECT (x)::bigint FROM json_array_elements_text(${J(discounts.map((d) => d.saleBillId))}::json) x)`)).rows
      .map((r) => [Number(r.saleBillId), { billNo: r.billNo, entryId: Number(r.entryId), open: Number(r.openPaise) }]))
    const rows = discounts.map((d) => {
      const b = bills.get(d.saleBillId)
      if (!b) throw new Error('A bill given a discount is not unpaid any more. Reload the party.')
      if (d.amountPaise > b.open) throw new Error(`The discount on bill ${b.billNo} is more than is unpaid on it.`)
      discountPaise += d.amountPaise
      return { saleBillId: d.saleBillId, billNo: b.billNo, entryId: b.entryId, amountPaise: d.amountPaise }
    })
    // Discount entries and their allocations to the bills, in one statement.
    await tx.execute(sql`
      WITH x AS (SELECT * FROM json_to_recordset(${J(rows)}::json) AS x("saleBillId" bigint, "billNo" text, "entryId" bigint, "amountPaise" bigint)),
      d AS (
        INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "saleBillId", "paymentId", "refNo", note, "idempotencyKey", "createdBy", "createdByName")
        SELECT ${p.retailerId}, 'discount', -x."amountPaise", ${p.countedOn}::date, x."saleBillId", ${p.id}, x."billNo",
               ${`Early-payment discount, receipt ${p.receiptNo}`}, 'discount:' || ${p.id} || ':' || x."saleBillId", ${actor.id}, ${actor.name}
        FROM x
        RETURNING id, "saleBillId", "amountPaise"
      )
      INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
      SELECT ${p.retailerId}, x."entryId", d.id, -d."amountPaise", 'manual', ${actor.id}
      FROM d JOIN x ON x."saleBillId" = d."saleBillId"`)
  }
  const entry = (await tx.execute<{ id: string }>(sql`
    INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "paymentId", "refNo", "idempotencyKey", "createdBy", "createdByName")
    VALUES (${p.retailerId}, 'payment', ${-p.amountPaise}, ${p.countedOn}::date, ${p.id}, ${p.receiptNo}, ${`payment:${p.id}`}, ${actor.id}, ${actor.name})
    RETURNING id`)).rows[0]
  const allocatedPaise = await allocateCredit(tx, actor, p.retailerId, Number(entry.id), p.amountPaise, allocations)
  return { allocatedPaise, discountPaise }
}

/** Undo every ledger row of a payment (payment + its discounts): allocations undone, rows reversed. 2 statements. */
async function reversePaymentEntries(tx: Tx, actor: Actor, paymentId: number, reason: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", "reversalOfId", method, "createdBy")
    SELECT a."retailerId", a."debitEntryId", a."creditEntryId", -a."amountPaise", a.id, 'reversal', ${actor.id}
    FROM party_allocations a
    WHERE a."reversalOfId" IS NULL
      AND EXISTS (SELECT 1 FROM party_ledger_entries e WHERE e."paymentId" = ${paymentId} AND e.kind IN ('payment', 'discount') AND e.id IN (a."debitEntryId", a."creditEntryId"))
      AND NOT EXISTS (SELECT 1 FROM party_allocations r WHERE r."reversalOfId" = a.id)`)
  await tx.execute(sql`
    WITH r AS (
      INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "reversalOfId", "refNo", reason, "idempotencyKey", "createdBy", "createdByName")
      SELECT e."retailerId", 'reversal', -e."amountPaise", (now() AT TIME ZONE 'Asia/Kolkata')::date, e.id, e."refNo", ${reason}, 'reversal:' || e.id, ${actor.id}, ${actor.name}
      FROM party_ledger_entries e
      WHERE e."paymentId" = ${paymentId} AND e.kind IN ('payment', 'discount')
        AND NOT EXISTS (SELECT 1 FROM party_ledger_entries x WHERE x."reversalOfId" = e.id)
      RETURNING id, "retailerId", "reversalOfId", "amountPaise"
    )
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
    SELECT "retailerId",
           CASE WHEN "amountPaise" > 0 THEN id ELSE "reversalOfId" END,
           CASE WHEN "amountPaise" < 0 THEN id ELSE "reversalOfId" END,
           abs("amountPaise"), 'auto', ${actor.id}
    FROM r`)
}

type PaymentRow = { id: string; receiptNo: string; retailerId: string; status: string; mode: PayMode; amountPaise: string; receivedOn: string }

/** The payment, locked. 1 statement. */
async function lockPayment(tx: Tx, paymentId: number): Promise<PaymentRow> {
  const p = (await tx.execute<PaymentRow>(sql`
    SELECT id, "receiptNo", "retailerId", status, mode, "amountPaise", "receivedOn"::text AS "receivedOn"
    FROM payments WHERE id = ${paymentId} FOR UPDATE`)).rows[0]
  if (!p) throw new Error('Payment not found.')
  return p
}

function reasonText(v: unknown): string {
  const why = text(v, 500)
  if (!why) throw new Error('Type the reason.')
  return why
}

// ── Actions ───────────────────────────────────────────────────────────────────

export async function recordPayment(tx: Tx, actor: Actor, raw: unknown): Promise<RecordedPayment> {
  const p = cleanPaymentInput(raw)
  const party = await lockParty(tx, p.retailerId)
  // A retry of the same screen action (same clientId) records nothing new.
  const prev = (await tx.execute<{ id: string; receiptNo: string; retailerId: string; status: 'pending' | 'active'; amountPaise: string }>(sql`
    SELECT id, "receiptNo", "retailerId", status, "amountPaise" FROM payments WHERE "clientId" = ${p.clientId}`)).rows[0]
  if (prev) {
    if (prev.retailerId !== p.retailerId || Number(prev.amountPaise) !== p.amountPaise) throw new Error('This payment form was already used for another payment. Reload the page.')
    return { paymentId: Number(prev.id), receiptNo: prev.receiptNo, status: prev.status, amountPaise: p.amountPaise, allocatedPaise: 0, discountPaise: 0, repeated: true, party: await partySummary(tx, p.retailerId) }
  }
  // A cheque in hand waits (pending) until deposited; a cheque on a bank slip is deposited already.
  const cheque = p.mode === 'cheque' && !p.into
  if (cheque && (p.allocations?.length || p.discounts?.length)) throw new Error('A cheque is set against bills when it is deposited.')
  let receiptNo: string, slip: { id: number; slipNo: string } | null = null
  if (p.into) {
    slip = await slipForDay(tx, actor, p.into, p.receivedOn)
    const n = Number((await tx.execute<{ n: string }>(sql`SELECT count(*) AS n FROM payments WHERE "slipId" = ${slip.id}`)).rows[0].n) + 1
    receiptNo = `${slip.slipNo}-${n}`
  } else {
    const seq = (await tx.execute<{ prefix: string; n: string; padding: number }>(sql`
      UPDATE document_sequences SET next = next + 1 WHERE name = 'payment_receipt' RETURNING prefix, next - 1 AS n, padding`)).rows[0]
    if (!seq) throw new Error('Receipt numbering is not set up (document_sequences).')
    receiptNo = `${seq.prefix}${String(seq.n).padStart(seq.padding, '0')}`
  }
  const row = (await tx.execute<{ id: string }>(sql`
    INSERT INTO payments ("clientId", "receiptNo", "retailerId", "receivedOn", "countedOn", mode, "amountPaise", "chequeNo", "chequeBank", "chequeDate",
      reference, note, status, "countedBy", "countedByName", "createdBy", "createdByName", "slipId", "bankAccountId")
    VALUES (${p.clientId}, ${receiptNo}, ${p.retailerId}, ${p.receivedOn}::date, ${cheque ? null : p.receivedOn}::date, ${p.mode}, ${p.amountPaise},
      ${p.chequeNo ?? ''}, ${p.chequeBank ?? ''}, ${p.chequeDate ?? null}::date, ${p.reference ?? ''}, ${p.note ?? ''},
      ${cheque ? 'pending' : 'active'}, ${cheque ? null : actor.id}, ${cheque ? '' : actor.name}, ${actor.id}, ${actor.name},
      ${slip?.id ?? null}, ${p.into?.kind === 'bank' ? p.into.bankAccountId : null})
    RETURNING id`)).rows[0]
  const paymentId = Number(row.id)
  const posted = cheque
    ? { allocatedPaise: 0, discountPaise: 0 }
    : await postCounted(tx, actor, { id: paymentId, retailerId: p.retailerId, receiptNo, amountPaise: p.amountPaise, countedOn: p.receivedOn }, p.allocations ?? [], p.discounts ?? [])
  await audit(tx, {
    actor, action: 'payment.recorded', entityType: 'payment', entityId: paymentId,
    after: { receiptNo, slipNo: slip?.slipNo, retailerId: p.retailerId, partyName: party.partyName, mode: p.mode, amountPaise: p.amountPaise, status: cheque ? 'pending' : 'active', ...posted },
  })
  return { paymentId, receiptNo, status: cheque ? 'pending' : 'active', amountPaise: p.amountPaise, ...posted, repeated: false, party: await partySummary(tx, p.retailerId), slipNo: slip?.slipNo }
}

/** A cheque in hand is deposited: counted from the deposit date and set against bills. */
export async function depositCheque(
  tx: Tx, actor: Actor, paymentId: number, depositDate: string, allocations: unknown = [], discounts: unknown = [],
): Promise<{ receiptNo: string; allocatedPaise: number; discountPaise: number; party: PartySummary }> {
  const p = await lockPayment(tx, paymentId)
  if (p.status !== 'pending' || p.mode !== 'cheque') throw new Error(`Receipt ${p.receiptNo} is not a cheque waiting to be deposited.`)
  const on = day(depositDate, 'Deposit date')
  if (on < p.receivedOn) throw new Error('The deposit date cannot be before the cheque was received.')
  const allocs = cleanList<AllocationInput>(allocations, 'entryId', 'Set against')
  const discs = cleanList<DiscountInput>(discounts, 'saleBillId', 'Discount')
  await lockParty(tx, p.retailerId)
  await tx.execute(sql`UPDATE payments SET status = 'active', "countedOn" = ${on}::date, "countedBy" = ${actor.id}, "countedByName" = ${actor.name} WHERE id = ${paymentId}`)
  const posted = await postCounted(tx, actor, { id: paymentId, retailerId: p.retailerId, receiptNo: p.receiptNo, amountPaise: Number(p.amountPaise), countedOn: on }, allocs, discs)
  await audit(tx, { actor, action: 'payment.cheque_deposited', entityType: 'payment', entityId: paymentId, after: { receiptNo: p.receiptNo, depositDate: on, ...posted } })
  return { receiptNo: p.receiptNo, ...posted, party: await partySummary(tx, p.retailerId) }
}

/** A cheque in hand is given back / torn up: never counted. */
export async function returnCheque(tx: Tx, actor: Actor, paymentId: number, reason: unknown): Promise<{ receiptNo: string }> {
  const why = reasonText(reason)
  const p = await lockPayment(tx, paymentId)
  if (p.status !== 'pending') throw new Error(`Receipt ${p.receiptNo} is not a cheque waiting to be deposited.`)
  await tx.execute(sql`UPDATE payments SET status = 'returned', "reversedAt" = now(), "reversedBy" = ${actor.id}, "reversedByName" = ${actor.name}, "reversalReason" = ${why} WHERE id = ${paymentId}`)
  await audit(tx, { actor, action: 'payment.cheque_returned', entityType: 'payment', entityId: paymentId, after: { receiptNo: p.receiptNo }, reason: why })
  return { receiptNo: p.receiptNo }
}

/** A deposited cheque bounced: its money comes off (bills unpaid again), plus an optional bounce charge. */
export async function bouncePayment(tx: Tx, actor: Actor, paymentId: number, reason: unknown, chargePaise = 0): Promise<{ receiptNo: string; party: PartySummary }> {
  const why = reasonText(reason)
  const charge = chargePaise ? amount(chargePaise, 'Bounce charge') : 0
  const p = await lockPayment(tx, paymentId)
  if (p.status !== 'active' || p.mode !== 'cheque') throw new Error(`Receipt ${p.receiptNo} is not a deposited cheque.`)
  await lockParty(tx, p.retailerId)
  await tx.execute(sql`UPDATE payments SET status = 'bounced', "reversedAt" = now(), "reversedBy" = ${actor.id}, "reversedByName" = ${actor.name}, "reversalReason" = ${why} WHERE id = ${paymentId}`)
  await reversePaymentEntries(tx, actor, paymentId, `Cheque bounced: ${why}`)
  if (charge) {
    await tx.execute(sql`
      INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "refNo", reason, "idempotencyKey", "createdBy", "createdByName")
      VALUES (${p.retailerId}, 'charge', ${charge}, (now() AT TIME ZONE 'Asia/Kolkata')::date, ${p.receiptNo}, ${`Cheque bounce charge: ${why}`}, ${`bounce-charge:${paymentId}`}, ${actor.id}, ${actor.name})`)
  }
  await audit(tx, { actor, action: 'payment.cheque_bounced', entityType: 'payment', entityId: paymentId, after: { receiptNo: p.receiptNo, chargePaise: charge }, reason: why })
  return { receiptNo: p.receiptNo, party: await partySummary(tx, p.retailerId) }
}

/** A counted payment recorded by mistake: its ledger rows are reversed (a pending cheque: returnCheque). */
export async function reversePayment(tx: Tx, actor: Actor, paymentId: number, reason: unknown): Promise<{ receiptNo: string; party: PartySummary }> {
  const why = reasonText(reason)
  const p = await lockPayment(tx, paymentId)
  if (p.status === 'pending') throw new Error(`Receipt ${p.receiptNo} is a cheque not yet deposited: mark it returned instead.`)
  if (p.status !== 'active') throw new Error(`Receipt ${p.receiptNo} is already ${p.status}.`)
  await lockParty(tx, p.retailerId)
  await tx.execute(sql`UPDATE payments SET status = 'reversed', "reversedAt" = now(), "reversedBy" = ${actor.id}, "reversedByName" = ${actor.name}, "reversalReason" = ${why} WHERE id = ${paymentId}`)
  await reversePaymentEntries(tx, actor, paymentId, `Payment reversed: ${why}`)
  await audit(tx, { actor, action: 'payment.reversed', entityType: 'payment', entityId: paymentId, after: { receiptNo: p.receiptNo }, reason: why })
  return { receiptNo: p.receiptNo, party: await partySummary(tx, p.retailerId) }
}

/**
 * A new bill takes the party's advance (unused credits), oldest first. Returns the paise set.
 * 2 statements (lock + one insert); nothing when the party has no advance.
 */
export async function applyAdvance(tx: Tx, actor: Actor, retailerId: string, saleBillId: number): Promise<number> {
  await lockParty(tx, retailerId)
  const rows = (await tx.execute<{ amountPaise: string }>(sql`
    WITH b AS (
      SELECT oi.id, oi."openPaise" FROM party_open_items oi
      JOIN party_ledger_entries e ON e.id = oi.id
      WHERE e."saleBillId" = ${saleBillId} AND e.kind = 'bill' AND oi.side = 'debit'
    ), c AS (
      SELECT id, "openPaise", sum("openPaise") OVER (ORDER BY "entryDate", id) AS run
      FROM party_open_items WHERE "retailerId" = ${retailerId} AND side = 'credit'
    )
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
    SELECT ${retailerId}, b.id, c.id, LEAST(c."openPaise", b."openPaise" - (c.run - c."openPaise")), 'auto', ${actor.id}
    FROM b, c WHERE c.run - c."openPaise" < b."openPaise"
    RETURNING "amountPaise"`)).rows
  return rows.reduce((s, r) => s + Number(r.amountPaise), 0)
}

// ── Read: the party on the Record payment screen ─────────────────────────────

export interface OpenDebit {
  entryId: number
  kind: 'bill' | 'opening' | 'charge' | 'adjustment'
  refNo: string
  entryDate: string
  amountPaise: number
  openPaise: number
  /** Bills only: for the early-payment discount. */
  saleBillId: number | null
  taxablePaise: number | null
}

export interface PartyForPayment extends PartySummary {
  partyName: string
  earlyPayDiscountBp: number | null
  earlyPayDays: number | null
  /** Unpaid bills and other debits, oldest first. */
  open: OpenDebit[]
}

/** Party, its balance and its unpaid items. 1 query. */
export async function loadPartyForPayment(db: DbOrTx, retailerId: string): Promise<PartyForPayment | null> {
  const r = (await db.execute<{
    partyName: string; earlyPayDiscountBp: number | null; earlyPayDays: number | null; balance: string
    open: Array<{ entryId: number; kind: OpenDebit['kind']; refNo: string; entryDate: string; amountPaise: number; openPaise: number; saleBillId: number | null; taxablePaise: number | null }>
  }>(sql`
    SELECT r."partyName", r."earlyPayDiscountBp", r."earlyPayDays",
      coalesce((SELECT "balancePaise" FROM party_balances WHERE "retailerId" = r.id), 0) AS balance,
      coalesce((SELECT json_agg(json_build_object('entryId', oi.id, 'kind', oi.kind, 'refNo', oi."refNo", 'entryDate', oi."entryDate",
          'amountPaise', oi."amountPaise", 'openPaise', oi."openPaise", 'saleBillId', oi."saleBillId", 'taxablePaise', s."taxablePaise",
          'side', oi.side) ORDER BY oi."entryDate", oi.id)
        FROM party_open_items oi LEFT JOIN sale_bills s ON s.id = oi."saleBillId"
        WHERE oi."retailerId" = r.id), '[]') AS open
    FROM retailers r WHERE r.id = ${retailerId}`)).rows[0]
  if (!r) return null
  const items = r.open as Array<OpenDebit & { side: 'debit' | 'credit' }>
  const debits = items.filter((i) => i.side === 'debit')
  return {
    retailerId, partyName: r.partyName, earlyPayDiscountBp: r.earlyPayDiscountBp, earlyPayDays: r.earlyPayDays,
    balancePaise: Number(r.balance),
    unpaidPaise: debits.reduce((s, i) => s + Number(i.openPaise), 0),
    advancePaise: items.filter((i) => i.side === 'credit').reduce((s, i) => s + Number(i.openPaise), 0),
    open: debits.map((i) => ({
      entryId: Number(i.entryId), kind: i.kind, refNo: i.refNo, entryDate: String(i.entryDate).slice(0, 10),
      amountPaise: Number(i.amountPaise), openPaise: Number(i.openPaise),
      saleBillId: i.saleBillId == null ? null : Number(i.saleBillId), taxablePaise: i.taxablePaise == null ? null : Number(i.taxablePaise),
    })),
  }
}
