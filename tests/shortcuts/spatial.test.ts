import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickNext, type Box } from '../../lib/shortcuts/spatial'

const b = (left: number, top: number, w = 80, h = 30): Box => ({ left, top, right: left + w, bottom: top + h })

// A form: two buttons on one row, a field below the first, a wide button at the bottom.
//   [A]  [B]
//   [C ........]
//   [D]        [E]
const A = b(0, 0), B = b(100, 0), C = b(0, 50, 300), D = b(0, 100), E = b(220, 100)
const all = [A, B, C, D, E]
const next = (from: Box, dir: Parameters<typeof pickNext>[2]) => { const i = pickNext(from, all.filter((x) => x !== from), dir); return i < 0 ? null : all.filter((x) => x !== from)[i] }

test('arrows pick the nearest control in that direction', () => {
  assert.equal(next(A, 'right'), B)
  assert.equal(next(B, 'left'), A)
  assert.equal(next(A, 'down'), C)
  assert.equal(next(B, 'down'), C) // the wide field below overlaps B
  assert.equal(next(C, 'down'), D) // the closest in line (left edge), not E
  assert.equal(next(D, 'right'), E) // same row
  assert.equal(next(E, 'up'), C)
  assert.equal(next(C, 'up'), B) // both A and B are right above; B is nearer C's centre
})

test('nothing in that direction: no move (the page scrolls as usual)', () => {
  assert.equal(next(A, 'up'), null)
  assert.equal(next(A, 'left'), null)
  assert.equal(next(E, 'right'), null)
  assert.equal(next(D, 'down'), null)
})

test('sideways stays on the same line before jumping to another one', () => {
  // [X]            [Y]
  //     [Z]  (lower, but closer)
  const X = b(0, 0), Y = b(400, 0), Z = b(100, 60)
  assert.equal(pickNext(X, [Y, Z], 'right'), 0)
})
