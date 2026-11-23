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

test('bill pages like the old ERP: page script, page height per paper size, article on every line', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ artNumber: 'PUG' + (i % 5), mrp: 299, qty: 1 }))
  const a4 = buildInvoiceHtml({ vendor: { name: 'X' }, order: { orderNumber: 'B-1' }, lines: many, template: DEFAULT_BILL_TEMPLATE })
  const a5 = buildInvoiceHtml({ vendor: { name: 'X' }, order: { orderNumber: 'B-1' }, lines: many, pageSize: 'A5', template: DEFAULT_BILL_TEMPLATE })
  assert.ok(a4.includes('data-ph="276"') && a5.includes('data-ph="195"'))
  assert.ok(a4.includes('<script>') && a4.includes("'Continued on page '"))
  assert.equal((a4.match(/data-art="PUG0"/g) ?? []).length, 10)   // the name to repeat at the top of a page
})

test('saved amounts print exactly: without GST, round-off, walk-in (migration 0017)', async () => {
  const { amountsFromLines } = await import('../../lib/billing/bill-amounts')
  const { computeBillTotals } = await import('../../lib/billing/bill-totals')
  const base = { vendor: { name: 'Ramesh' }, order: { orderNumber: 'ORD-1', billNo: 'E7' }, lines, lineDiscPct: 30, template: DEFAULT_BILL_TEMPLATE }
  // Within state, rounded to the rupee: CGST, SGST and a Round off line; words = the rounded total.
  const t = computeBillTotals(lines, 30, 'intra_state')
  const taxed = buildInvoiceHtml({ ...base, amounts: { ...amountsFromLines(lines, 30, 'intra_state'), roundOffPaise: t.roundOffPaise, grandTotalPaise: t.grandTotalPaise, frozen: true } })
  assert.ok(taxed.includes('TAX INVOICE') && taxed.includes('CGST 2.5%') && taxed.includes('Discount 4.75%'))
  if (t.roundOffPaise !== 0) assert.ok(taxed.includes('Round off'))
  assert.ok(taxed.includes(`₹${(t.grandTotalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`))
  // Without GST: the template's heading, no GST rows, no 4.75 %.
  const untaxed = buildInvoiceHtml({ ...base, amounts: amountsFromLines(lines, 30, 'untaxed') })
  assert.ok(!untaxed.includes('TAX INVOICE') && untaxed.includes('>BILL<'))
  assert.ok(!/CGST|SGST|IGST|Discount 4\.75/.test(untaxed.replace(/<style>[\s\S]*?<\/style>/, '')))
  // Walk-in: no "M/s."; a party bill keeps it.
  assert.ok(!buildInvoiceHtml({ ...base, amounts: { ...amountsFromLines(lines, 30, 'untaxed'), walkIn: true } }).includes('M/s. Ramesh'))
  assert.ok(untaxed.includes('M/s. Ramesh'))
  // The heading can never be set to "TAX INVOICE" for a bill without GST.
  assert.equal(normalizeBillTemplate({ untaxedHeading: 'Tax  Invoice' }).untaxedHeading, 'BILL')
  assert.equal(normalizeBillTemplate({ untaxedHeading: 'ESTIMATE' }).untaxedHeading, 'ESTIMATE')
})
