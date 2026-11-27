// Salesman order lists (lib/orders/order-list.ts): own orders only for a salesman (owner, 22 Nov 2026),
// open + last 60 days on first load, older history page by page with no gaps or repeats.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { OLDER_PAGE, olderOrders, recentOrders } from '../../lib/orders/order-list'

describe('salesman order lists (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('s-a','Asha','a@test.local','salesman'), ('s-b','Bhavin','b@test.local','salesman')`)
    // Asha: an open order from a year ago, a delivered one from 10 days ago, and 250 delivered ones older than 60 days.
    await h.db.execute(sql`INSERT INTO orders ("orderNumber", "shopkeeperName", "salesmanId", status, "orderedAt") VALUES
      ('A-OPEN-OLD', 'Shop 1', 's-a', 'pending', now() - interval '365 days'),
      ('A-RECENT', 'Shop 2', 's-a', 'delivered', now() - interval '10 days'),
      ('B-RECENT', 'Shop 3', 's-b', 'pending', now() - interval '1 day')`)
    await h.db.execute(sql`INSERT INTO orders ("orderNumber", "shopkeeperName", "salesmanId", status, "orderedAt")
      SELECT 'A-OLD-' || g, 'Shop', 's-a', 'delivered', now() - interval '61 days' - (g || ' hours')::interval FROM generate_series(1, 250) g`)
  })
  after(async () => { await h?.close() })

  test('first load: a salesman gets only his own open + last-60-days orders; admin gets everyone\'s', async () => {
    const asha = await recentOrders(h.db, { salesmanId: 's-a' })
    assert.deepEqual(asha.map((o) => o.orderNumber).sort(), ['A-OPEN-OLD', 'A-RECENT'])
    assert.equal(asha[0].salesmanName, 'Asha')
    const all = await recentOrders(h.db, { all: true })
    assert.deepEqual(all.map((o) => o.orderNumber), ['B-RECENT', 'A-RECENT', 'A-OPEN-OLD']) // newest first
  })

  test('"Load older" pages through all history once, in order, own orders only', async () => {
    const seen = new Set((await recentOrders(h.db, { salesmanId: 's-a' })).map((o) => o.orderNumber))
    // As the screen does: continue after the oldest CLOSED or recent order shown (A-RECENT), not after the
    // year-old open order (that would skip the 250 delivered between 61 days and a year ago).
    let cursor: number | null = Number((await h.db.execute<{ id: number }>(sql`SELECT id FROM orders WHERE "orderNumber" = 'A-RECENT'`)).rows[0].id)
    let pages = 0, got = 0
    for (;;) {
      const page = await olderOrders(h.db, { salesmanId: 's-a' }, cursor)
      pages++
      for (const o of page) { assert.ok(o.orderNumber.startsWith('A-'), o.orderNumber); if (!seen.has(o.orderNumber)) got++; seen.add(o.orderNumber) }
      if (page.length < OLDER_PAGE) break
      cursor = page[page.length - 1].id
    }
    assert.equal(got, 250)
    assert.equal(pages, 3)
    assert.equal(seen.size, 252)
  })

  test('only old open orders on screen: "Load older" starts at the 60-day line', async () => {
    const first = await olderOrders(h.db, { salesmanId: 's-a' }, null)
    assert.equal(first.length, OLDER_PAGE)
    assert.equal(first[0].orderNumber, 'A-OLD-1') // newest beyond 60 days
    assert.ok(first.every((o) => o.orderNumber.startsWith('A-')))
  })
})
