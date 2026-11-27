import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOpeningSheet, readAmount, readDate } from '../../lib/payments/opening'

test('opening balance sheet: dates, amounts, advance, column names', () => {
  assert.equal(readDate('01/04/2026'), '2026-04-01')
  assert.equal(readDate('1-4-26'), '2026-04-01')
  assert.equal(readDate('2026-04-01'), '2026-04-01')
  assert.equal(readDate(46113), '2026-04-01') // Excel day number
  assert.equal(readDate('31/02/2026'), null)
  assert.equal(readAmount('1,23,456.50'), 12345650)
  assert.equal(readAmount('₹ 500'), 50000)
  assert.equal(readAmount(-200), -20000)
  assert.equal(readAmount('abc'), null)
  const p = parseOpeningSheet([
    { rowNumber: 1, values: ['Party Name', 'As on date', 'Balance', 'Dr/Cr', 'Old bill no', 'Remarks'] },
    { rowNumber: 2, values: ['Om Shoes', '01/04/2026', '12,000', 'Dr', 'A-101', ''] },
    { rowNumber: 3, values: ['Delhi Traders', '01/04/2026', '500', 'Cr', '', 'advance'] },
    { rowNumber: 4, values: ['', '', null] },
    { rowNumber: 5, values: ['Bad Row', 'tomorrow', 'x'] },
  ])
  assert.deepEqual(p.missingColumns, [])
  assert.deepEqual(p.rows.map((r) => [r.party, r.date, r.amountPaise, r.billNo]), [
    ['Om Shoes', '2026-04-01', 1200000, 'A-101'], ['Delhi Traders', '2026-04-01', -50000, ''], ['Bad Row', '', 0, ''],
  ])
  assert.equal(p.problems.filter((x) => x.rowNumber === 5).length, 2)
  assert.deepEqual(parseOpeningSheet([{ rowNumber: 1, values: ['Name', 'Amount'] }]).missingColumns, ['Date'])
})
