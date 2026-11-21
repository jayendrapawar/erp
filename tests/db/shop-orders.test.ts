import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { placeShopOrderFor } from '../../lib/shop/place-order'

describe('retailer shop orders (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  let itemId = 0
  let pinSetAt = 0

  before(async () => {
    h = await createHarness()
    const at = new Date('2026-11-21T10:00:00Z')
    pinSetAt = at.getTime()
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName", phone, address, city, "shopPhone", "shopPinHash", "shopEnabled", "shopPinSetAt")
      VALUES ('V900', 'Om Shoes', '9825000000', 'Main Road', 'Bhatar', '9825000000', 'scrypt$x$y$z', true, ${at.toISOString()}::timestamptz)`)
    const a = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode") VALUES ('SS-101','SS0101G','Camel','CLCL') RETURNING id`)
    itemId = Number(a.rows[0].id)
    await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES (${itemId},'6',1),(${itemId},'7',2),(${itemId},'8',3)`)
  })
  after(async () => { await h?.close() })

  test('an order waits as to_confirm, with the same lines as a salesman order', async () => {
    const r = await placeShopOrderFor(h.db, { retailerId: 'V900', pinSetAt }, {
      lines: [{ itemId, size: '6', qty: 2 }, { itemId, size: '7', qty: 4 }, { itemId, size: '6', qty: 1 }], notes: 'send Monday',
    })
    assert.equal(r.pairs, 7)
    const o = (await h.db.execute<{ status: string; source: string; retailerId: string; shopkeeperName: string; salesmanId: string | null; notes: string }>(sql`
      SELECT status, source, "retailerId", "shopkeeperName", "salesmanId", notes FROM orders WHERE id = ${r.orderId}`)).rows[0]
    assert.deepEqual(o, { status: 'to_confirm', source: 'retailer', retailerId: 'V900', shopkeeperName: 'Om Shoes', salesmanId: null, notes: 'send Monday' })
    const items = (await h.db.execute<{ artNumber: string; colorNumber: string; sizeNumber: string; artCode: string; quantityOrdered: number }>(sql`
      SELECT "artNumber", "colorNumber", "sizeNumber", "artCode", "quantityOrdered" FROM order_items WHERE "orderId" = ${r.orderId} ORDER BY "sizeNumber"`)).rows
    assert.deepEqual(items, [
      { artNumber: 'SS-101', colorNumber: 'CAMEL', sizeNumber: '6', artCode: 'SS0101G', quantityOrdered: 3 },
      { artNumber: 'SS-101', colorNumber: 'CAMEL', sizeNumber: '7', artCode: 'SS0101G', quantityOrdered: 4 },
    ])
  })

  test('a size that is not on the article is refused; nothing is written', async () => {
    const before = Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM orders`)).rows[0].n)
    await assert.rejects(placeShopOrderFor(h.db, { retailerId: 'V900', pinSetAt }, { lines: [{ itemId, size: '11', qty: 1 }] }), /size 11 is no longer available/)
    assert.equal(Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM orders`)).rows[0].n), before)
  })

  test('after a new PIN, an old session cannot order', async () => {
    await assert.rejects(placeShopOrderFor(h.db, { retailerId: 'V900', pinSetAt: pinSetAt - 1000 }, { lines: [{ itemId, size: '6', qty: 1 }] }), /sign in again/)
  })

  test('a retailer switched off cannot order', async () => {
    await h.db.execute(sql`UPDATE retailers SET "shopEnabled" = false WHERE id = 'V900'`)
    await assert.rejects(placeShopOrderFor(h.db, { retailerId: 'V900', pinSetAt }, { lines: [{ itemId, size: '6', qty: 1 }] }), /sign in again/)
  })
})
