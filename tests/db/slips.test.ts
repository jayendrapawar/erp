// Banks and cash / bank slips (migration 0019; docs/architecture/payments.md).

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { freezeSaleBill } from '../../lib/billing/sale-bill'
import { recordPayment, reversePayment } from '../../lib/payments/payments'
import { cashSlipNumbering, listBanks, saveBank, saveCashSlipNumbering, slipView } from '../../lib/payments/slips'
import type { Actor } from '../../lib/db/types'

describe('banks and slips (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const acct: Actor = { id: 'u-acct', name: 'Accountant' }
  const num = async (s: ReturnType<typeof sql>) => Number(Object.values((await h.db.execute(s)).rows[0] ?? { x: 0 })[0])
  const healthy = async () => {
    assert.equal(await num(sql`SELECT count(*) FROM party_balance_mismatches`), 0)
    assert.equal(await num(sql`SELECT count(*) FROM party_open_item_mismatches`), 0)
  }
  const pay = (input: Record<string, unknown>) => h.db.transaction((tx) => recordPayment(tx, acct, { clientId: randomUUID(), receivedOn: '2026-11-24', ...input }))
  let sbi = 0

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-acct', 'Accountant', 'ac@test.local', 'accountant')`)
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName", "taxType") VALUES ('S1', 'Om Shoes', 'untaxed'), ('S2', 'Two Shops', 'untaxed')`)
    const o = Number((await h.db.execute<{ id: number }>(sql`INSERT INTO orders ("orderNumber", "shopkeeperName", "retailerId", status) VALUES ('ORD-SL', 'Om Shoes', 'S1', 'packed') RETURNING id`)).rows[0].id)
    await h.db.transaction((tx) => freezeSaleBill(tx, acct, { orderId: o, source: 'invoice', lines: [{ mrp: 1000, qty: 1 }], lineDiscPct: 0, party: { retailerId: 'S1', taxType: 'untaxed' }, billDate: '2026-11-01' }))
  })
  after(async () => { await h?.close() })

  test('Master → Banks: add, edit; prefixes may not clash with cash or another bank', async () => {
    const list = await h.db.transaction((tx) => saveBank(tx, acct, { name: 'SBI Current', slipPrefix: 'sbi/', accountNo: '1234', ifsc: 'SBIN0001234' }))
    sbi = list[0].id
    assert.deepEqual([list[0].slipPrefix, list[0].nextSlip, list[0].active], ['SBI/', 1, true])
    await assert.rejects(h.db.transaction((tx) => saveBank(tx, acct, { name: 'sbi current', slipPrefix: 'X/' })), /already exists/)
    await assert.rejects(h.db.transaction((tx) => saveBank(tx, acct, { name: 'HDFC', slipPrefix: 'SBI/' })), /already used/)
    await assert.rejects(h.db.transaction((tx) => saveBank(tx, acct, { name: 'Canara', slipPrefix: 'C1' })), /clashes/) // C + 1x = C1 + x
    await assert.rejects(h.db.transaction((tx) => saveBank(tx, acct, { name: 'Bad', slipPrefix: 'B', ifsc: 'X' })), /IFSC/)
    const hd = await h.db.transaction((tx) => saveBank(tx, acct, { name: 'HDFC UPI', slipPrefix: 'H/', nextSlip: 40 }))
    assert.equal(hd.find((b) => b.name === 'HDFC UPI')?.nextSlip, 40)
    assert.equal((await listBanks(h.db, { activeOnly: true })).length, 2)
  })

  test('slips: one per day for cash and per bank; numbered from their series; lines add to the day\'s slip', async () => {
    const a = await pay({ retailerId: 'S1', mode: 'cash', amountPaise: 30000, into: { kind: 'cash' } })
    const b = await pay({ retailerId: 'S2', mode: 'cash', amountPaise: 5000, into: { kind: 'cash' } })
    assert.deepEqual([a.slipNo, a.receiptNo, b.slipNo, b.receiptNo], ['C1', 'C1-1', 'C1', 'C1-2'])
    const next = await pay({ retailerId: 'S1', mode: 'cash', amountPaise: 1000, into: { kind: 'cash' }, receivedOn: '2026-11-25' })
    assert.equal(next.slipNo, 'C2')
    await assert.rejects(pay({ retailerId: 'S1', mode: 'upi', amountPaise: 100, into: { kind: 'cash' } }), /cash only/)
    await assert.rejects(pay({ retailerId: 'S1', mode: 'cash', amountPaise: 100, into: { kind: 'bank', bankAccountId: sbi } }), /UPI, bank transfer or cheque/)
    // A cheque on a bank slip is deposited: counted at once, set against the oldest bill.
    const c = await pay({ retailerId: 'S1', mode: 'cheque', chequeNo: '445566', amountPaise: 20000, into: { kind: 'bank', bankAccountId: sbi } })
    assert.deepEqual([c.slipNo, c.receiptNo, c.status, c.allocatedPaise], ['SBI/1', 'SBI/1-1', 'active', 20000])
    const u = await pay({ retailerId: 'S1', mode: 'upi', reference: 'UPI99', amountPaise: 10000, into: { kind: 'bank', bankAccountId: sbi } })
    assert.equal(u.receiptNo, 'SBI/1-2')
    const v = await slipView(h.db, { kind: 'bank', bankAccountId: sbi }, '2026-11-24')
    assert.deepEqual([v.slip?.slipNo, v.slip?.bankName, v.lines.length, v.totalPaise], ['SBI/1', 'SBI Current', 2, 30000])
    assert.deepEqual(v.lines[0].setAgainst.map((s) => s.amountPaise), [20000])
    // A wrong line is reversed: shown, but not in the total.
    await h.db.transaction((tx) => reversePayment(tx, acct, u.paymentId, 'wrong party'))
    const v2 = await slipView(h.db, { kind: 'bank', bankAccountId: sbi }, '2026-11-24')
    assert.deepEqual([v2.lines.length, v2.lines[1].status, v2.totalPaise], [2, 'reversed', 20000])
    assert.equal((await slipView(h.db, { kind: 'cash' }, '2026-11-24')).totalPaise, 35000)
    assert.equal((await slipView(h.db, { kind: 'cash' }, '2026-11-30')).slip, null)
    // Retired bank: no new slip.
    await h.db.transaction((tx) => saveBank(tx, acct, { id: sbi, name: 'SBI Current', slipPrefix: 'SBI/', nextSlip: 2, active: false }))
    await assert.rejects(pay({ retailerId: 'S1', mode: 'upi', amountPaise: 100, into: { kind: 'bank', bankAccountId: sbi }, receivedOn: '2026-11-26' }), /retired/)
    await healthy()
  })

  test('cash slip numbering: go-live number; never below a used one', async () => {
    assert.deepEqual(await cashSlipNumbering(h.db), { prefix: 'C', next: 3 })
    await assert.rejects(h.db.transaction((tx) => saveCashSlipNumbering(tx, acct, { prefix: 'C', next: 2 })), /already used/)
    assert.deepEqual(await h.db.transaction((tx) => saveCashSlipNumbering(tx, acct, { prefix: 'C', next: 500 })), { prefix: 'C', next: 500 })
    assert.equal((await pay({ retailerId: 'S2', mode: 'cash', amountPaise: 100, into: { kind: 'cash' }, receivedOn: '2026-11-27' })).slipNo, 'C500')
  })
})
