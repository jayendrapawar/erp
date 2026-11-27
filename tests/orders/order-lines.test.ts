import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeMatrix, matrixPairs, type MatrixArticle } from '../../lib/orders/order-lines'
import { setLabel, type PrintSet } from '../../lib/orders/pick-list-print'
import type { OrderLine } from '../../lib/orders/drafts'

const sizes = [6, 7, 8, 9, 10].map((n, i) => ({ id: i + 1, articleId: 1, sizeLabel: String(n), sortOrder: i, artCode: 'A', key: String(n) }))
const art: MatrixArticle = {
  id: 1, artNumber: 'SS-810',
  colors: [{ id: 11, articleId: 1, colorName: 'BLACK', colorHex: null }, { id: 12, articleId: 1, colorName: 'NAVY', colorHex: null }],
  sizes,
}
let n = 0
const id = () => `new-${++n}`

describe('New Order: the size grid goes into the order first (owner, 27 Nov 2026)', () => {
  test('typed but not added: becomes a line; zero sizes and empty colours left out', () => {
    const r = mergeMatrix([], art, { 11: { 6: 1, 7: 0, 8: 2 }, 12: { 6: 0 } }, null, id)
    assert.equal(r.added, 1)
    assert.equal(r.lines.length, 1)
    assert.deepEqual(r.lines[0].quantities, { 6: 1, 8: 2 })
    assert.equal(r.lines[0].colorName, 'BLACK')
    assert.equal(r.lines[0].sizes.length, 5)
  })

  test('a colour already in the order is replaced, not added twice', () => {
    const line: OrderLine = { id: 'x', articleId: 1, artNumber: 'SS-810', colorId: 11, colorName: 'BLACK', colorHex: null, sizes, quantities: { 6: 5 } }
    const r = mergeMatrix([line], art, { 11: { 7: 2 } }, null, id)
    assert.equal(r.lines.length, 1)
    assert.deepEqual(r.lines[0].quantities, { 7: 2 })
    assert.equal(r.lines[0].id, 'x')
  })

  test('nothing typed: the same lines come back (nothing to add)', () => {
    const lines: OrderLine[] = []
    const r = mergeMatrix(lines, art, { 11: {} }, null, id)
    assert.equal(r.added, 0)
    assert.equal(r.lines, lines)
    assert.equal(mergeMatrix(lines, null, { 11: { 6: 1 } }, null, id).added, 0)
  })

  test('grid pairs count only the open article', () => {
    assert.equal(matrixPairs(art, { 11: { 6: 1, 7: 2 }, 12: { 8: 1 }, 99: { 6: 4 } }), 4)
    assert.equal(matrixPairs(null, { 11: { 6: 1 } }), 0)
  })
})

describe('print: a line that is a set prints as the set (owner, 27 Nov 2026)', () => {
  const sets: PrintSet[] = [{ name: '6x10', quantities: { 6: 1, 7: 1, 8: 2, 9: 1, 10: 1 } }, { name: '6x8', quantities: { 6: 1, 7: 1, 8: 1 } }]
  const m = (q: Record<string, number>) => new Map(Object.entries(q))
  test('exactly the set → "6x10 - 1"; twice the set → "6x10 - 2"', () => {
    assert.equal(setLabel(m({ 6: 1, 7: 1, 8: 2, 9: 1, 10: 1 }), sets), '6x10 - 1')
    assert.equal(setLabel(m({ 6: 2, 7: 2, 8: 4, 9: 2, 10: 2 }), sets), '6x10 - 2')
    assert.equal(setLabel(m({ 6: 3, 7: 3, 8: 3 }), sets), '6x8 - 3')
  })
  test('not a set (a size more, a size less, uneven) → sizes are printed', () => {
    assert.equal(setLabel(m({ 6: 1, 7: 1, 8: 2, 9: 1 }), sets), null)
    assert.equal(setLabel(m({ 6: 1, 7: 1, 8: 2, 9: 1, 10: 1, 11: 1 }), sets), null)
    assert.equal(setLabel(m({ 6: 2, 7: 1, 8: 4, 9: 2, 10: 2 }), sets), null)
    assert.equal(setLabel(m({ 6: 1 }), []), null)
  })
  test('two sets fit → the bigger set (fewer of them)', () => {
    const both = [{ name: 'one-each', quantities: { 6: 1, 7: 1 } }, { name: 'two-each', quantities: { 6: 2, 7: 2 } }]
    assert.equal(setLabel(m({ 6: 4, 7: 4 }), both), 'two-each - 2')
  })
})

describe('print page uses the set label', () => {
  test('the pick list shows "6x10 - 1" in place of the sizes; other lines keep their sizes', async () => {
    const { pickListHtml } = await import('../../lib/orders/pick-list-print')
    const items = [
      ...[['6', 1], ['7', 1], ['8', 2], ['9', 1], ['10', 1]].map(([s, q]) => ({ artNumber: 'SS-810', colorNumber: 'BLACK', sizeNumber: s as string, quantityOrdered: q as number })),
      { artNumber: 'SS-810', colorNumber: 'NAVY', sizeNumber: '7', quantityOrdered: 3 },
    ]
    const html = pickListHtml([{ orderNumber: 'ORD-1', shopkeeperName: 'A', orderedAt: new Date(2026, 10, 27), items,
      sets: [{ name: '6x10', quantities: { 6: 1, 7: 1, 8: 2, 9: 1, 10: 1 } }] }], 'A5', 'portrait', { autoPrint: false })
    assert.match(html, /<td class="c">BLACK<\/td><td class="s">6x10 - 1<\/td>/)
    assert.match(html, /<td class="c">NAVY<\/td><td class="s">7\/3<\/td>/)
    assert.match(html, /<b>9 pairs<\/b>/) // the total still counts pairs
  })
})
