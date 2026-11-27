import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, parseRelaxoBill, rangeCode, suggestDivision } from '../../lib/purchases/relaxo-bill'
import { divisionForArticleCode } from '../../lib/qr-config'

// Shape of the text pdf.js extracts from a Relaxo proforma invoice (synthetic values; no
// customer address or GSTIN). Line 2 wraps over three lines like long descriptions do.
const page1 = [
  'For RELAXO FOOTWEARS LIMITED',
  'PERFORMA INVOICE',
  'RELAXO FOOTWEARS LIMITED',
  'PO No. : PO-0000000001-26.08.,',
  'Customer Code :',
  '12345678',
  'Invoice No. :',
  'Date :',
  'SO No. :',
  'SO Date :',
  'Ref :',
  'RV0000000001',
  '27.08.2026',
  '500000001,',
  '26.08.2026,',
  '0520000001/1062',
  'S.',
  '1 64029990 PUG186G-DTDT0810, PUG 186 G D. TAN 0810 /1 A 1 30 30 299.50 199.65 5989.50 539.06',
  '9.00 %',
  '2 64029990 PUG183G-MBMB0810, PUG 183 G MOUSE BROWN 0810',
  '/3',
  'A 3 36 108 289.50 193.00 20844.00 1875.96',
].join('\n')
const page2 = [
  'PERFORMA INVOICE',
  '3 64041110 PUL0A5L-BKPK0406, PUL 5A LADIES, BKPK0406 , /1 A 1 48 48 204.50 129.65 6223.20 560.09 0.00 0.00 5663.11',
  'Total 5 186 33,056.70 2,975.11 0.00 0.00 30081.59 0 0 1504.08 0.00 31585.67',
].join('\n')

describe('Relaxo bill reader', () => {
  test('reads header, lines (including wrapped ones) and checks totals', () => {
    const r = parseRelaxoBill([page1, page2])
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    const b = r.bill
    assert.equal(b.docType, 'proforma')
    assert.deepEqual([b.refNo, b.invoiceNo, b.billDate, b.soNo, b.soDate, b.customerCode], ['0520000001/1062', 'RV0000000001', '2026-08-27', '500000001', '2026-08-26', '12345678'])
    assert.deepEqual([b.totalCartons, b.totalPairs, b.grossAmount], [5, 186, 31585.67])
    assert.deepEqual(b.lines.map((l) => [l.articleCode, l.colourCode, l.sizeFrom, l.sizeTo, l.packLetter, l.cartons, l.pairsPerCarton, l.pairs, l.mrp]), [
      ['PUG186G', 'DTDT', '8', '10', 'A', 1, 30, 30, 299.5],
      ['PUG183G', 'MBMB', '8', '10', 'A', 3, 36, 108, 289.5],
      ['PUL0A5L', 'BKPK', '4', '6', 'A', 1, 48, 48, 204.5],
    ])
    assert.equal(b.lines[1].description, 'PUG 183 G MOUSE BROWN 0810')
  })

  test('Sparx layout: leading space and the description wrapping before "/n"', () => {
    const page = [
      'PERFORMA INVOICE', 'RELAXO FOOTWEARS LIMITED', 'PO No. : 17/11/2026,', '12345678',
      'RV0526000001', '17.11.2026', '502213564,', '17.11.2026,', '0520426736/1087',
      ' 1 64029190 SS0810G-BKDG0610, SPARX SANDALS 810 G BLACK',
      'D.GREY 0610 /10',
      'A 10 12 120 849.00 566.00 67920.00 6112.80',
      '9.00 %',
      ' 2 64021990 SN1167G-BKSL0610, SPARX SHOES 1167 G BLACK',
      'SILVER 0610 /1',
      'A 1 12 12 1349.00 835.10 10021.20 901.91',
      'Total 11 132 77,941.20 7,014.71 0.00 0.00 70926.49 0 0 3546.32 0.00 74472.81',
    ].join('\n')
    const r = parseRelaxoBill([page])
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    assert.deepEqual([r.bill.refNo, r.bill.billDate, r.bill.poNo], ['0520426736/1087', '2026-11-17', '17/11/2026'])
    assert.deepEqual(r.bill.lines.map((l) => [l.articleCode, l.colourCode, l.sizeFrom, l.sizeTo, l.cartons, l.pairsPerCarton, l.mrp, l.description]), [
      ['SS0810G', 'BKDG', '6', '10', 10, 12, 849, 'SPARX SANDALS 810 G BLACK D.GREY 0610'],
      ['SN1167G', 'BKSL', '6', '10', 1, 12, 1349, 'SPARX SHOES 1167 G BLACK SILVER 0610'],
    ])
  })

  test('single-size carton lines ("00" + size)', () => {
    const page = [
      'PERFORMA INVOICE', 'RELAXO FOOTWEARS LIMITED', '12345678', 'RV0626000002', '28.10.2026', '502200000,', '28.10.2026,', '0520413957/1083',
      '1 64022090 SF0192G-GFSL0007, SFG 192 G, GFSL0007 /1 A 1 24 24 499.50 333.00 7992.00 719.28',
      '2 64022090 SF0192G-GFSL0810, SFG 192 G, GFSL0810 /2 A 2 24 48 499.50 333.00 15984.00 1438.56',
      'Total 3 72 23,976.00 2,157.84 0.00 0.00 21818.16 0 0 1090.91 0.00 22909.07',
    ].join('\n')
    const r = parseRelaxoBill([page])
    assert.ok(r.ok, JSON.stringify(r))
    if (!r.ok) return
    assert.deepEqual(r.bill.lines.map((l) => [l.sizeFrom, l.sizeTo, l.pairsPerCarton]), [['7', '7', 24], ['8', '10', 24]])
  })

  test('refuses a bill whose lines do not add up to its total', () => {
    const r = parseRelaxoBill([page1, page2.replace('Total 5 186', 'Total 6 186')])
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.errors.join(), /5 cartons; the bill total says 6/)
  })

  test('refuses something that is not a Relaxo bill', () => {
    const r = parseRelaxoBill(['Some other PDF'])
    assert.equal(r.ok, false)
  })

  test('helpers', () => {
    assert.equal(rangeCode('6', '10'), '610')
    assert.equal(rangeCode('8', '10'), '810')
    assert.equal(rangeCode('11', '1'), '1101')
    assert.equal(rangeCode('06', '08'), '608')
    assert.equal(addDays('2026-08-27', 5), '2026-09-01')
    assert.equal(addDays('2026-12-30', 5), '2027-01-04')
    assert.equal(suggestDivision([{ articleCode: 'PUG186G' }, { articleCode: 'PUL0A5L' }, { articleCode: 'SS0702B' }], divisionForArticleCode), 'Flite PU')
    // Owner rule: S → Sparx, P → Flite PU, F → Flite EVA, anything else → Bahamas.
    assert.deepEqual(['SS0810G', 'SN1167G', 'PXG001G', 'PUG186G', 'FLN115G', 'FL0366L', 'BH0001G', 'CU0025G', 'HL0005G', ''].map(divisionForArticleCode),
      ['Sparx', 'Sparx', 'Flite PU', 'Flite PU', 'Flite EVA', 'Flite EVA', 'Bahamas', 'Bahamas', 'Bahamas', ''])
  })
})
