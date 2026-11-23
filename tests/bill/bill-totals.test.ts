import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BILL_RATES, billRatesFor, bpToPct, cleanBillRates, computeBillTotals, defaultDiscountBp, ratePaise, ratesBp, toPaise } from '../../lib/billing/bill-totals'
import { normalizeBillTemplate } from '../../lib/bill-template'
import { billTotals } from '../../lib/bill-html'
import { amountsFromTotals, billTotalRows, formatRs } from '../../lib/billing/bill-amounts'
import { prefixesClash } from '../../lib/billing/bill-number'

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

test('screen totals rows: only the taxes the bill has, round off when not zero', () => {
  const rows = (tax: 'intra_state' | 'inter_state' | 'untaxed', opts = {}) =>
    billTotalRows(amountsFromTotals(computeBillTotals(lines, 30, tax, opts), tax)).map((r) => r.key)
  assert.deepEqual(rows('intra_state').filter((k) => k !== 'round'), ['gross', 'disc', 'cgst', 'sgst'])
  assert.deepEqual(rows('inter_state').filter((k) => k !== 'round'), ['gross', 'disc', 'igst'])
  assert.deepEqual(rows('untaxed').filter((k) => k !== 'round'), ['gross', 'nogst']) // no 4.75 %, no GST
  assert.deepEqual(rows('untaxed', { discountBp: 1000 }).filter((k) => k !== 'round'), ['gross', 'disc', 'nogst']) // walk-in typed discount
  const a = amountsFromTotals(computeBillTotals(lines, 30, 'intra_state'), 'intra_state')
  const round = billTotalRows(a).find((r) => r.key === 'round')
  assert.equal(Boolean(round), a.roundOffPaise !== 0)
  assert.equal(formatRs(123456), '₹1,234.56')
})

test('bill number prefixes of the two series must not clash', () => {
  assert.equal(prefixesClash('E', 'E'), true)
  assert.equal(prefixesClash('e', 'E'), true)
  assert.equal(prefixesClash('E', 'E1'), true) // E + 123 = E1 + 23
  assert.equal(prefixesClash('', '26'), true) // 26123 could be either
  assert.equal(prefixesClash('', 'E'), false)
  assert.equal(prefixesClash('SSP/', 'E'), false)
  assert.equal(prefixesClash('E', 'EX'), false)
})

test('editable rates: defaults until typed; typed rates change the totals; bad values refused', () => {
  assert.deepEqual(billRatesFor('intra_state'), DEFAULT_BILL_RATES)
  assert.equal(billRatesFor('untaxed').discountPct, 0)
  assert.equal(billRatesFor('untaxed', DEFAULT_BILL_RATES, { discountPct: 2 }).discountPct, 2)
  const custom = computeBillTotals(lines, 30, 'intra_state', ratesBp({ discountPct: 0, cgstPct: 6, sgstPct: 6, igstPct: 12 }))
  assert.equal(custom.discountPaise, 0)
  assert.equal(custom.cgstBp, 600)
  assert.equal(custom.igstPaise, 0) // IGST only on bills outside the state
  const same = computeBillTotals(lines, 30, 'intra_state', ratesBp(DEFAULT_BILL_RATES))
  assert.deepEqual(same, computeBillTotals(lines, 30, 'intra_state')) // the defaults are today's rates
  assert.deepEqual(cleanBillRates({ discountPct: '4.75', cgstPct: 2.5, sgstPct: 2.5, igstPct: 5 }), DEFAULT_BILL_RATES)
  assert.throws(() => cleanBillRates({ discountPct: 4.755, cgstPct: 2.5, sgstPct: 2.5, igstPct: 5 }), /two decimals/)
  assert.throws(() => cleanBillRates({ discountPct: 4.75, cgstPct: -1, sgstPct: 2.5, igstPct: 5 }), /CGST/)
  assert.throws(() => computeBillTotals(lines, 30, 'inter_state', { igstBp: 10001 }), /GST/)
  // Master → Bill template keeps the rates; odd values fall back to the defaults.
  assert.equal(normalizeBillTemplate({ discountPct: '3.5', igstPct: 500 }).discountPct, 3.5)
  assert.equal(normalizeBillTemplate({ igstPct: 500 }).igstPct, 5)
})
