import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canFindRetailers, cleanQuery, likePattern, orderScope, recordHref, type RecordRow } from '../../lib/search/records'
import { readUrlFilters } from '../../lib/use-url-filters'

const row = (o: Partial<RecordRow>): RecordRow => ({ kind: 'order', id: '1', title: 'ORD-1', sub: 'Patel', status: 'pending', salesman_id: 'u1', ...o })

test('search runs only after 2+ characters; % and _ are searched as themselves', () => {
  assert.equal(cleanQuery('a'), null)
  assert.equal(cleanQuery('  '), null)
  assert.equal(cleanQuery('  ss  101 '), 'ss 101')
  assert.equal(cleanQuery('x'.repeat(100))?.length, 60)
  assert.equal(likePattern('10%_a'), '%10\\%\\_a%')
})

test('each role finds the orders its own screens show', () => {
  assert.deepEqual(orderScope(['admin']), { all: true })
  assert.deepEqual(orderScope(['accountant']), { all: true })
  assert.deepEqual(orderScope(['salesman']), { salesman: true, statuses: [] })
  assert.deepEqual(orderScope(['picker']), { salesman: false, statuses: ['pending', 'assigned'] })
  assert.deepEqual(orderScope(['biller', 'dispatcher']), { salesman: false, statuses: ['packed', 'billed', 'dispatched'] })
  assert.equal(orderScope(['warehouse']), null)
  assert.equal(canFindRetailers(['warehouse']), false)
  assert.equal(canFindRetailers(['salesman']), true)
  assert.equal(canFindRetailers(['accountant']), true)
})

test('a found record opens the right list with its filter in the address', () => {
  assert.equal(recordHref(row({}), ['admin'], 'x'), '/orders/admin?f.order=ORD-1#overview')
  assert.equal(recordHref(row({ salesman_id: 'me' }), ['salesman'], 'me'), '/orders?f.order=ORD-1#salesman')
  assert.equal(recordHref(row({ status: 'packed' }), ['biller'], 'me'), '/orders?f.order=ORD-1#biller')
  assert.equal(recordHref(row({ status: 'assigned', salesman_id: 'other' }), ['salesman', 'picker'], 'me'), '/orders?f.order=ORD-1#picker')
  assert.equal(recordHref(row({ kind: 'retailer', title: 'Patel & Sons' }), ['accountant'], 'x'), '/master?f.name=Patel+%26+Sons#vendors')
  assert.equal(recordHref(row({ kind: 'retailer', title: 'Patel' }), ['salesman'], 'x'), '/orders?f.shop=Patel#salesman')
  assert.equal(recordHref(row({ kind: 'article', title: 'SS0101C' }), ['warehouse'], 'x'), '/inventory?f.code=SS0101C#stock')
  assert.deepEqual(readUrlFilters('?f.name=Patel+%26+Sons&x=1&f.code='), { name: 'Patel & Sons' })
})
