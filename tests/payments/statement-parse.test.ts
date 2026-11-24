import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chequeNoOf, guessColumns, guessMode, likelyHeaderRow, lineKeys, parseStatement, payerKeyOf, readStatementAmount, readStatementDate,
} from '../../lib/payments/statement-parse'

test('statement dates and amounts in the forms banks use', () => {
  assert.equal(readStatementDate('01/04/2026'), '2026-04-01')
  assert.equal(readStatementDate('01-Apr-2026'), '2026-04-01')
  assert.equal(readStatementDate('1 Apr 26'), '2026-04-01')
  assert.equal(readStatementDate('01/04/2026 10:22:13'), '2026-04-01')
  assert.equal(readStatementDate(46113), '2026-04-01')
  assert.equal(readStatementDate('Opening balance'), null)
  assert.equal(readStatementAmount('1,23,456.50'), 12345650)
  assert.equal(readStatementAmount('500.00 Cr'), 50000)
  assert.equal(readStatementAmount(''), null)
  assert.equal(readStatementAmount('-'), null)
})

test('payer key, mode and cheque number from the details', () => {
  assert.equal(payerKeyOf('UPI/CR/412345678901/RAMESH KUMAR/SBIN/ramesh.k@oksbi/Payment'), 'ramesh.k@oksbi')
  assert.equal(payerKeyOf('NEFT-HDFC0001234-SHREE GANESH TRADERS-N123456789'), 'SHREE GANESH TRADERS')
  assert.equal(payerKeyOf('BY CLG CHQ 000123 OM SHOES'), 'OM SHOES')
  assert.equal(guessMode('UPI/CR/1234/RAMESH', ''), 'upi')
  assert.equal(guessMode('BY CLG CHQ 000123 OM SHOES', ''), 'cheque')
  assert.equal(guessMode('NEFT-HDFC0001234-SHREE', 'N123'), 'bank')
  assert.equal(chequeNoOf('BY CLG CHQ 000123 OM SHOES', ''), '000123')
  assert.equal(chequeNoOf('anything', '445566'), '445566')
})

test('a statement: header found below bank title lines; credits and debits; totals skipped; same line twice stays two', () => {
  const cells = [
    { rowNumber: 1, values: ['STATE BANK OF INDIA', '', '', '', '', ''] },
    { rowNumber: 2, values: ['Account Statement 01-11-2026 to 24-11-2026'] },
    { rowNumber: 4, values: ['Txn Date', 'Description', 'Ref No', 'Debit', 'Credit', 'Balance'] },
    { rowNumber: 5, values: ['01/11/2026', 'UPI/CR/1/RAMESH/ramesh@oksbi', '4123', '', '5,000.00', '1,05,000.00'] },
    { rowNumber: 6, values: ['01/11/2026', 'UPI/CR/1/RAMESH/ramesh@oksbi', '4123', '', '5,000.00', '1,10,000.00'] },
    { rowNumber: 7, values: ['02/11/2026', 'SMS CHARGES', '', '17.70', '', '1,09,982.30'] },
    { rowNumber: 8, values: ['', 'Total', '', '17.70', '10,000.00', ''] },
  ]
  assert.equal(likelyHeaderRow(cells), 2)
  const cols = guessColumns(cells[2].values)
  assert.deepEqual(cols, { date: 'Txn Date', details: 'Description', reference: 'Ref No', credit: 'Credit', debit: 'Debit', balance: 'Balance' })
  const p = parseStatement(cells, cols as never)
  assert.deepEqual(p.lines.map((l) => [l.txnDate, l.creditPaise, l.debitPaise, l.payerKey]), [
    ['2026-11-01', 500000, 0, 'ramesh@oksbi'], ['2026-11-01', 500000, 0, 'ramesh@oksbi'], ['2026-11-02', 0, 1770, ''],
  ])
  const keys = lineKeys(7, p.lines)
  assert.notEqual(keys[0], keys[1]) // two identical UPI credits the same day are two lines
  assert.deepEqual(lineKeys(7, p.lines), keys) // the same file again gives the same keys
  // Amount + Dr/Cr layout.
  const q = parseStatement([
    { rowNumber: 1, values: ['Date', 'Narration', 'Amount', 'Dr/Cr'] },
    { rowNumber: 2, values: ['05-Nov-2026', 'NEFT OM SHOES', '2500', 'CR'] },
    { rowNumber: 3, values: ['05-Nov-2026', 'BANK CHARGES', '50', 'DR'] },
  ], { date: 'Date', details: 'Narration', amount: 'Amount', drcr: 'Dr/Cr' })
  assert.deepEqual(q.lines.map((l) => [l.creditPaise, l.debitPaise]), [[250000, 0], [0, 5000]])
  assert.match(parseStatement(cells, { date: 'Nope', details: 'Description', credit: 'Credit' }).problems[0], /not found/)
})
