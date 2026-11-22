// Party ledger — rules the database itself enforces (migration 0017). The flows that use them
// (billing, payments, allocation) are tested in tests/db/payments.test.ts.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, harnessEnabled, type Harness } from './_harness'

describe('party ledger rules (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  let n = 0
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await h.pool.query(text, params)).rows as T[]
  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await q<T>(text, params))[0]
  const fails = (text: string, params: unknown[], re: RegExp) => assert.rejects(h.pool.query(text, params), re)

  const retailer = async () => {
    const id = `r${++n}`
    await q(`INSERT INTO retailers (id, "partyName") VALUES ($1, $2)`, [id, `Party ${n}`])
    return id
  }
  const entry = async (r: string, kind: string, amount: number, extra: Record<string, unknown> = {}) => {
    const cols = ['"retailerId"', 'kind', '"amountPaise"', '"entryDate"', '"idempotencyKey"', ...Object.keys(extra).map((k) => `"${k}"`)]
    const vals = [r, kind, amount, '2026-11-23', `t:${++n}`, ...Object.values(extra)]
    return Number((await one<{ id: string }>(`INSERT INTO party_ledger_entries (${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals)).id)
  }
  const balance = async (r: string) => Number((await one<{ b: string }>(`SELECT coalesce((SELECT "balancePaise" FROM party_balances WHERE "retailerId" = $1), 0) AS b`, [r])).b)
  const allocate = (r: string, debit: number, credit: number, amount: number, reversalOf: number | null = null) =>
    h.pool.query(`INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", "reversalOfId", method) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [r, debit, credit, amount, reversalOf, reversalOf ? 'reversal' : 'manual']).then((x) => Number(x.rows[0].id))

  before(async () => { h = await createHarness() })
  after(async () => { await h?.close() })

  test('balance is kept by the trigger and always equals the sum of entries', async () => {
    const r = await retailer()
    await entry(r, 'opening', 500000)
    await entry(r, 'adjustment', -12345, { reason: 'test' })
    await entry(r, 'opening', -1000)
    assert.equal(await balance(r), 500000 - 12345 - 1000)
    assert.equal(Number((await one<{ c: string }>(`SELECT count(*) AS c FROM party_balance_mismatches`)).c), 0)
    await fails(`UPDATE party_balances SET "balancePaise" = 0 WHERE "retailerId" = $1`, [r], /maintained from party_ledger_entries/)
  })

  test('entries can never be changed or deleted', async () => {
    const r = await retailer()
    const e = await entry(r, 'opening', 100)
    await fails(`UPDATE party_ledger_entries SET "amountPaise" = 200 WHERE id = $1`, [e], /append-only/)
    await fails(`DELETE FROM party_ledger_entries WHERE id = $1`, [e], /append-only/)
  })

  test('a reversal is the exact opposite, needs a reason, and happens once', async () => {
    const r = await retailer(), other = await retailer()
    const e = await entry(r, 'opening', 70000)
    await assert.rejects(entry(r, 'reversal', -60000, { reversalOfId: e, reason: 'wrong' }), /exact opposite/)
    await assert.rejects(entry(other, 'reversal', -70000, { reversalOfId: e, reason: 'wrong' }), /exact opposite/)
    await assert.rejects(entry(r, 'reversal', -70000, { reversalOfId: e }), /ple_reversal/)
    await entry(r, 'reversal', -70000, { reversalOfId: e, reason: 'typed twice' })
    await assert.rejects(entry(r, 'reversal', -70000, { reversalOfId: e, reason: 'again' }), /ple_one_reversal/)
    assert.equal(await balance(r), 0)
  })

  test('allocations: never more than the bill or the payment; an undo frees the money', async () => {
    const r = await retailer()
    const bill = await entry(r, 'opening', 10000, { refNo: 'OLD-1' })
    const pay = await entry(r, 'adjustment', -15000, { reason: 'credit for test' })
    await assert.rejects(allocate(r, bill, pay, 10001), /would be allocated/)
    const a = await allocate(r, bill, pay, 6000)
    await assert.rejects(allocate(r, bill, pay, 4001), /would be allocated/)
    await allocate(r, bill, pay, 4000)
    const open = await q<{ side: string; openPaise: string }>(`SELECT side, "openPaise" FROM party_open_items WHERE "retailerId" = $1 ORDER BY side`, [r])
    assert.deepEqual(open.map((o) => [o.side, Number(o.openPaise)]), [['credit', 5000]]) // bill paid, 50 rupees advance
    await assert.rejects(allocate(r, bill, pay, -5000, a), /exactly undo/)
    await allocate(r, bill, pay, -6000, a)
    await assert.rejects(allocate(r, bill, pay, -6000, a), /pa_one_reversal/)
    const open2 = await q<{ side: string; openPaise: string }>(`SELECT side, "openPaise" FROM party_open_items WHERE "retailerId" = $1 ORDER BY side`, [r])
    assert.deepEqual(open2.map((o) => [o.side, Number(o.openPaise)]), [['credit', 11000], ['debit', 6000]])
    assert.equal(Number((await one<{ c: string }>(`SELECT count(*) AS c FROM party_open_item_mismatches`)).c), 0)
  })

  test('allocations only link a debit and a credit of the same party', async () => {
    const r = await retailer(), other = await retailer()
    const d = await entry(r, 'opening', 1000), d2 = await entry(r, 'opening', 1000), c = await entry(other, 'opening', -1000)
    await assert.rejects(allocate(r, d, c, 500), /same party/)
    await assert.rejects(allocate(r, d, d2, 500), /same party/)
  })

  test('sale bill amounts are frozen and must add up; only cancelling is allowed', async () => {
    const r = await retailer()
    const o = Number((await one<{ id: string }>(`INSERT INTO orders ("orderNumber", "shopkeeperName", status) VALUES ($1, 'x', 'billed') RETURNING id`, [`ORD-${++n}`])).id)
    const ins = (total: number, tax = 'intra_state', igst = 0, cgst = 14740) => h.pool.query(`
      INSERT INTO sale_bills ("orderId", "retailerId", "billNo", "billDate", source, "taxType", "totalQty", "lineDiscPct",
        "grossPaise", "discountPct", "discountPaise", "taxablePaise", "cgstPct", "cgstPaise", "sgstPct", "sgstPaise", "igstPct", "igstPaise", "roundOffPaise", "grandTotalPaise")
      VALUES ($1, $2, $3, '2026-11-23', 'invoice', $4, 31, 30, 619000, 4.75, 29403, 589597, 2.5, $6, 2.5, $6, 5, $5, 23, $7) RETURNING id`,
      [o, r, `B${n}`, tax, igst, cgst, total]).then((x) => Number(x.rows[0].id))
    await assert.rejects(ins(619101), /sale_bills_total/)
    await assert.rejects(ins(619100 + 14740, 'intra_state', 14740), /sale_bills_gst/)
    const b = await ins(619100)
    await assert.rejects(ins(619100), /sale_bills_active_order/)
    await fails(`UPDATE sale_bills SET "grandTotalPaise" = 1 WHERE id = $1`, [b], /frozen/)
    await fails(`UPDATE sale_bills SET status = 'cancelled' WHERE id = $1`, [b], /sale_bills_cancel/)
    await q(`UPDATE sale_bills SET status = 'cancelled', "cancelledAt" = now(), "cancelReason" = 'sent back' WHERE id = $1`, [b])
    await fails(`UPDATE sale_bills SET status = 'active' WHERE id = $1`, [b], /frozen/)
    await fails(`DELETE FROM sale_bills WHERE id = $1`, [b], /never deleted/)
  })

  test('walk-in bills: no retailer, a name, untaxed, paid', async () => {
    const o = Number((await one<{ id: string }>(`INSERT INTO orders ("orderNumber", "shopkeeperName", status) VALUES ($1, 'x', 'billed') RETURNING id`, [`ORD-${++n}`])).id)
    const ins = (name: string, tax: string, paid: string | null) => h.pool.query(`
      INSERT INTO sale_bills ("orderId", "customerName", "paidMode", "billNo", "billDate", source, "taxType", "totalQty", "lineDiscPct",
        "grossPaise", "discountPct", "discountPaise", "taxablePaise", "grandTotalPaise")
      VALUES ($1, $2, $3, $4, '2026-11-23', 'direct', $5, 1, 30, 35000, 0, 0, 35000, 35000)`, [o, name, paid, `E${n}`, tax])
    await assert.rejects(ins('', 'untaxed', 'cash'), /sale_bills_party/)
    await assert.rejects(ins('Ramesh', 'intra_state', 'cash'), /sale_bills_party/)
    await assert.rejects(ins('Ramesh', 'untaxed', null), /sale_bills_party/)
    await ins('Ramesh', 'untaxed', 'cash')
  })

  test('payments: cheque details required; a cheque in hand is not counted; only allowed status moves', async () => {
    const r = await retailer()
    const pay = (mode: string, status: string, extra: Record<string, unknown> = {}) => {
      const base: Record<string, unknown> = { clientId: crypto.randomUUID(), receiptNo: `R${++n}`, retailerId: r, receivedOn: '2026-11-23', mode, amountPaise: 500000, status, ...extra }
      if (status !== 'pending' && !('countedOn' in base)) base.countedOn = '2026-11-23'
      const k = Object.keys(base)
      return h.pool.query(`INSERT INTO payments (${k.map((x) => `"${x}"`).join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base)).then((x) => Number(x.rows[0].id))
    }
    await assert.rejects(pay('cheque', 'pending'), /payments_cheque/)
    await assert.rejects(pay('cash', 'active', { countedOn: null }), /payments_counted/)
    const cheque = { chequeNo: '000123', chequeBank: 'SBI', chequeDate: '2026-11-30' }
    const p = await pay('cheque', 'pending', cheque)
    await fails(`UPDATE payments SET "amountPaise" = 1 WHERE id = $1`, [p], /cannot be edited/)
    await fails(`UPDATE payments SET status = 'bounced', "reversedAt" = now(), "reversalReason" = 'x' WHERE id = $1`, [p], /cannot be edited/)
    await q(`UPDATE payments SET status = 'active', "countedOn" = '2026-12-01' WHERE id = $1`, [p])
    await fails(`UPDATE payments SET status = 'pending', "countedOn" = NULL WHERE id = $1`, [p], /cannot be edited/)
    await q(`UPDATE payments SET status = 'bounced', "reversedAt" = now(), "reversalReason" = 'insufficient funds' WHERE id = $1`, [p])
    const cash = await pay('cash', 'active')
    await fails(`UPDATE payments SET status = 'bounced', "reversedAt" = now(), "reversalReason" = 'x' WHERE id = $1`, [cash], /payments_bounced/)
    await fails(`DELETE FROM payments WHERE id = $1`, [cash], /never deleted/)
    const dup = crypto.randomUUID()
    await pay('cash', 'active', { clientId: dup })
    await assert.rejects(pay('cash', 'active', { clientId: dup }), /payments_clientId_key|duplicate key/)
  })
})
