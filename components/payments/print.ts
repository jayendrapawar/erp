// Payments: printing a receipt or a party statement, WhatsApp links, dates (client only).
// The print window opens inside the click (browsers block windows opened after a wait), then the
// shop details (Master → Bill template, 1 query) are filled in.

import { openPrintWindow } from '@/lib/bill-html'
import { getBillTemplate } from '@/app/actions/bill-template'
import { formatRs } from '@/lib/billing/bill-amounts'
import { ratePaise } from '@/lib/billing/bill-totals'
import type { BillTemplate } from '@/lib/bill-template'
import type { Statement } from '@/lib/payments/queries'
import type { CreditNotePrint } from '@/lib/payments/credit-notes'
import type { SlipView } from '@/lib/payments/slips'

/** Today in India (YYYY-MM-DD). */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
}
/** 24 Nov 2026. */
export function dayText(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
/** wa.me link to an Indian mobile (10 digits) with the text filled in. */
export function whatsappLink(phone: string, text: string): string {
  const digits = phone.replace(/\D/g, '').slice(-10)
  return `https://wa.me/${digits.length === 10 ? `91${digits}` : ''}?text=${encodeURIComponent(text)}`
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const KIND: Record<string, string> = {
  bill: 'Bill', payment: 'Payment', opening: 'Opening balance', discount: 'Early-payment discount', charge: 'Charge',
  adjustment: 'Adjustment', reversal: 'Reversal', credit_note: 'Credit note',
}

function page(title: string, t: BillTemplate | null, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;margin:24px;font-size:13px}
    h1{font-size:18px;margin:0}.shop{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}
    .muted{color:#555}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:5px 6px;border-bottom:1px solid #ddd;text-align:left}
    th{font-size:11px;text-transform:uppercase;color:#555}.r{text-align:right;font-variant-numeric:tabular-nums}.big{font-size:20px;font-weight:700}
    .box{border:1px solid #bbb;border-radius:8px;padding:10px;margin:10px 0}@media print{body{margin:10mm}}
  </style></head><body>
  <div class="shop"><div><h1>${esc(t?.shopName ?? 'SHAYONA SHOE PALACE')}</h1><div class="muted">${esc(t?.address ?? '')}</div>
  ${t?.gstin ? `<div class="muted">GSTIN ${esc(t.gstin)}</div>` : ''}</div><div class="r"><b>${esc(title)}</b></div></div>
  ${body}<script>window.onload=()=>window.print()</script></body></html>`
}

async function fill(win: Window, title: string, body: string) {
  const t = await getBillTemplate().catch(() => null)
  win.document.open(); win.document.write(page(title, t, body)); win.document.close(); win.focus()
}

export interface ReceiptPrint {
  receiptNo: string; partyName: string; amountPaise: number; receivedOn: string; mode: string; status: string
  chequeNo?: string; chequeBank?: string; chequeDate?: string; reference?: string
  setAgainst: Array<{ refNo: string; amountPaise: number }>; discounts: Array<{ refNo: string; amountPaise: number }>
  party: { balancePaise: number }
}

export async function printReceipt(r: ReceiptPrint) {
  const win = openPrintWindow()
  if (!win) return
  const how = r.mode === 'cheque' ? `Cheque no. ${esc(r.chequeNo)}, ${esc(r.chequeBank)}, dated ${esc(dayText(r.chequeDate))}${r.status === 'pending' ? ' (counted when deposited)' : ''}`
    : `${r.mode.toUpperCase()}${r.reference ? ` · ref. ${esc(r.reference)}` : ''}`
  const body = `
    <p>Receipt no. <b>${esc(r.receiptNo)}</b> &nbsp; Date <b>${esc(dayText(r.receivedOn))}</b></p>
    <p>Received from <b>${esc(r.partyName)}</b></p>
    <div class="box"><span class="big">${esc(formatRs(r.amountPaise))}</span><div class="muted">${how}</div></div>
    ${r.setAgainst.length ? `<table><thead><tr><th>Against bill</th><th class="r">Amount</th></tr></thead><tbody>
      ${r.setAgainst.map((s) => `<tr><td>${esc(s.refNo)}</td><td class="r">${esc(formatRs(s.amountPaise))}</td></tr>`).join('')}</tbody></table>` : ''}
    ${r.discounts.length ? `<p class="muted">Early-payment discount: ${r.discounts.map((d) => `${esc(d.refNo)} ${esc(formatRs(d.amountPaise))}`).join(', ')}</p>` : ''}
    <p>Balance after this payment: <b>${esc(formatRs(r.party.balancePaise))}</b></p>
    <p style="margin-top:40px" class="r">Signature</p>`
  await fill(win, `Payment receipt ${r.receiptNo}`, body)
}

export async function printStatement(s: Statement) {
  const win = openPrintWindow()
  if (!win) return
  const body = `
    <p><b>${esc(s.party.partyName)}</b><br><span class="muted">${esc(s.party.address)}${s.party.gst ? ` · GSTIN ${esc(s.party.gst)}` : ''}</span></p>
    <p>Statement from <b>${esc(dayText(s.from))}</b> to <b>${esc(dayText(s.to))}</b></p>
    <table><thead><tr><th>Date</th><th>Particulars</th><th>Ref.</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead><tbody>
    <tr><td>${esc(dayText(s.from))}</td><td>Opening balance</td><td></td><td></td><td></td><td class="r">${esc(formatRs(s.openingPaise))}</td></tr>
    ${s.entries.map((e) => `<tr><td>${esc(dayText(e.entryDate))}</td><td>${esc(KIND[e.kind] ?? e.kind)}${e.mode ? ` (${esc(e.mode.toUpperCase())}${e.chequeNo ? ` ${esc(e.chequeNo)}` : ''})` : ''}${e.reason ? ` — ${esc(e.reason)}` : ''}</td>
      <td>${esc(e.refNo)}</td><td class="r">${e.amountPaise > 0 ? esc(formatRs(e.amountPaise)) : ''}</td><td class="r">${e.amountPaise < 0 ? esc(formatRs(-e.amountPaise)) : ''}</td>
      <td class="r">${esc(formatRs(e.runningPaise))}</td></tr>`).join('')}
    <tr><td colspan="5"><b>Closing balance</b></td><td class="r"><b>${esc(formatRs(s.closingPaise))}</b></td></tr></tbody></table>
    ${s.unpaid.length ? `<h3 style="margin-top:18px">Unpaid bills</h3><table><thead><tr><th>Bill</th><th>Date</th><th class="r">Days</th><th class="r">Amount</th><th class="r">Unpaid</th></tr></thead><tbody>
      ${s.unpaid.map((u) => `<tr><td>${esc(u.refNo)}</td><td>${esc(dayText(u.entryDate))}</td><td class="r">${u.days}</td><td class="r">${esc(formatRs(u.amountPaise))}</td><td class="r">${esc(formatRs(u.openPaise))}</td></tr>`).join('')}
      </tbody></table>` : ''}`
  await fill(win, 'Statement of account', body)
}

/** Short statement text for WhatsApp. */
export function statementText(s: Statement): string {
  const lines = [
    `Shayona — statement for ${s.party.partyName}`,
    `Balance as on ${dayText(s.to)}: ${formatRs(s.closingPaise)}`,
    ...(s.unpaid.length ? ['Unpaid bills:', ...s.unpaid.slice(0, 15).map((u) => `  ${u.refNo} (${dayText(u.entryDate)}): ${formatRs(u.openPaise)}`)] : []),
    ...(s.unpaid.length > 15 ? [`  …and ${s.unpaid.length - 15} more`] : []),
  ]
  return lines.join('\n')
}

/** A GST credit note (or, against a bill without GST, a plain credit note). */
export async function printCreditNote(p: CreditNotePrint) {
  const win = openPrintWindow()
  if (!win) return
  const T = p.totals
  const pct = (bp: number) => `${Number((bp / 100).toFixed(2))}%`
  const rate = (mrp: number) => ratePaise(mrp, p.lineDiscPct ?? 0) / 100
  const lines = p.kind === 'return'
    ? `<table><thead><tr><th>Article</th><th>HSN</th><th class="r">MRP</th><th class="r">Rate</th><th class="r">Pairs</th><th class="r">Amount</th></tr></thead><tbody>
      ${p.lines.map((l) => `<tr><td>${esc(l.artNumber)}</td><td>${esc(l.hsn ?? '')}</td><td class="r">${esc(l.mrp.toFixed(2))}</td><td class="r">${esc(rate(l.mrp).toFixed(2))}</td><td class="r">${l.qty}</td><td class="r">${esc((rate(l.mrp) * l.qty).toFixed(2))}</td></tr>`).join('')}
      </tbody></table>`
    : `<div class="box">${esc(p.reason)}${p.bill ? ` — against bill ${esc(p.bill.billNo)}` : ''}</div>`
  const rows = [
    ...(p.kind === 'return' ? [[`Sub total (${T.totalQty} pairs)`, T.grossPaise], ...(T.discountPaise ? [[`Discount ${pct(T.discountBp)}`, -T.discountPaise]] : [])] : []),
    ['Amount before GST', T.taxablePaise],
    ...(T.cgstPaise ? [[`CGST ${pct(T.cgstBp)}`, T.cgstPaise], [`SGST ${pct(T.sgstBp)}`, T.sgstPaise]] : []),
    ...(T.igstPaise ? [[`IGST ${pct(T.igstBp)}`, T.igstPaise]] : []),
    ...(T.roundOffPaise ? [['Round off', T.roundOffPaise]] : []),
  ] as Array<[string, number]>
  const body = `
    <p>Credit note no. <b>${esc(p.noteNo)}</b> &nbsp; Date <b>${esc(dayText(p.noteDate))}</b>${p.status !== 'active' ? ' &nbsp; <b style="color:#b00">CANCELLED</b>' : ''}</p>
    ${p.bill ? `<p>Against original bill <b>${esc(p.bill.billNo)}</b> dated ${esc(dayText(p.bill.billDate))}</p>` : ''}
    <p>To <b>${esc(p.party.partyName)}</b><br><span class="muted">${esc(p.party.address)}${p.party.gst ? ` · GSTIN ${esc(p.party.gst)}` : ''}</span></p>
    <p>Reason: ${esc(p.reason)}</p>
    ${lines}
    <table style="margin-top:12px;max-width:360px;margin-left:auto"><tbody>
      ${rows.map(([l, v]) => `<tr><td>${esc(l)}</td><td class="r">${v < 0 ? '− ' : ''}${esc(formatRs(Math.abs(v)))}</td></tr>`).join('')}
      <tr><td><b>Total credit</b></td><td class="r"><b>${esc(formatRs(T.totalPaise))}</b></td></tr>
    </tbody></table>
    <p style="margin-top:40px" class="r">Authorised signatory</p>`
  await fill(win, p.taxType === 'untaxed' ? 'CREDIT NOTE' : 'CREDIT NOTE (GST)', body)
}

/** A day's cash / bank slip: every line, reversed ones struck out, and the total. */
export async function printSlip(v: SlipView) {
  if (!v.slip) return
  const win = openPrintWindow()
  if (!win) return
  const s = v.slip
  const body = `
    <p>Slip no. <b>${esc(s.slipNo)}</b> &nbsp; Date <b>${esc(dayText(s.slipDate))}</b> &nbsp; ${s.kind === 'cash' ? 'CASH' : `BANK: <b>${esc(s.bankName ?? '')}</b>`}</p>
    <table><thead><tr><th>#</th><th>Party</th><th>How</th><th>Against bills</th><th class="r">Amount</th></tr></thead><tbody>
    ${v.lines.map((l, i) => `<tr${l.status !== 'active' ? ' style="text-decoration:line-through;color:#888"' : ''}><td>${i + 1}</td><td>${esc(l.partyName)}${l.note ? `<br><span class="muted">${esc(l.note)}</span>` : ''}</td>
      <td>${esc(l.mode.toUpperCase())}${l.chequeNo ? ` ${esc(l.chequeNo)}` : ''}${l.reference ? ` · ${esc(l.reference)}` : ''}</td>
      <td>${esc(l.setAgainst.map((a) => a.refNo).join(', '))}${l.discountPaise ? ` (disc. ${esc(formatRs(l.discountPaise))})` : ''}</td>
      <td class="r">${esc(formatRs(l.amountPaise))}</td></tr>`).join('')}
    <tr><td colspan="4"><b>Total</b></td><td class="r"><b>${esc(formatRs(v.totalPaise))}</b></td></tr></tbody></table>
    <p style="margin-top:40px" class="r">Checked by</p>`
  await fill(win, s.kind === 'cash' ? 'CASH SLIP' : 'BANK SLIP', body)
}
