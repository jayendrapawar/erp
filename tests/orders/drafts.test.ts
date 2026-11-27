import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftArticles, draftHasContent, draftPairs, MAX_DRAFTS, parseDrafts, upsertDraft, type OrderDraft, type OrderLine,
} from '../../lib/orders/drafts'
import { buildProgress, parseStore, restorableTouched, trimStore, type PackProgress } from '../../lib/orders/pack-progress'

const line = (artNumber: string, quantities: Record<string, number>, colorId = 1): OrderLine => ({
  id: `${artNumber}-${colorId}`, articleId: 10, artNumber, colorId, colorName: 'BLACK', colorHex: null,
  sizes: [{ id: 1, sizeLabel: '7', sortOrder: 1 }], quantities,
})
const draft = (id: string, savedAt: number, lines: OrderLine[] = []): OrderDraft => ({ id, savedAt, vendor: null, lines, notes: '' })

describe('salesman drafts (lib/orders/drafts)', () => {
  test('pairs and articles of a draft', () => {
    const d = draft('a', 1, [line('101', { 6: 2, 7: 3 }), line('101', { 7: 1 }, 2), line('202', { 8: 4 })])
    assert.equal(draftPairs(d), 10)
    assert.equal(draftArticles(d), 2)
  })

  test('a draft is worth keeping with a vendor or a line', () => {
    assert.equal(draftHasContent({ vendor: null, lines: [] }), false)
    assert.equal(draftHasContent({ vendor: { id: '', name: 'RAM', code: null, phone: null, address: null }, lines: [] }), true)
    assert.equal(draftHasContent({ vendor: null, lines: [line('101', { 7: 1 })] }), true)
  })

  test('saving replaces the draft with the same id, newest first, capped', () => {
    let list: OrderDraft[] = []
    list = upsertDraft(list, draft('a', 1))
    list = upsertDraft(list, draft('b', 2))
    list = upsertDraft(list, draft('a', 3))
    assert.deepEqual(list.map(d => d.id), ['a', 'b'])
    for (let i = 0; i < MAX_DRAFTS + 5; i++) list = upsertDraft(list, draft(`x${i}`, 10 + i))
    assert.equal(list.length, MAX_DRAFTS)
    assert.equal(list[0].id, `x${MAX_DRAFTS + 4}`)
  })

  test('damaged or foreign stored text never breaks the screen', () => {
    assert.deepEqual(parseDrafts(null), [])
    assert.deepEqual(parseDrafts('not json'), [])
    assert.deepEqual(parseDrafts('{"a":1}'), [])
    const good = draft('ok', 5, [line('101', { 7: 2 })])
    const bad = { ...draft('bad', 6), lines: [{ artNumber: 1 }] }
    assert.deepEqual(parseDrafts(JSON.stringify([bad, good, null, 'x'])).map(d => d.id), ['ok'])
  })
})

describe('picker packing progress (lib/orders/pack-progress)', () => {
  const order = { updatedAt: new Date('2026-11-22T10:00:00Z') }
  const items = [
    { id: 1, status: 'pending', quantityOrdered: 4 },
    { id: 2, status: 'pending', quantityOrdered: 2 },
    { id: 3, status: 'out_of_stock', quantityOrdered: 3 },
  ]

  test('counts what is done, including sizes packed as 0', () => {
    const p = buildProgress(order, items, { 1: 4, 2: 0 })
    assert.equal(p.packedPairs, 4)
    assert.equal(p.doneOrderedPairs, 9)
    assert.equal(p.doneItems, 3)
    assert.equal(p.totalItems, 3)
  })

  test('comes back only for the same order version and open items', () => {
    const saved = buildProgress(order, items, { 1: 3, 3: 1, 99: 5 })
    assert.deepEqual(restorableTouched(saved, order, items), { 1: 3 })
    // The order changed since (edited by the salesman, released and claimed again): dropped.
    assert.deepEqual(restorableTouched(saved, { updatedAt: '2026-11-22T11:00:00Z' }, items), {})
    assert.deepEqual(restorableTouched(undefined, order, items), {})
  })

  test('stored text is checked and the store keeps the newest orders', () => {
    const p = (savedAt: number): PackProgress => ({ ...buildProgress(order, items, { 1: 1 }), savedAt })
    assert.deepEqual(parseStore('[]'), {})
    assert.deepEqual(Object.keys(parseStore(JSON.stringify({ 5: p(1), 6: { touched: 'x' } }))), ['5'])
    assert.deepEqual(Object.keys(trimStore({ 1: p(1), 2: p(3), 3: p(2) }, 2)).sort(), ['2', '3'])
  })
})
