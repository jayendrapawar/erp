import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { HEADERS, codeSizes, parseAssortmentSheet, planAssortmentUpload, validateAssortment, type AssortmentInput } from '../../lib/catalog/assortments'

const sizes = (o: Record<string, number>) => Object.entries(o).map(([size, pairs]) => ({ size, pairs }))
const base = (over: Partial<AssortmentInput> = {}): AssortmentInput =>
  ({ division: 'Flite EVA', segment: 'Gents', packing: 30, code: '608', sizes: sizes({ 6: 12, 7: 10, 8: 8 }), ...over })

describe('carton assortment rules', () => {
  test('code reads as a size range, children\'s codes wrap', () => {
    assert.deepEqual(codeSizes('608'), ['6', '7', '8'])
    assert.deepEqual(codeSizes('1101'), ['11', '12', '13', '1'])
    assert.equal(codeSizes('A1'), null)
  })

  test('valid assortment is normalised (case, size order, blanks dropped)', () => {
    const v = validateAssortment(base({ division: 'flite eva', segment: 'GENTS', code: ' 608 ', sizes: sizes({ 8: 8, 6: 12, 7: 10, 9: 0 }) }))
    assert.deepEqual(v.errors, [])
    assert.equal(v.value.division, 'Flite EVA')
    assert.equal(v.value.segment, 'Gents')
    assert.equal(v.value.code, '608')
    assert.deepEqual(v.value.sizes, sizes({ 6: 12, 7: 10, 8: 8 }))
  })

  test('children\'s 1101 sorts 11, 12, 13, 1', () => {
    const v = validateAssortment(base({ segment: 'Kids', packing: 36, code: '1101', sizes: sizes({ 1: 9, 11: 9, 12: 9, 13: 9 }) }))
    assert.deepEqual(v.errors, [])
    assert.deepEqual(v.value.sizes.map(s => s.size), ['11', '12', '13', '1'])
  })

  test('errors: total ≠ pairs, size outside the code, unknown division/segment', () => {
    assert.match(validateAssortment(base({ packing: 24 })).errors.join(), /add up to 30 pairs, but pairs per carton is 24/)
    assert.match(validateAssortment(base({ sizes: sizes({ 6: 12, 7: 10, 9: 8 }) })).errors.join(), /size 9 is outside/)
    assert.match(validateAssortment(base({ division: 'Relaxo' })).errors.join(), /Division "Relaxo" is not one of/)
    assert.match(validateAssortment(base({ segment: 'Men' })).errors.join(), /Segment "Men"/)
    assert.match(validateAssortment(base({ sizes: [] })).errors.join(), /No pairs/)
  })

  test('warning (not error) when a size of the range is empty', () => {
    const v = validateAssortment(base({ code: '609' }))
    assert.deepEqual(v.errors, [])
    assert.match(v.warnings.join(), /no pairs for size 9/)
  })

  test('sheet parsing by header name, total column checked, empty rows skipped', () => {
    const header = [...HEADERS]
    const at = (h: string) => header.indexOf(h as typeof HEADERS[number])
    const mk = (vals: Record<string, unknown>) => { const v: unknown[] = []; for (const [k, x] of Object.entries(vals)) v[at(k)] = x; return v }
    const rows = [
      { rowNumber: 1, values: header },
      { rowNumber: 2, values: mk({ Division: 'Flite EVA', Segment: 'Gents', 'Pairs per carton': 30, 'Assortment code': 608, 6: 12, 7: 10, 8: 8, Total: { formula: 'SUM(E2:Q2)', result: 30 } }) },
      { rowNumber: 3, values: mk({ Total: { formula: 'SUM(E3:Q3)' } }) },
      { rowNumber: 4, values: mk({ Division: 'Flite EVA', Segment: 'Ladies', 'Pairs per carton': 36, 'Assortment code': '405', 4: 12, 5: 24, Total: 30 }) },
      { rowNumber: 5, values: mk({ Division: 'Flite EVA', Segment: 'Gents', 'Pairs per carton': 30, 'Assortment code': '608', 6: 10, 7: 10, 8: 10 }) },
    ]
    const parsed = parseAssortmentSheet(rows)
    assert.deepEqual(parsed.errors, [])
    assert.deepEqual(parsed.rows.map(r => r.row), [2, 4, 5])
    const active = [{ id: 7, division: 'Flite EVA', segment: 'Gents', packing: 30, code: '608', version: 1, sizes: sizes({ 6: 12, 7: 10, 8: 8 }), note: '' }]
    const plan = planAssortmentUpload(parsed.rows, active, ['Flite EVA'])
    assert.equal(plan[0].status, 'same')
    assert.equal(plan[1].status, 'error') // Total column says 30, sizes add up to 36
    assert.match(plan[1].errors.join(), /Total column says 30/)
    assert.equal(plan[2].status, 'error') // same key twice in the file
    assert.match(plan[2].errors.join(), /Same division, segment, pairs, code and "only for" articles as row 2/)
  })

  test('missing columns are reported', () => {
    const r = parseAssortmentSheet([{ rowNumber: 1, values: ['Division', 'Segment', '6', '7'] }])
    assert.match(r.errors.join(), /Pairs per carton.*missing/)
  })
})
