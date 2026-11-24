import { test } from 'node:test'
import assert from 'node:assert/strict'
import { daysBetween, suggestEarlyDiscount } from '../../lib/payments/early-discount'

test('early-payment discount: suggested within the party\'s days, on the amount before GST, never above what is unpaid', () => {
  const terms = { discountBp: 200, days: 30 } // 2 % within 30 days
  const bill = { taxablePaise: 1_000_000, billDate: '2026-11-01', openPaise: 1_050_000 }
  assert.equal(daysBetween('2026-11-01', '2026-12-01'), 30)
  assert.equal(suggestEarlyDiscount(terms, bill, '2026-11-15'), 20_000)
  assert.equal(suggestEarlyDiscount(terms, bill, '2026-12-01'), 20_000) // day 30 still counts
  assert.equal(suggestEarlyDiscount(terms, bill, '2026-12-02'), 0) // late: nothing suggested
  assert.equal(suggestEarlyDiscount(terms, { ...bill, openPaise: 5_000 }, '2026-11-15'), 5_000)
  assert.equal(suggestEarlyDiscount({ discountBp: null, days: null }, bill, '2026-11-15'), 0) // party without the discount
  assert.equal(suggestEarlyDiscount({ discountBp: 175, days: 30 }, { ...bill, taxablePaise: 333 }, '2026-11-02'), 6) // 5.83 → 6 (half up)
})
