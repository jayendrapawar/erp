// Statement PDF reader (lib/payments/statement-pdf.ts). A made-up two-page statement laid out like The
// Sarvodaya Sahakari Bank's "Statement Of Accounts" (positions as pdf.js gives them; names invented).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPdfStatement, type PdfText, type PdfTextPage } from '../../lib/payments/statement-pdf'
import { chequeNoOf, guessColumns, parseStatement, payerKeyOf, type StatementColumns } from '../../lib/payments/statement-parse'

const W = 5 // width per character (near enough for placing)
const at = (s: string, x: number, y: number): PdfText => ({ s, x, y, w: s.length * W })
const right = (s: string, r: number, y: number): PdfText => at(s, r - s.length * W, y)

function pageTop(n: number): PdfText[] {
  return [
    at('The Sample Co-operative Bank Ltd. Main Road,', 37.5, 704.7), at('SAMPLE SHOE TRADERS', 43.5, 685.7), at('Account No:', 414.8, 643.9),
    at(`${n}`, 546.7, 614.1), at('Statement Of Accounts', 280.7, 611.7),
    at('Date', 38.5, 588), at('Particulars', 84.4, 588), at('Chq No.', 249.3, 588), at('Value Date', 282, 588),
    at('Debit', 383.9, 588), at('Credit', 458.6, 588), at('Balance', 542.9, 588),
  ]
}
/** One entry: the amounts row at y; particulars start on it and wrap below (9 apart). */
function entry(y: number, date: string, details: string[], chq: string, debit: string, credit: string, balance: string): PdfText[] {
  return [
    at(date, 38.5, y), ...details.map((d, i) => at(d, 85.3, y + 0.5 - 9 * i)),
    ...(chq ? [right(chq, 279, y)] : []), at(date, 282.5, y),
    right(debit, 405, y), right(credit, 484, y), right(`${balance} Cr`, 574, y),
  ]
}
const footer = (n: number, of: number): PdfText[] => [at('Page No :-', 405.5, 21.1), at(`${n}`, 489.6, 22.1), at('Of', 508.3, 21.1), at(`${of}`, 529.8, 22.1)]

function statement(opts: { e1Balance?: string; creditTotal?: string } = {}): PdfTextPage[] {
  const p1: PdfText[] = [
    ...pageTop(1),
    at('Opening Balance', 85.3, 573.7), right('1000.00 Cr', 574, 573.7),
    ...entry(561.7, '20-10-2026', ['By-Clg. ALPHA SHOES Br-, Chq :', '850309, Seq : 19102619001969, Bank : YES', 'BANK LTD., Br : MAIN'], '850309', '0.00', '500.00', opts.e1Balance ?? '1500.00'),
    ...entry(525.7, '20-10-2026', ['By-Outward Return BETA TRADERS', 'Br-, Chq : 330, Seq : 26102619002568,', 'Bank : CANARA BANK'], '', '0.00', '200.00', '1700.00'),
    ...entry(498.7, '20-10-2026', ['To-Outward Return Clg Return, Chq :', '330, Seq : 26102619002568 Return', 'Reason :Funds Insufficient'], '', '200.00', '0.00', '1500.00'),
    ...entry(471.7, '21-10-2026', ['By-Clg. GAMMA FOOTWEAR, Chq : 43,'], '43', '0.00', '100.00', '1600.00'),
    at('21-10-2026', 36, 41.7), at('Balance C/F', 90.4, 40.8), right('200.00', 400, 40.8), right('800.00', 480, 40.8), right('1600.00', 555, 40.8), at('Cr', 558.7, 40.8),
    ...footer(1, 2),
  ]
  const p2: PdfText[] = [
    ...pageTop(2),
    at('21-10-2026', 38.5, 573.7), at('Balance B/F', 85.3, 573.7), right('1600.00 Cr', 574, 573.7),
    at('Seq : 21102619002102, Bank : BANK OF BARODA', 85.3, 562.2), // the last entry of page 1 carries on
    ...entry(552.7, '22-10-2026', ['By-Cash'], '', '0.00', '1000.00', '2600.00'),
    ...entry(540.3, '22-10-2026', ['To-S TFR IMPS - RRN : 629417087059, To :', 'own account/YESB0000841'], '', '300.00', '0.00', '2300.00'),
    ...entry(513.3, '22-10-2026', ['By-S TFR IMPS Rev - STAN : 125639 - RRN :', '629417087059 (Trn From 1001 Br)'], '', '0.00', '300.00', '2600.00'),
    at('Closing Balance', 85.3, 490), right('0.00', 405, 490), right('300.00', 484, 490), right('2600.00 Cr', 574, 490),
    right('500.00', 405, 476.4), right(opts.creditTotal ?? '2100.00', 484, 476.4), at('Total :', 85.3, 474.5),
    right('2', 405, 460.3), right('5', 484, 460.3), at('No Of Tranaction(s) :', 85.3, 459.2),
    at('This is a computerised statement & does not require a signature.', 366.3, 450.9), at('***End Of Statement***', 269.1, 436.8),
    ...footer(2, 2),
  ]
  return [{ items: p1 }, { items: p2 }]
}

