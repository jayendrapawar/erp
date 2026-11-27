// Bank statement import (migration 0020; docs/architecture/payments.md): nothing posts until confirmed;
// re-import adds nothing; payers are learnt; splits; typed payments are linked, not doubled.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { freezeSaleBill } from '../../lib/billing/sale-bill'
import { partySummary, recordPayment } from '../../lib/payments/payments'
import { saveBank } from '../../lib/payments/slips'
import { parseStatement, type StatementColumns } from '../../lib/payments/statement-parse'
import { confirmStatementLines, countKnownLines, ignoreStatementLine, importStatement, listStatementLines } from '../../lib/payments/statements'
import type { Actor } from '../../lib/db/types'

describe('bank statement import (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const acct: Actor = { id: 'u-acct', name: 'Accountant' }
  const num = async (s: ReturnType<typeof sql>) => Number(Object.values((await h.db.execute(s)).rows[0] ?? { x: 0 })[0])
  const healthy = async () => {
    assert.equal(await num(sql`SELECT count(*) FROM party_balance_mismatches`), 0)
    assert.equal(await num(sql`SELECT count(*) FROM party_open_item_mismatches`), 0)
  }
  const cols: StatementColumns = { date: 'Date', details: 'Narration', reference: 'Ref', credit: 'Credit', debit: 'Debit' }
  const file = (rows: Array<[string, string, string, string, string]>) =>
    parseStatement([{ rowNumber: 1, values: ['Date', 'Narration', 'Ref', 'Debit', 'Credit'] }, ...rows.map((v, i) => ({ rowNumber: i + 2, values: v }))], cols).lines
  let bank = 0

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-acct', 'Accountant', 'ac@test.local', 'accountant')`)
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName", "taxType") VALUES ('T1', 'Om Shoes', 'untaxed'), ('T2', 'Om Shoes Branch', 'untaxed'), ('T3', 'Cheque Party', 'untaxed')`)
    for (const [i, r, amt] of [[1, 'T1', 1000], [2, 'T2', 400], [3, 'T1', 300]] as const) {
      const o = Number((await h.db.execute<{ id: number }>(sql`INSERT INTO orders ("orderNumber", "shopkeeperName", "retailerId", status) VALUES (${`ORD-ST-${i}`}, 'x', ${r}, 'packed') RETURNING id`)).rows[0].id)
      await h.db.transaction((tx) => freezeSaleBill(tx, acct, { orderId: o, source: 'invoice', lines: [{ mrp: amt, qty: 1 }], lineDiscPct: 0, party: { retailerId: r, taxType: 'untaxed' }, billDate: '2026-11-01' }))
    }
    bank = (await h.db.transaction((tx) => saveBank(tx, acct, { name: 'SBI Current', slipPrefix: 'SBI/' })))[0].id
  })
  after(async () => { await h?.close() })

  test('import: lines saved, money out kept; the same file again adds nothing', async () => {
    const lines = file([
      ['10/11/2026', 'UPI/CR/1/RAMESH PATEL/ramesh@oksbi', '9001', '', '1,000.00'],
      ['10/11/2026', 'NEFT-HDFC0001234-OM GROUP-N1', 'N1', '', '1,400.00'],
      ['11/11/2026', 'SMS CHARGES', '', '17.70', ''],
    ])
    const a = await h.db.transaction((tx) => importStatement(tx, acct, bank, { name: 'nov.csv', sha256: 'a'.repeat(64) }, cols, lines))
    assert.deepEqual([a.rowsRead, a.rowsNew], [3, 3])
    assert.equal(await countKnownLines(h.db, bank, lines), 3)
    const b = await h.db.transaction((tx) => importStatement(tx, acct, bank, { name: 'nov again.csv', sha256: 'b'.repeat(64) }, cols, lines))
    assert.equal(b.rowsNew, 0)
    assert.equal((await listStatementLines(h.db, bank, 'review')).length, 2)
    assert.equal((await listStatementLines(h.db, bank, 'out')).length, 1)
    assert.equal(await num(sql`SELECT count(*) FROM payments`), 0) // nothing posted yet
  })

  test('confirm: an unknown payer becomes a payment on the bank slip; the payer is remembered and pre-ticked next time', async () => {
    const [upi] = (await listStatementLines(h.db, bank, 'review')).filter((l) => l.payerKey === 'ramesh@oksbi')
    assert.deepEqual([upi.mode, upi.known.length, upi.exact], ['upi', 0, false])
    await h.db.transaction((tx) => confirmStatementLines(tx, acct, [{ lineId: upi.id, splits: [{ retailerId: 'T1', amountPaise: 100000 }] }]))
    const p = (await h.db.execute<{ receiptNo: string; mode: string; reference: string; statementLineId: string }>(sql`SELECT "receiptNo", mode, reference, "statementLineId" FROM payments`)).rows[0]
    assert.deepEqual([p.receiptNo, p.mode, p.reference, Number(p.statementLineId)], ['SBI/1-1', 'upi', '9001', upi.id])
    assert.equal((await partySummary(h.db, 'T1')).unpaidPaise, 30000) // the ₹1,000 bill is paid
    await assert.rejects(h.db.transaction((tx) => confirmStatementLines(tx, acct, [{ lineId: upi.id, splits: [{ retailerId: 'T1', amountPaise: 100000 }] }])), /already confirmed/)
    // Next month the same payer pays ₹300 — exactly T1's open bill: suggested and pre-ticked.
    const next = file([['05/12/2026', 'UPI/CR/7/RAMESH PATEL/ramesh@oksbi', '9555', '', '300.00']])
    await h.db.transaction((tx) => importStatement(tx, acct, bank, { name: 'dec.csv', sha256: 'c'.repeat(64) }, cols, next))
    const l = (await listStatementLines(h.db, bank, 'review')).find((x) => x.txnDate === '2026-12-05')!
    assert.deepEqual([l.known.map((k) => k.retailerId), l.known[0].exactBill, l.exact], [['T1'], true, true])
    await healthy()
  })

  test('one payment for two shops: split must add up exactly; both parties remembered', async () => {
    const neft = (await listStatementLines(h.db, bank, 'review')).find((x) => x.payerKey === 'OM GROUP')!
    await assert.rejects(h.db.transaction((tx) => confirmStatementLines(tx, acct, [{ lineId: neft.id, splits: [{ retailerId: 'T1', amountPaise: 100000 }, { retailerId: 'T2', amountPaise: 30000 }] }])), /add up/)
    const r = await h.db.transaction((tx) => confirmStatementLines(tx, acct, [{ lineId: neft.id, splits: [{ retailerId: 'T1', amountPaise: 100000 }, { retailerId: 'T2', amountPaise: 40000 }] }]))
    assert.equal(r.payments, 2)
    assert.equal(await num(sql`SELECT count(*) FROM payer_aliases WHERE "payerKey" = 'OM GROUP'`), 2)
    assert.equal((await partySummary(h.db, 'T2')).balancePaise, 0)
    await healthy()
  })

  test('a payment typed on the slip is linked, not doubled; a bank charge is ignored with a reason', async () => {
    const typed = await h.db.transaction((tx) => recordPayment(tx, acct, {
      clientId: randomUUID(), retailerId: 'T3', receivedOn: '2026-12-06', mode: 'cheque', chequeNo: '445566', amountPaise: 25000, into: { kind: 'bank', bankAccountId: bank },
    }))
    await h.db.transaction((tx) => importStatement(tx, acct, bank, { name: 'dec2.csv', sha256: 'd'.repeat(64) }, cols,
      file([['07/12/2026', 'BY CLG CHQ 445566 CHEQUE PARTY', '445566', '', '250.00']])))
    const l = (await listStatementLines(h.db, bank, 'review')).find((x) => x.txnDate === '2026-12-07')!
    assert.deepEqual([l.typed.length, l.typed[0].strong, l.exact, l.mode, l.chequeNo], [1, true, true, 'cheque', '445566'])
    const before = await num(sql`SELECT count(*) FROM payments`)
    await h.db.transaction((tx) => confirmStatementLines(tx, acct, [{ lineId: l.id, link: [typed.paymentId] }]))
    assert.equal(await num(sql`SELECT count(*) FROM payments`), before)
    assert.equal(await num(sql`SELECT "statementLineId" FROM payments WHERE id = ${typed.paymentId}`), l.id)
    // Linking does not open payments to editing.
    await assert.rejects(h.db.execute(sql`UPDATE payments SET "amountPaise" = 1 WHERE id = ${typed.paymentId}`), (e: Error) => /cannot be edited/.test(String((e as { cause?: Error }).cause?.message ?? e.message)))
    const charge = (await listStatementLines(h.db, bank, 'out'))[0]
    await assert.rejects(h.db.transaction((tx) => ignoreStatementLine(tx, acct, charge.id, '')), /why/)
    await h.db.transaction((tx) => ignoreStatementLine(tx, acct, charge.id, 'bank SMS charges'))
    assert.equal((await listStatementLines(h.db, bank, 'ignored')).length, 1)
    await healthy()
  })

  test('PDF-style lines: a bounced cheque is set aside on import; short cheque no. links; a same-name party is suggested, not ticked', async () => {
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName", "taxType") VALUES ('T4', 'Shree Ji Footwear', 'untaxed')`)
    const typed = await h.db.transaction((tx) => recordPayment(tx, acct, {
      clientId: randomUUID(), retailerId: 'T3', receivedOn: '2026-12-10', mode: 'cheque', chequeNo: '43', amountPaise: 12000, into: { kind: 'bank', bankAccountId: bank },
    }))
    const lines = file([
      ['10/12/2026', 'By-Outward Return SOME PARTY Br-, Chq : 415478, Seq : 19102619001970, Bank : CANARA BANK', '', '', '7,421.00'],
      ['10/12/2026', 'To-Outward Return Clg Return, Chq : 415478, Seq : 19102619001970 Return Reason :Funds Insufficient', '', '7,421.00', ''],
      ['11/12/2026', 'By-Clg. CHEQUE PARTY Br-, Chq : 43, Seq : 21102619002102, Bank : BANK OF BARODA', '43', '', '120.00'],
      ['11/12/2026', 'By-Clg. SHREE JI FOOTWEAR Br-, Chq : 1386, Seq : 19102619001988, Bank : IDFC FIRST BANK LIMITED', '1386', '', '999.00'],
    ])
    const r = await h.db.transaction((tx) => importStatement(tx, acct, bank, { name: 'dec.pdf', sha256: 'e'.repeat(64) }, null, lines))
    assert.deepEqual([r.rowsNew, r.setAside], [4, 1])
    const ignored = (await listStatementLines(h.db, bank, 'ignored')).find((l) => l.creditPaise === 742100)!
    assert.match(ignored.ignoreReason ?? '', /^Cheque 415478 returned unpaid \(Funds Insufficient\)/)
    const review = await listStatementLines(h.db, bank, 'review')
    assert.equal(review.some((l) => l.creditPaise === 742100), false)
    const short = review.find((l) => l.creditPaise === 12000)!
    assert.deepEqual([short.chequeNo, short.typed.length, short.typed[0].paymentId, short.typed[0].strong, short.exact], ['43', 1, typed.paymentId, true, true])
    const named = review.find((l) => l.creditPaise === 99900)!
    assert.deepEqual([named.payerKey, named.known.map((k) => [k.retailerId, k.timesUsed]), named.exact], ['SHREE JI FOOTWEAR', [['T4', 0]], false])
    // A PDF import keeps the bank's saved Excel / CSV columns.
    assert.equal(await num(sql`SELECT count(*) FROM bank_accounts WHERE id = ${bank} AND "statementColumns" IS NOT NULL`), 1)
    await healthy()
  })
})
