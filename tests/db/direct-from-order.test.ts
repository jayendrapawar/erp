// Direct bill from an order (owner, 23 Nov 2026): what was not received is marked on the order.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordReceivedPairs } from '../../lib/billing/received-pairs'

describe('direct bill from an order (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  before(async () => { h = await createHarness() })
  after(async () => { await h?.close() })

  test('received pairs are saved per line; short lines stay marked; other orders untouched', async () => {
    const order = async (n: string) => Number((await h.db.execute<{ id: number }>(sql`
      INSERT INTO orders ("orderNumber", "shopkeeperName", status, "isEmergency") VALUES (${n}, 'Om Shoes', 'packed', true) RETURNING id`)).rows[0].id)
    const o = await order('ORD-D1'), other = await order('ORD-D2')
    const items = (await h.db.execute<{ id: number }>(sql`
      INSERT INTO order_items ("orderId", "artNumber", "sizeNumber", "quantityOrdered") VALUES
        (${o}, 'PUG-1', '6', 4), (${o}, 'PUG-1', '7', 2), (${o}, 'FL-20', '8', 3), (${other}, 'X', '5', 1) RETURNING id`)).rows.map((r) => Number(r.id))
    const short = await h.db.transaction((tx) => recordReceivedPairs(tx, { id: null, name: 'Biller' }, o, [
      { itemId: items[0], qty: 4 }, { itemId: items[1], qty: 1 }, { itemId: items[2], qty: 0 }, { itemId: items[3], qty: 1 }, // last: another order's line
    ]))
    assert.deepEqual(short.map((s) => [s.artNumber, s.sizeNumber, s.ordered, s.received]).sort(), [['FL-20', '8', 3, 0], ['PUG-1', '7', 2, 1]])
    const rows = (await h.db.execute<{ id: number; quantityPacked: number; status: string }>(sql`
      SELECT id, "quantityPacked", status FROM order_items ORDER BY id`)).rows.map((r) => [Number(r.quantityPacked), r.status])
    assert.deepEqual(rows, [[4, 'packed'], [1, 'packed'], [0, 'out_of_stock'], [0, 'pending']])
    assert.equal(Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM audit_events WHERE action = 'order.direct_billed'`)).rows[0].n), 1)
  })
})
