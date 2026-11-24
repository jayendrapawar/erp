import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { columnsFor, geometry, packColumns, pickListHtml, type MeasuredBlock, type PickOrder } from '../../lib/orders/pick-list-print'

const order: PickOrder = {
  orderNumber: 'ORD-7', shopkeeperName: 'PATEL <FOOTWEAR>', hindiName: 'पटेल फुटवियर', address: 'Udhna, Surat',
  orderedAt: new Date(2026, 10, 24, 9, 5), salesman: 'Asha',
  items: [
    { artNumber: 'SS-810', colorNumber: 'BKDG', sizeNumber: '7', quantityOrdered: 3 },
    { artNumber: 'SS-810', colorNumber: 'BKDG', sizeNumber: '6', quantityOrdered: 2 },
    { artNumber: 'SS-810', colorNumber: 'NBCP', sizeNumber: '10', quantityOrdered: 1 },
    { artNumber: 'PUG-90', colorNumber: 'BRBR', sizeNumber: '8', quantityOrdered: 4 },
  ],
}
const block = (rows: number[], head = 8, foot = 4): MeasuredBlock => ({ head, rows, foot, contdHead: 5 })

describe('compact order print (owner, 24 Nov 2026)', () => {
  test('as many columns as fit the paper', () => {
    assert.deepEqual(
      [columnsFor('A5', 'portrait'), columnsFor('A5', 'landscape'), columnsFor('A4', 'portrait'), columnsFor('A4', 'landscape')],
      [2, 3, 3, 4],
    )
    assert.equal(geometry('A5', 'portrait').columnH, 199)
  })

  test('one numbered line per colour, sizes in order, article named once, total and salesman', () => {
    const html = pickListHtml([order], 'A5', 'portrait', { autoPrint: false })
    assert.match(html, /size: A5 portrait/)
    assert.equal((html.match(/<tr><td class="n">/g) ?? []).length, 3) // BKDG, NBCP, BRBR (the hidden "contd." sample is not a line)
    assert.match(html, /<td class="n">1<\/td><td class="a">SS-810<\/td><td class="c">BKDG<\/td><td class="s">6\/2 7\/3<\/td>/)
    assert.match(html, /<td class="n">2<\/td><td class="a"><\/td><td class="c">NBCP<\/td>/) // article not repeated
    assert.match(html, /<td class="n">3<\/td><td class="a">PUG-90<\/td>/)
    assert.match(html, /<b>10 pairs<\/b>/)
    assert.match(html, /SM: Asha/)
    assert.match(html, /PATEL &lt;FOOTWEAR&gt;/) // names are escaped
    assert.match(html, /ORD-7 · 24\/11 09:05/)
    assert.doesNotMatch(html, /window\.print\(\)/)
  })

  test('placing: longest first, small orders fill the gaps', () => {
    // Column height 100: blocks of 70, 60, 30, 25 → [70+30] [60+25] = 2 columns (in sequence it would be 3).
    const cols = packColumns([block([58]), block([48]), block([18]), block([13])], 100)
    assert.equal(cols.length, 2)
    assert.deepEqual(cols.map((c) => c.map((p) => p.i)), [[0, 2], [1, 3]])
  })

  test('an order taller than a column continues in the next column ("contd."), lines kept in order', () => {
    const rows = Array.from({ length: 30 }, () => 6) // 8 + 180 + 4 = 192 mm, column 100
    const cols = packColumns([block(rows), block([10])], 100)
    const parts = cols.flat().filter((p) => p.i === 0)
    assert.equal(parts.length, 2)
    assert.deepEqual(parts.map((p) => [p.from, p.to, p.first, p.last]), [[0, 15, true, false], [15, 30, false, true]])
    // Second part: 5 + 90 + 4 = 99 of 100, so the small order (14) needs a column of its own.
    assert.equal(cols.length, 3)
  })
})
