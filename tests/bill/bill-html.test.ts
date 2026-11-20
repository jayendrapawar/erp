import { test } from 'node:test'
import assert from 'node:assert/strict'
import { billTotals, buildInvoiceHtml } from '../../lib/bill-html'
import { DEFAULT_BILL_TEMPLATE, checkBillTemplate, normalizeBillTemplate } from '../../lib/bill-template'

const lines = [{ artNumber: 'SS-101', mrp: 649, qty: 4 }, { artNumber: 'FL-48', mrp: 299, qty: 6 }]

test('totals use the billing screen arithmetic (line discount, 4.75 %, GST)', () => {
  const t = billTotals(lines, 30, 'city')
  // rate = ceil(649 × 0.7) = 455, ceil(299 × 0.7) = 210 → 1820 + 1260
  assert.equal(t.subTotal, 3080)
  assert.equal(t.discAmt, 146.3)
  assert.equal(t.cgstAmt, 73.34)
  assert.equal(t.netAmt, Math.round((3080 - 146.3 + 73.34 + 73.34) * 100) / 100)
  assert.equal(billTotals(lines, 30, 'outside').igstAmt, 146.69)
})

test('template text and retailer names are never HTML', () => {
  const html = buildInvoiceHtml({
    vendor: { name: '<script>x</script>' }, order: { orderNumber: 'DB-1' }, lines,
    template: { ...DEFAULT_BILL_TEMPLATE, shopName: 'A & B <b>', footer: '"quoted"' },
  })
  assert.ok(!html.includes('<script>x'))
  assert.ok(html.includes('A &amp; B &lt;b&gt;'))
  assert.ok(html.includes('&quot;quoted&quot;'))
})

test('saved template is cleaned: defaults fill gaps, odd values are refused', () => {
  const t = normalizeBillTemplate({ shopName: '  ', showQr: 'yes', qrImage: 'javascript:alert(1)', defaultPageSize: 'A3', terms: 'a\r\nb' })
  assert.equal(t.shopName, DEFAULT_BILL_TEMPLATE.shopName)
  assert.equal(t.showQr, true)
  assert.equal(t.qrImage, '')
  assert.equal(t.defaultPageSize, 'A4')
  assert.equal(t.terms, 'a\nb')
  assert.deepEqual(checkBillTemplate({ ...t, gstin: 'BAD', ifsc: 'X', upiId: 'nope' }).length, 3)
})
