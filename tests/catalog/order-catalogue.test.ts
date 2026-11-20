// One article name, several codes with the same sizes (SS-101) must never merge in New Order —
// for existing articles and for any added later.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupArticles, type ColourRow, type SizeRow } from '../../lib/catalog/order-catalogue'
import { sizeWithCode } from '../../lib/orders/size-label'

function build(variants: { id: number; name: string; code: string; colour: string; sizes: string[] }[]) {
  const colours = new Map<number, ColourRow[]>()
  const sizes = new Map<number, SizeRow[]>()
  let sid = 1000
  for (const v of variants) {
    colours.set(v.id, [{ id: v.id * 10, articleId: v.id, colorName: v.colour, colorHex: null }])
    sizes.set(v.id, v.sizes.map((s, i) => {
      const n = Number(s)
      const kids = v.sizes.some(x => Number(x) <= 5) && v.sizes.some(x => Number(x) >= 11)
      return { id: sid++, articleId: v.id, sizeLabel: s, sortOrder: kids && n >= 11 ? n - 20 : Number.isFinite(n) ? n : 100 + i }
    }))
  }
  return groupArticles(variants.map(v => ({ id: v.id, artName: v.name, artCode: v.code })), colours, sizes)
}

const SS101 = [
  { id: 1, name: 'SS-101', code: 'SS0101C', colour: 'Black', sizes: ['11', '12', '13', '1'] },
  { id: 2, name: 'SS-101', code: 'SS0101G', colour: 'Black', sizes: ['6', '7', '8', '9', '10'] },
  { id: 3, name: 'SS-101', code: 'SS0101S', colour: 'Black', sizes: ['11', '12'] },
  { id: 4, name: 'SS-101', code: 'SS0101C', colour: 'Camel', sizes: ['11', '12', '13', '1'] },
  { id: 5, name: 'SS-101', code: 'SS0101S', colour: 'Camel', sizes: ['11', '12'] },
]

test('SS-101 Black: children 11–12 and big 11–12 stay separate, in a sensible order', () => {
  const d = build(SS101).get('SS-101')!
  const black = d.colors.find(c => c.colorName === 'Black')!
  const rows = d.sizes.filter(s => s.articleId === black.articleId)
  assert.deepEqual(rows.map(s => s.key), [
    'SS0101C:11', 'SS0101C:12', 'SS0101C:13', 'SS0101C:1',
    'SS0101G:6', 'SS0101G:7', 'SS0101G:8', 'SS0101G:9', 'SS0101G:10',
    'SS0101S:11', 'SS0101S:12',
  ])
  assert.equal(new Set(rows.map(s => s.key)).size, rows.length)
})

test('an article with one code keeps plain size keys (nothing changes for it)', () => {
  const d = build([{ id: 9, name: 'FL-48', code: 'FL0048G', colour: 'Black', sizes: ['6', '7', '8'] }]).get('FL-48')!
  assert.deepEqual(d.sizes.map(s => s.key), ['6', '7', '8'])
})

test('a new code added later to an existing name is kept apart too', () => {
  const more = [...SS101, { id: 6, name: 'SS-101', code: 'SS0101X', colour: 'Black', sizes: ['11', '12', '13'] }]
  const d = build(more).get('SS-101')!
  const black = d.colors.find(c => c.colorName === 'Black')!
  const rows = d.sizes.filter(s => s.articleId === black.articleId)
  assert.equal(rows.filter(s => s.sizeLabel === '11').length, 3)
  assert.equal(new Set(rows.map(s => s.key)).size, rows.length)
})

test('any mix of names, codes, colours and sizes: two different code+size pairs never share a key', () => {
  let seed = 7
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const labels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']
  for (let round = 0; round < 200; round++) {
    const variants = Array.from({ length: 2 + rnd(8) }, (_, i) => ({
      id: i + 1,
      name: `N-${rnd(2)}`,
      code: `C${rnd(4)}`,
      colour: ['Black', 'black ', 'Red', 'Navy Blue'][rnd(4)],
      sizes: [...new Set(Array.from({ length: 1 + rnd(6) }, () => labels[rnd(labels.length)]))],
    }))
    // one variant per code + colour (as in the master)
    const unique = variants.filter((v, i) => variants.findIndex(o => o.code === v.code && o.colour.trim().toLowerCase() === v.colour.trim().toLowerCase() && o.name === v.name) === i)
    for (const d of build(unique).values()) {
      for (const c of d.colors) {
        const rows = d.sizes.filter(s => s.articleId === c.articleId)
        const pairs = new Set(rows.map(s => `${s.artCode}|${s.sizeLabel}`))
        assert.equal(new Set(rows.map(s => s.key)).size, pairs.size, `round ${round}: ${d.artNumber} ${c.colorName}`)
      }
    }
  }
})

test('order screens add the code only where a size appears for two codes', () => {
  const items = [
    { sizeNumber: '11', artCode: 'SS0101C' }, { sizeNumber: '11', artCode: 'SS0101S' },
    { sizeNumber: '6', artCode: 'SS0101G' }, { sizeNumber: '7', artCode: null },
  ]
  assert.deepEqual(items.map(i => sizeWithCode(i, items)), ['11 (SS0101C)', '11 (SS0101S)', '6', '7'])
})
