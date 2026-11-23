import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bpToPct, computeBillTotals, defaultDiscountBp, ratePaise, toPaise } from '../../lib/billing/bill-totals'
import { billTotals } from '../../lib/bill-html'

// The one real Direct Bill on dev (22 Nov 2026): 31 pairs, MRP lines at 30 % line discount.
const lines = [{ mrp: '339.50', qty: 20 }, { mrp: '239.50', qty: 6 }, { mrp: '160.00', qty: 5 }]

test('paise helpers are exact', () => {
  assert.equal(toPaise('339.50'), 33950)
  assert.equal(toPaise(0.1 + 0.2), 30)
  assert.equal(ratePaise('339.50', 30), 23800) // 237.65 → 238 (rounded up to the rupee)
  assert.equal(bpToPct(475), '4.75')
})

test('within the state: 4.75 % discount, CGST + SGST, round-off to the rupee', () => {
  const t = computeBillTotals(lines, 30, 'intra_state')
  assert.equal(t.discountBp, 475)
  assert.equal(t.taxablePaise, t.grossPaise - t.discountPaise)
  assert.equal(t.cgstPaise, t.sgstPaise)
  assert.equal(t.igstPaise, 0)
  assert.equal(t.grandTotalPaise % 100, 0)
  assert.equal(t.grandTotalPaise, t.taxablePaise + t.cgstPaise + t.sgstPaise + t.roundOffPaise)
  assert.ok(Math.abs(t.roundOffPaise) <= 50)
  // Same as the old floating-point bill to within a paisa before round-off.
  const old = billTotals(lines.map((l) => ({ artNumber: '', mrp: Number(l.mrp), qty: l.qty })), 30, 'city')
  assert.ok(Math.abs(t.netPaise - Math.round(old.netAmt * 100)) <= 1)
})

test('outside the state: IGST 5 % only', () => {
  const t = computeBillTotals(lines, 30, 'inter_state')
  assert.deepEqual([t.discountBp, t.cgstPaise, t.sgstPaise, t.igstBp], [475, 0, 0, 500])
})

test('untaxed small party: no 4.75 % discount and no GST (owner, 23 Nov 2026)', () => {
  const t = computeBillTotals(lines, 30, 'untaxed')
  assert.equal(defaultDiscountBp('untaxed'), 0)
  assert.deepEqual([t.discountPaise, t.cgstPaise, t.sgstPaise, t.igstPaise], [0, 0, 0, 0])
  assert.equal(t.netPaise, t.grossPaise)
})

test('walk-in: the typed discount (default none)', () => {
  const none = computeBillTotals(lines, 30, 'untaxed', { discountBp: 0 })
  const ten = computeBillTotals(lines, 30, 'untaxed', { discountBp: 1000 })
  assert.equal(ten.discountPaise, Math.floor((none.grossPaise * 1000 + 5000) / 10000))
  assert.throws(() => computeBillTotals(lines, 30, 'untaxed', { discountBp: 10001 }), /between 0 and 100/)
})

test('old bills keep their amounts: round-off can be turned off', () => {
  const t = computeBillTotals(lines, 30, 'intra_state', { roundOff: false })
  assert.equal(t.roundOffPaise, 0)
  assert.equal(t.grandTotalPaise, t.netPaise)
})
