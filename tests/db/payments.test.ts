// Payments step 4 (migration 0017; docs/architecture/payments.md): money received, set against bills,
// cheques, early-payment discount, advance, reversals — and the balance always equals the ledger.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { cancelSaleBill, freezeSaleBill } from '../../lib/billing/sale-bill'
import {
  applyAdvance, bouncePayment, depositCheque, loadPartyForPayment, partySummary, recordPayment, returnCheque, reversePayment,
} from '../../lib/payments/payments'
import type { Actor } from '../../lib/db/types'

describe('payments and the party ledger (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  let n = 0
  const acct: Actor = { id: 'u-acct', name: 'Accountant' }
  const q = async <T = Record<string, unknown>>(s: ReturnType<typeof sql>) => (await h.db.execute(s)).rows as T[]
  const num = async (s: ReturnType<typeof sql>) => Number(Object.values((await q(s))[0] ?? { x: 0 })[0])
  const dbError = (re: RegExp) => (e: Error) => re.test(String((e as { cause?: Error }).cause?.message ?? e.message))
  const healthy = async () => {
    assert.equal(await num(sql`SELECT count(*) FROM party_balance_mismatches`), 0, 'balance = sum of entries')
    assert.equal(await num(sql`SELECT count(*) FROM party_open_item_mismatches`), 0, 'unpaid − advance = balance')
  }
  /** A party bill of exactly `rupees` (one line, no line discount, untaxed so nothing is added), dated `date`. */
  const bill = async (retailerId: string, rupees: number, date: string) => {
    const orderId = Number((await q<{ id: number }>(sql`
      INSERT INTO orders ("orderNumber", "shopkeeperName", "retailerId", status) VALUES (${`ORD-P-${++n}`}, 'Shop', ${retailerId}, 'packed') RETURNING id`))[0].id)
    const b = await h.db.transaction((tx) => freezeSaleBill(tx, acct, {
      orderId, source: 'invoice', lines: [{ mrp: rupees, qty: 1 }], lineDiscPct: 0, party: { retailerId, taxType: 'untaxed' }, billDate: date,
    }))
    const entryId = await num(sql`SELECT id FROM party_ledger_entries WHERE "saleBillId" = ${b.saleBillId} AND kind = 'bill'`)
    return { orderId, saleBillId: b.saleBillId, entryId, total: b.totals.grandTotalPaise }
  }
  const pay = (input: Record<string, unknown>) => h.db.transaction((tx) => recordPayment(tx, acct, { clientId: randomUUID(), receivedOn: '2026-11-20', mode: 'cash', ...input }))
  const unpaid = (entryId: number) => num(sql`SELECT coalesce((SELECT "openPaise" FROM party_open_items WHERE id = ${entryId}), 0)`)

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-acct', 'Accountant', 'ac@test.local', 'accountant')`)
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName", "taxType", "earlyPayDiscountBp", "earlyPayDays") VALUES
      ('P1', 'Om Shoes', 'untaxed', NULL, NULL), ('P2', 'Early Payer', 'untaxed', 200, 30), ('P3', 'Cheque Party', 'untaxed', NULL, NULL),
      ('P4', 'Advance Party', 'untaxed', NULL, NULL), ('P5', 'Mistake Party', 'untaxed', NULL, NULL)`)
  })
  after(async () => { await h?.close() })

  test('cash: oldest bill first, part payment, receipt numbers; a retry records once', async () => {
    const a = await bill('P1', 1000, '2026-11-01'), b = await bill('P1', 500, '2026-11-05')
    const clientId = randomUUID()
    const r = await pay({ clientId, retailerId: 'P1', amountPaise: 120000 })
    assert.equal(r.status, 'active')
    assert.match(r.receiptNo, /^R\d+$/)
    assert.equal(r.allocatedPaise, 120000)
    assert.equal(await unpaid(a.entryId), 0)
    assert.equal(await unpaid(b.entryId), 30000) // ₹500 − ₹200
    assert.deepEqual(r.party, { retailerId: 'P1', balancePaise: 30000, unpaidPaise: 30000, advancePaise: 0 })
    // Same clientId again (double tap / retry): nothing new.
    const again = await pay({ clientId, retailerId: 'P1', amountPaise: 120000 })
    assert.equal(again.repeated, true)
    assert.equal(again.receiptNo, r.receiptNo)
    assert.equal(await num(sql`SELECT count(*) FROM payments WHERE "retailerId" = 'P1'`), 1)
    await assert.rejects(pay({ clientId, retailerId: 'P1', amountPaise: 1 }), /already used/)
    await healthy()
  })

  test('set against a chosen bill; more than unpaid or than received is refused', async () => {
    const a = await bill('P1', 300, '2026-11-02'), c = await bill('P1', 400, '2026-11-06')
    await assert.rejects(pay({ retailerId: 'P1', amountPaise: 50000, allocations: [{ entryId: c.entryId, amountPaise: 40001 }] }), /more is set against a bill/i)
    await assert.rejects(pay({ retailerId: 'P1', amountPaise: 10000, allocations: [{ entryId: c.entryId, amountPaise: 20000 }] }), /more is set against bills than/i)
    const r = await pay({ retailerId: 'P1', amountPaise: 50000, allocations: [{ entryId: c.entryId, amountPaise: 40000 }] })
    assert.equal(r.allocatedPaise, 40000)
    assert.equal(await unpaid(c.entryId), 0)
    assert.equal(await unpaid(a.entryId), 30000) // untouched: the rest is advance
    assert.equal(r.party.advancePaise, 10000)
    await healthy()
  })

  test('advance: more than owed waits as advance and goes to the next bill', async () => {
    const r = await pay({ retailerId: 'P4', amountPaise: 70000 })
    assert.deepEqual(r.party, { retailerId: 'P4', balancePaise: -70000, unpaidPaise: 0, advancePaise: 70000 })
    const next = await bill('P4', 1000, '2026-11-21')
    const used = await h.db.transaction((tx) => applyAdvance(tx, acct, 'P4', next.saleBillId))
    assert.equal(used, 70000)
    assert.equal(await unpaid(next.entryId), 30000)
    assert.deepEqual(await partySummary(h.db, 'P4'), { retailerId: 'P4', balancePaise: 30000, unpaidPaise: 30000, advancePaise: 0 })
    // A cancelled bill frees what was set against it: it becomes advance again.
    await h.db.transaction((tx) => cancelSaleBill(tx, acct, next.orderId, 'wrong party'))
    assert.deepEqual(await partySummary(h.db, 'P4'), { retailerId: 'P4', balancePaise: -70000, unpaidPaise: 0, advancePaise: 70000 })
    await healthy()
  })

  test('cheque: received (not counted) → deposited → bounced with a charge; another returned', async () => {
    const a = await bill('P3', 800, '2026-11-03')
    const chq = { retailerId: 'P3', mode: 'cheque', amountPaise: 80000, chequeNo: '000123', chequeBank: 'SBI', chequeDate: '2026-11-25' }
    await assert.rejects(pay({ ...chq, chequeNo: '' }), /cheque number/)
    const r = await pay(chq)
    assert.equal(r.status, 'pending')
    assert.equal(r.party.balancePaise, 80000) // not counted yet
    assert.equal(await num(sql`SELECT count(*) FROM party_ledger_entries WHERE "paymentId" = ${r.paymentId}`), 0)
    await assert.rejects(h.db.transaction((tx) => depositCheque(tx, acct, r.paymentId, '2026-11-19')), /before the cheque was received/)
    const d = await h.db.transaction((tx) => depositCheque(tx, acct, r.paymentId, '2026-11-26'))
    assert.equal(d.allocatedPaise, 80000)
    assert.equal(d.party.balancePaise, 0)
    assert.equal((await q<{ c: string }>(sql`SELECT "countedOn"::text c FROM payments WHERE id = ${r.paymentId}`))[0].c, '2026-11-26')
    const bounced = await h.db.transaction((tx) => bouncePayment(tx, acct, r.paymentId, 'insufficient funds', 50000))
    assert.equal(await unpaid(a.entryId), 80000) // the bill is unpaid again
    assert.equal(bounced.party.balancePaise, 130000) // bill + ₹500 charge
    await assert.rejects(h.db.transaction((tx) => bouncePayment(tx, acct, r.paymentId, 'again')), /not a deposited cheque/)
    // Payments are never edited or deleted.
    await assert.rejects(h.db.execute(sql`UPDATE payments SET "amountPaise" = 1 WHERE id = ${r.paymentId}`), dbError(/cannot be edited/))
    await assert.rejects(h.db.execute(sql`DELETE FROM payments WHERE id = ${r.paymentId}`), dbError(/never deleted/))
    // A second cheque given back before deposit: never counted.
    const r2 = await pay({ ...chq, chequeNo: '000124' })
    await h.db.transaction((tx) => returnCheque(tx, acct, r2.paymentId, 'party took it back'))
    assert.equal((await partySummary(h.db, 'P3')).balancePaise, 130000)
    await assert.rejects(h.db.transaction((tx) => reversePayment(tx, acct, r2.paymentId, 'x')), /already returned/)
    await healthy()
  })

  test('early-payment discount: its own ledger entry against the bill; the payment settles the rest', async () => {
    const a = await bill('P2', 10000, '2026-11-10')
    const party = await loadPartyForPayment(h.db, 'P2')
    assert.equal(party?.earlyPayDiscountBp, 200)
    assert.equal(party?.open[0].taxablePaise, 1000000)
    await assert.rejects(pay({ retailerId: 'P2', amountPaise: 980000, discounts: [{ saleBillId: a.saleBillId, amountPaise: 1000001 }] }), /discount on bill/)
    const r = await pay({ retailerId: 'P2', amountPaise: 980000, discounts: [{ saleBillId: a.saleBillId, amountPaise: 20000 }] })
    assert.equal(r.discountPaise, 20000)
    assert.equal(await unpaid(a.entryId), 0)
    assert.equal(r.party.balancePaise, 0)
    const disc = await q<{ kind: string; amountPaise: string; saleBillId: string }>(sql`
      SELECT kind, "amountPaise", "saleBillId" FROM party_ledger_entries WHERE "paymentId" = ${r.paymentId} ORDER BY id`)
    assert.deepEqual(disc.map((x) => [x.kind, Number(x.amountPaise)]), [['discount', -20000], ['payment', -980000]])
    // Reversed by mistake: the discount comes off too, the bill is unpaid again.
    await h.db.transaction((tx) => reversePayment(tx, acct, r.paymentId, 'wrong party'))
    assert.equal(await unpaid(a.entryId), 1000000)
    assert.equal((await partySummary(h.db, 'P2')).balancePaise, 1000000)
    await healthy()
  })

  test('reversed payment needs a reason; a cheque is set against bills only when deposited', async () => {
    const a = await bill('P5', 200, '2026-11-11')
    const r = await pay({ retailerId: 'P5', amountPaise: 20000, mode: 'upi', reference: 'UPI123' })
    await assert.rejects(h.db.transaction((tx) => reversePayment(tx, acct, r.paymentId, '  ')), /reason/)
    await assert.rejects(pay({ retailerId: 'P5', mode: 'cheque', amountPaise: 100, chequeNo: '1', chequeBank: 'B', chequeDate: '2026-11-20', allocations: [{ entryId: a.entryId, amountPaise: 100 }] }), /when it is deposited/)
    await assert.rejects(pay({ retailerId: 'NOPE', amountPaise: 100 }), /not in the retailer master/)
    await assert.rejects(pay({ retailerId: 'P5', amountPaise: 0 }), /more than ₹0/)
    await healthy()
  })
})
