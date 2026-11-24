import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { columnsFor, pickListHtml, type PickOrder } from '../../lib/orders/pick-list-print'

const order: PickOrder = {
  orderNumber: 'ORD-20261124-1000AB', shopkeeperName: 'PATEL <FOOTWEAR>', hindiName: 'पटेल फुटवियर', address: 'Udhna, Surat',
  orderedAt: new Date(2026, 10, 24, 9, 5), salesman: 'Asha',
  items: [
    { artNumber: 'SS-810', colorNumber: 'BKDG', sizeNumber: '7', quantityOrdered: 3 },
    { artNumber: 'SS-810', colorNumber: 'BKDG', sizeNumber: '6', quantityOrdered: 2 },
    { artNumber: 'SS-810', colorNumber: 'NBCP', sizeNumber: '10', quantityOrdered: 1 },
    { artNumber: 'PUG-90', colorNumber: 'BRBR', sizeNumber: '8', quantityOrdered: 4 },
  ],
}

describe('compact order print (owner, 24 Nov 2026)', () => {
  test('as many columns as fit the paper', () => {
    assert.deepEqual(
      [columnsFor('A5', 'portrait'), columnsFor('A5', 'landscape'), columnsFor('A4', 'portrait'), columnsFor('A4', 'landscape')],
      [2, 3, 3, 4],
    )
  })

  test('one line per colour, sizes in order, article named once, total and salesman', () => {
    const html = pickListHtml([order], 'A5', 'portrait', { autoPrint: false })
    assert.match(html, /column-count: 2/)
    assert.match(html, /size: A5 portrait/)
    assert.equal((html.match(/<tr>/g) ?? []).length, 3) // BKDG, NBCP, BRBR
    assert.match(html, /<td class="a">SS-810<\/td><td class="c">BKDG<\/td><td class="s">6\/2 7\/3<\/td>/)
    assert.match(html, /<td class="a"><\/td><td class="c">NBCP<\/td>/) // article not repeated
    assert.match(html, /<b>10 pairs<\/b>/)
    assert.match(html, /SM: Asha/)
    assert.match(html, /PATEL &lt;FOOTWEAR&gt;/) // names are escaped
    assert.match(html, /ORD-20261124-1000AB · 24\/11 09:05/)
    assert.doesNotMatch(html, /window\.print/)
  })
})
