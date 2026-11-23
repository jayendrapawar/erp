// Billing writes frozen amounts and the party ledger (migration 0017, step 2 of payments).
// docs/architecture/payments.md.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { createDraft, generateDirectBill } from '../../lib/billing/bill-stock'
import { billingPartyFor, cancelSaleBill, freezeSaleBill } from '../../lib/billing/sale-bill'
import { computeBillTotals } from '../../lib/billing/bill-totals'
import type { Actor } from '../../lib/db/types'

describe('sale bills and the party ledger (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  let n = 0
  const biller: Actor = { id: 'u-biller', name: 'Biller' }
  const lines = [{ artNumber: 'PUG-1', mrp: 339.5, qty: 20 }, { artNumber: 'FL-20', mrp: 239.5, qty: 6 }, { artNumber: 'X', mrp: 160, qty: 5 }]
  const q = async <T = Record<string, unknown>>(s: ReturnType<typeof sql>) => (await h.db.execute(s)).rows as T[]
  const num = async (s: ReturnType<typeof sql>) => Number(Object.values((await q(s))[0] ?? { x: 0 })[0])
  const balance = (r: string) => num(sql`SELECT coalesce((SELECT "balancePaise" FROM party_balances WHERE "retailerId" = ${r}), 0)`)
  const open = (r: string) => q<{ side: string; kind: string; openPaise: string }>(sql`SELECT side, kind, "openPaise" FROM party_open_items WHERE "retailerId" = ${r} ORDER BY id`)
  /** Drizzle wraps the database error; match the database message. */
  const dbError = (re: RegExp) => (e: Error) => re.test(String((e as { cause?: Error }).cause?.message ?? e.message))
  const healthy = async () => {
    assert.equal(await num(sql`SELECT count(*) FROM party_balance_mismatches`), 0, 'balance = sum of entries')
    assert.equal(await num(sql`SELECT count(*) FROM party_open_item_mismatches`), 0, 'unpaid − advance = balance')
  }
  const order = async (shop: string, retailerId: string | null = null) => Number((await q<{ id: number }>(sql`
    INSERT INTO orders ("orderNumber", "shopkeeperName", "retailerId", status) VALUES (${`ORD-S-${++n}`}, ${shop}, ${retailerId}, 'packed') RETURNING id`))[0].id)
  const withLines = async (orderId: number) => {
    await h.db.execute(sql`INSERT INTO bill_lines ("orderId", "artNumber", mrp, qty, "lineDiscPct")
      SELECT ${orderId}, x.a, x.m, x.q, 30 FROM json_to_recordset(${JSON.stringify(lines.map((l) => ({ a: l.artNumber, m: l.mrp, q: l.qty })))}::json) AS x(a text, m numeric, q int)`)
    return orderId
  }
  const freeze = (orderId: number, retailerId: string, taxType: 'intra_state' | 'inter_state' | 'untaxed' = 'intra_state') =>
    h.db.transaction((tx) => freezeSaleBill(tx, biller, { orderId, source: 'invoice', lines, lineDiscPct: 30, party: { retailerId, taxType } }))

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-biller', 'Biller', 'b@test.local', 'biller')`)
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName", "taxType") VALUES ('V1', 'Om Shoes', 'intra_state'), ('V2', 'Delhi Traders', 'inter_state'), ('V3', 'Small Shop', 'untaxed')`)
    await h.db.execute(sql`UPDATE document_sequences SET prefix = '', next = 101 WHERE name = 'sale_bill'`)
  })
  after(async () => { await h?.close() })

  test('frozen bill total: the saved amounts are the bill-totals amounts, and the party owes exactly that', async () => {
    const o = await withLines(await order('Om Shoes', 'V1'))
    const b = await freeze(o, 'V1')
    const expect = computeBillTotals(lines, 30, 'intra_state')
    const [row] = await q<{ billNo: string; grandTotalPaise: string; roundOffPaise: number; discountPct: string; cgstPaise: string }>(sql`
      SELECT "billNo", "grandTotalPaise", "roundOffPaise", "discountPct", "cgstPaise" FROM sale_bills WHERE id = ${b.saleBillId}`)
    assert.deepEqual([row.billNo, Number(row.grandTotalPaise), row.roundOffPaise, row.discountPct, Number(row.cgstPaise)],
      ['101', expect.grandTotalPaise, expect.roundOffPaise, '4.75', expect.cgstPaise])
    assert.equal(expect.grandTotalPaise % 100, 0)
    assert.equal(await balance('V1'), expect.grandTotalPaise)
    assert.deepEqual((await open('V1')).map((x) => [x.side, x.kind, Number(x.openPaise)]), [['debit', 'bill', expect.grandTotalPaise]])
    await assert.rejects(h.db.execute(sql`UPDATE sale_bills SET "grandTotalPaise" = 1 WHERE id = ${b.saleBillId}`), dbError(/frozen/))
    await healthy()
  })

  test('outside the state: IGST; untaxed party: no 4.75 % and its own number series', async () => {
    const igst = await freeze(await withLines(await order('Delhi Traders', 'V2')), 'V2', 'inter_state')
    assert.deepEqual([igst.billNo, igst.totals.cgstPaise, igst.totals.igstBp], ['102', 0, 500])
    const u1 = await freeze(await withLines(await order('Small Shop', 'V3')), 'V3', 'untaxed')
    const u2 = await freeze(await withLines(await order('Small Shop', 'V3')), 'V3', 'untaxed')
    assert.deepEqual([u1.billNo, u2.billNo], ['E1', 'E2'])
    assert.deepEqual([u1.totals.discountPaise, u1.totals.cgstPaise, u1.totals.igstPaise], [0, 0, 0])
    assert.equal(await balance('V3'), u1.totals.grandTotalPaise + u2.totals.grandTotalPaise)
    // The taxed series carried on where it was.
    assert.equal((await freeze(await withLines(await order('Om Shoes', 'V1')), 'V1')).billNo, '103')
    await healthy()
  })

  test('cancelled bill: reversed in the same transaction, money set against it becomes advance', async () => {
    const o = await withLines(await order('Om Shoes', 'V1'))
    const before = await balance('V1')
    const b = await freeze(o, 'V1')
    // Stand-in for a payment (payments come in step 4): a credit set against this bill.
    const [{ id: credit }] = await q<{ id: string }>(sql`INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", reason, "idempotencyKey")
      VALUES ('V1', 'adjustment', -100000, '2026-11-23', 'test credit', ${`t:${++n}`}) RETURNING id`)
    const [{ id: debit }] = await q<{ id: string }>(sql`SELECT id FROM party_ledger_entries WHERE kind = 'bill' AND "saleBillId" = ${b.saleBillId}`)
    await h.db.execute(sql`INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method) VALUES ('V1', ${debit}, ${credit}, 100000, 'manual')`)
    const out = await h.db.transaction((tx) => cancelSaleBill(tx, biller, o, 'wrong party'))
    assert.equal(out?.billNo, b.billNo)
    assert.equal(await balance('V1'), before - 100000)
    const mine = await open('V1')
    // Only the freed credit is open from this test; the bill and its reversal knock each other off.
    assert.ok(mine.some((x) => x.side === 'credit' && Number(x.openPaise) === 100000))
    assert.equal(await num(sql`SELECT count(*) FROM party_open_items WHERE id = ${debit}`), 0)
    assert.equal(await num(sql`SELECT count(*) FROM party_ledger_entries WHERE "reversalOfId" = ${debit} AND reason LIKE 'Bill cancelled: wrong party'`), 1)
    assert.equal(await num(sql`SELECT count(*) FROM sale_bills WHERE id = ${b.saleBillId} AND status = 'cancelled' AND "cancelReason" = 'wrong party'`), 1)
    assert.equal(await num(sql`SELECT count(*) FROM audit_events WHERE action = 'sale_bill.cancelled' AND "entityId" = ${String(o)}`), 1)
    // Nothing more to cancel; a cancel needs a reason.
    assert.equal(await h.db.transaction((tx) => cancelSaleBill(tx, biller, o, 'again')), null)
    await assert.rejects(h.db.transaction((tx) => cancelSaleBill(tx, biller, o, '  ')), /reason/)
    await healthy()
  })

  test('billed again: the old bill is cancelled, the number is kept; a change of series takes a new number', async () => {
    const o = await withLines(await order('Om Shoes', 'V1'))
    const first = await freeze(o, 'V1')
    await h.db.transaction(async (tx) => { await cancelSaleBill(tx, biller, o, 'billed again') })
    const again = await freeze(o, 'V1')
    assert.equal(again.billNo, first.billNo)
    await h.db.transaction(async (tx) => { await cancelSaleBill(tx, biller, o, 'billed again') })
    const untaxed = await freeze(o, 'V1', 'untaxed')
    assert.match(untaxed.billNo, /^E\d+$/)
    assert.equal(await num(sql`SELECT count(*) FROM sale_bills WHERE "orderId" = ${o}`), 3)
    assert.equal(await num(sql`SELECT count(*) FROM sale_bills WHERE "orderId" = ${o} AND status = 'active'`), 1)
    // A bill can only be frozen once while active.
    await assert.rejects(freeze(o, 'V1', 'untaxed'), dbError(/sale_bills_active_order/))
    await healthy()
  })

  test('Direct Bill: needs a master retailer; walk-in: name only, untaxed, typed discount, no ledger entry', async () => {
    const d1 = await createDraft(h.db, biller)
    const manual = [{ artNumber: 'FL-20', mrp: 239.5, qty: 2 }]
    await assert.rejects(generateDirectBill(h.db, biller, d1, { shopkeeperName: 'Nobody Shoes', manualLines: manual }), /not in the retailer master/)
    const party = await generateDirectBill(h.db, biller, d1, { shopkeeperName: 'delhi traders', lineDiscPct: 30, manualLines: manual })
    assert.deepEqual([party.retailerId, party.taxType, party.totals.igstBp], ['V2', 'inter_state', 500])
    const d2 = await createDraft(h.db, biller)
    await assert.rejects(generateDirectBill(h.db, biller, d2, { manualLines: manual }, { walkIn: { name: ' ', paidMode: 'cash' } }), /customer's name/)
    const walk = await generateDirectBill(h.db, biller, d2, { lineDiscPct: 30, manualLines: manual }, { walkIn: { name: 'Ramesh', phone: '98', paidMode: 'upi', discountPct: 10 } })
    assert.deepEqual([walk.retailerId, walk.taxType, walk.totals.discountBp], [null, 'untaxed', 1000])
    assert.match(walk.billNo, /^E\d+$/)
    const [sb] = await q<{ customerName: string; paidMode: string; retailerId: string | null }>(sql`SELECT "customerName", "paidMode", "retailerId" FROM sale_bills WHERE "orderId" = ${walk.id}`)
    assert.deepEqual(sb, { customerName: 'Ramesh', paidMode: 'upi', retailerId: null })
    assert.equal(await num(sql`SELECT count(*) FROM party_ledger_entries e JOIN sale_bills b ON b.id = e."saleBillId" WHERE b."orderId" = ${walk.id}`), 0)
    await healthy()
  })

  test('billing party: the order\'s retailer, else an exact name match, else none', async () => {
    const byId = await order('Typed Differently', 'V2')
    const byName = await order('  om shoes ')
    const none = await order('Unknown Party')
    const got = await h.db.transaction(async (tx) => [await billingPartyFor(tx, byId), await billingPartyFor(tx, byName), await billingPartyFor(tx, none)])
    assert.deepEqual(got.map((g) => [g?.retailerId, g?.taxType]), [['V2', 'inter_state'], ['V1', 'intra_state'], [null, null]])
  })
})
