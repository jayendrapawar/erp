import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractText, getDocumentProxy } from 'unpdf'
import { buildBillPdf } from '../../lib/bill-pdf'
import { billTotals } from '../../lib/bill-html'
import { isEmail, parseEmailList } from '../../lib/email-address'

process.env.BETTER_AUTH_SECRET ||= 'test-secret-for-secret-box-only'

const arts = ['PUG183', 'PUL109', 'FL0330G', 'SM1184']
const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ artNumber: arts[i % arts.length], mrp: 299.5 + (i % 3) * 20, qty: 1 + (i % 5) }))

async function pdfText(n: number) {
  const bytes = await buildBillPdf({ vendor: { name: 'Om Shoes', phone: '98250 00000', address: 'Bhatar' }, order: { orderNumber: 'ORD-TEST-1', billedAt: new Date('2026-11-21') }, lines: lines(n), lineDiscPct: 30 })
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  return extractText(pdf, { mergePages: false })
}

test('bill PDF: one page for a short bill, totals match the printed bill', async () => {
  const { totalPages, text } = await pdfText(5)
  assert.equal(totalPages, 1)
  const T = billTotals(lines(5), 30, 'city')
  assert.ok(text[0].includes(T.netAmt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })))
  assert.ok(text[0].includes('Om Shoes') && text[0].includes('ORD-TEST-1'))
})

test('bill PDF: long bill runs over pages; totals only on the last one', async () => {
  const { totalPages, text } = await pdfText(90)
  assert.ok(totalPages >= 3)
  text.slice(0, -1).forEach((p, i) => { assert.ok(p.includes(`Continued on page ${i + 2}`)); assert.ok(!p.includes('Net payable')) })
  assert.ok(text[totalPages - 1].includes('Net payable'))
  assert.ok(text[0].includes(`Page 1 of ${totalPages}`))
})

test('email addresses: one or several, cleaned', () => {
  assert.ok(isEmail('shayonafootwear11@gmail.com'))
  assert.ok(!isEmail('shayona@gmail'))
  assert.deepEqual(parseEmailList(' A@x.com, b@y.in; a@x.com '), { ok: ['a@x.com', 'b@y.in'], bad: [] })
  assert.deepEqual(parseEmailList('a@x.com, nope').bad, ['nope'])
})

test('secret box: sealed value opens again; tampered value does not', async () => {
  const { sealSecret, openSecret } = await import('../../lib/secret-box')
  const sealed = sealSecret('abcd efgh ijkl mnop')
  assert.ok(!sealed.includes('abcd'))
  assert.equal(openSecret(sealed), 'abcd efgh ijkl mnop')
  const parts = sealed.split(':'); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA')
  assert.equal(openSecret(parts.join(':')), null)
})
