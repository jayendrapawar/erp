// Edit bill by scanning: line changes and re-attaching money (pure). lib/billing/bill-edit.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyBoxChanges, reattachAmounts } from '../../lib/billing/bill-edit'
import { readBoxLabel } from '../../lib/billing/box-label'

const box = (articleCode: string, mrp: number | null, k = Math.random().toString(36)) => ({ dedupeKey: k, articleCode, mrp })

test('a box changes the line with its MRP and article, also when the bill uses the order name', () => {
  const lines = [{ artNumber: 'PUG-N42', mrp: 339.5, qty: 2, hsn: '6402' }, { artNumber: 'X', mrp: 160, qty: 3 }]
  const out = applyBoxChanges(lines, [box('PUGN42G', 339.5)], [])
  assert.deepEqual(out.map((l) => [l.artNumber, l.qty, l.hsn]), [['PUG-N42', 3, '6402'], ['X', 3, undefined]])
  assert.equal(lines[0].qty, 2, 'input not changed')
  // Another MRP of the same article is its own line, named by the box.
  const mrp2 = applyBoxChanges(lines, [box('PUGN42G', 349)], [])
  assert.deepEqual(mrp2.at(-1), { artNumber: 'PUGN42G', mrp: 349, qty: 1, hsn: null })
})

test('taking boxes off lowers the line and drops it at 0; a box with no line is refused', () => {
  const lines = [{ artNumber: 'PUG-N42', mrp: 339.5, qty: 2 }, { artNumber: 'X', mrp: 160, qty: 3 }]
  assert.deepEqual(applyBoxChanges(lines, [], [box('PUGN42G', 339.5)]).map((l) => l.qty), [1, 3])
  assert.deepEqual(applyBoxChanges(lines, [], [box('PUGN42G', 339.5), box('PUGN42G', 339.5)]).map((l) => l.artNumber), ['X'])
  assert.throws(() => applyBoxChanges(lines, [], [box('PUGN42G', 339.5), box('PUGN42G', 339.5), box('PUGN42G', 339.5)]), /No line/)
  assert.throws(() => applyBoxChanges(lines, [], [box('FL0548L', 239.5)]), /No line/)
})

test('money set against the bill goes back oldest first, up to the new total', () => {
  const credits = [{ id: 1, amountPaise: 50000 }, { id: 2, amountPaise: 30000 }]
  assert.deepEqual(reattachAmounts(credits, 100000), credits)
  assert.deepEqual(reattachAmounts(credits, 60000), [{ id: 1, amountPaise: 50000 }, { id: 2, amountPaise: 10000 }])
  assert.deepEqual(reattachAmounts(credits, 40000), [{ id: 1, amountPaise: 40000 }])
  assert.deepEqual(reattachAmounts(credits, 0), [])
})

test('the box label reader is the same on the screen and the server', () => {
  const l = readBoxLabel('A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722')
  assert.ok(l.ok)
  if (l.ok) assert.deepEqual([l.box.articleCode, l.box.sizeLabel, l.box.mrp], ['PUGN42G', '6', 339.5])
  assert.equal(readBoxLabel('PUGN42GWHWH0608A339.500109202610101004961646').ok, false) // outer carton
})
