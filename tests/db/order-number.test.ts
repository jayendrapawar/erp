// Order numbers ORD-1, ORD-2 … (owner, 24 Nov 2026): one counter, no duplicates under load, no gaps.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { nextOrderNumber } from '../../lib/orders/order-number'

describe('order numbers (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  before(async () => { h = await createHarness() })
  after(async () => { await h?.close() })

  test('starts at ORD-1 and counts up', async () => {
    assert.equal(await h.db.transaction((tx) => nextOrderNumber(tx)), 'ORD-1')
    assert.equal(await h.db.transaction((tx) => nextOrderNumber(tx)), 'ORD-2')
  })

  test('ten orders at the same moment get ten different numbers, no gaps', async () => {
    const got = await Promise.all(Array.from({ length: 10 }, () => h.db.transaction((tx) => nextOrderNumber(tx))))
    assert.deepEqual(got.map((x) => Number(x.slice(4))).sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  test('a save that fails gives its number back', async () => {
    await assert.rejects(h.db.transaction(async (tx) => { await nextOrderNumber(tx); throw new Error('save failed') }), /save failed/)
    assert.equal(await h.db.transaction((tx) => nextOrderNumber(tx)), 'ORD-13')
  })
})
