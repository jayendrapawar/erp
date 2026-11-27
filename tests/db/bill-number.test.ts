import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { assignBillNo, highestBillNumber, stampBillLineHsn } from '../../lib/billing/bill-number'

describe('sale bill numbers and HSN (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const newOrder = async (n: string) => Number((await h.db.execute<{ id: number }>(sql`
    INSERT INTO orders ("orderNumber", "shopkeeperName", status) VALUES (${n}, 'Om Shoes', 'packed') RETURNING id`)).rows[0].id)

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`UPDATE document_sequences SET prefix = '', next = 5901, padding = 0 WHERE name = 'sale_bill'`)
  })
  after(async () => { await h?.close() })

  test('bills take consecutive numbers; a bill billed again keeps its number', async () => {
    const a = await newOrder('ORD-A'), b = await newOrder('ORD-B')
    assert.equal(await h.db.transaction((tx) => assignBillNo(tx, a)), '5901')
    assert.equal(await h.db.transaction((tx) => assignBillNo(tx, b)), '5902')
    assert.equal(await h.db.transaction((tx) => assignBillNo(tx, a)), '5901') // sent back, billed again
    assert.equal(await highestBillNumber(h.db, ''), 5902)
  })

  test('bills made at the same moment never share a number', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, (_, i) => newOrder(`ORD-P${i}`)))
    const nos = await Promise.all(ids.map((id) => h.db.transaction((tx) => assignBillNo(tx, id))))
    assert.equal(new Set(nos).size, 8)
    assert.deepEqual([...nos].map(Number).sort((x, y) => x - y), [5903, 5904, 5905, 5906, 5907, 5908, 5909, 5910])
  })

  test('a bill that fails gives its number back (no gaps)', async () => {
    const c = await newOrder('ORD-C')
    await assert.rejects(h.db.transaction(async (tx) => { await assignBillNo(tx, c); throw new Error('box already on another bill') }))
    assert.equal(await h.db.transaction((tx) => assignBillNo(tx, c)), '5911')
  })

  test('prefix and zero-filled digits', async () => {
    await h.db.execute(sql`UPDATE document_sequences SET prefix = 'SSP/', next = 7, padding = 4 WHERE name = 'sale_bill'`)
    const d = await newOrder('ORD-D')
    assert.equal(await h.db.transaction((tx) => assignBillNo(tx, d)), 'SSP/0007')
    assert.equal(await highestBillNumber(h.db, 'SSP/'), 7)
  })

  test('HSN is copied from the article onto the bill lines', async () => {
    await h.db.execute(sql`INSERT INTO articles ("artName","artCode",color,"colorCode", hsn) VALUES ('PUG-183','PUG183G','Black','BKBK','6402')`)
    const e = await newOrder('ORD-E')
    await h.db.execute(sql`INSERT INTO bill_lines ("orderId", "artNumber", mrp, qty, "lineDiscPct") VALUES (${e}, 'pug183g', 299.5, 2, 30), (${e}, 'UNKNOWN1', 199, 1, 30)`)
    await h.db.transaction((tx) => stampBillLineHsn(tx, e))
    const rows = (await h.db.execute<{ artNumber: string; hsn: string | null }>(sql`SELECT "artNumber", hsn FROM bill_lines WHERE "orderId" = ${e} ORDER BY id`)).rows
    assert.deepEqual(rows, [{ artNumber: 'pug183g', hsn: '6402' }, { artNumber: 'UNKNOWN1', hsn: null }])
  })
})