test('PDF statement: rows rebuilt from positions; wrapped particulars and a page break joined; checks pass', () => {
  const r = readPdfStatement(statement())
  assert.deepEqual(r.errors, [])
  assert.equal(r.checks.length, 4) // balances, closing balance, totals, counts
  assert.deepEqual(r.cells[0].values, ['Date', 'Particulars', 'Chq No.', 'Value Date', 'Debit', 'Credit', 'Balance'])
  assert.equal(r.cells.length, 1 + 7)
  assert.deepEqual(r.cells[1].values, ['20-10-2026', 'By-Clg. ALPHA SHOES Br-, Chq : 850309, Seq : 19102619001969, Bank : YES BANK LTD., Br : MAIN', '850309', '20-10-2026', '0.00', '500.00', '1500.00 Cr'])
  assert.equal(r.cells[4].values[1], 'By-Clg. GAMMA FOOTWEAR, Chq : 43, Seq : 21102619002102, Bank : BANK OF BARODA')

  const cols = guessColumns(r.cells[0].values) as StatementColumns
  const p = parseStatement(r.cells, cols)
  assert.deepEqual(p.problems, [])
  assert.deepEqual(p.lines.map((l) => [l.txnDate, l.creditPaise, l.debitPaise]), [
    ['2026-10-20', 50000, 0], ['2026-10-20', 20000, 0], ['2026-10-20', 0, 20000], ['2026-10-21', 10000, 0],
    ['2026-10-22', 100000, 0], ['2026-10-22', 0, 30000], ['2026-10-22', 30000, 0],
  ])
  // The bounced cheque and the reversal are set aside; the rest go to review.
  assert.match(p.lines[1].setAside ?? '', /^Cheque 330 returned unpaid \(Funds Insufficient\)/)
  assert.match(p.lines[6].setAside ?? '', /reversal/)
  assert.deepEqual(p.lines.filter((l) => l.creditPaise > 0 && !l.setAside).map((l) => l.payerKey), ['ALPHA SHOES', 'GAMMA FOOTWEAR', ''])
  assert.equal(chequeNoOf(p.lines[3].details, p.lines[3].reference), '43')
})

test('PDF statement: a row that does not add up refuses the file', () => {
  const bad = readPdfStatement(statement({ e1Balance: '1501.00' }))
  assert.ok(bad.errors.some((e) => /balance ₹1,501.00 is not ₹1,000.00 \+ ₹500.00/.test(e)))
  const totals = readPdfStatement(statement({ creditTotal: '2000.00' }))
  assert.ok(totals.errors.some((e) => /totals/.test(e)))
  assert.match(readPdfStatement([{ items: [at('Invoice', 40, 700), at('Amount 100.00', 40, 680)] }]).errors[0], /no statement table/)
})

test('cheque numbers and payer names from clearing lines', () => {
  assert.equal(chequeNoOf('By-Clg. X Br-, Chq : 43, Seq : 21102619002102', ''), '43')
  assert.equal(chequeNoOf('By-Clg. X Br-, Chq : 1386, Seq : 1', '1386'), '1386')
  assert.equal(chequeNoOf('By-Cash', ''), '')
  assert.equal(payerKeyOf('By-Clg. J.D. BROTHERS FOOTWEAR Br-, Chq : 415478, Seq : 1, Bank : CANARA BANK'), 'J D BROTHERS FOOTWEAR')
  assert.equal(payerKeyOf('By-Clg. ALANKAR BOOT HOUSE, Chq : 2146, Seq : 2, Bank : Zila Sahkari Bank'), 'ALANKAR BOOT HOUSE')
  assert.equal(payerKeyOf('By-Trf. 1001021011267'), 'A/C 1001021011267')
  assert.equal(payerKeyOf('By-Trf. RAJASTHAN SHOE PALACE'), 'RAJASTHAN SHOE PALACE')
})
