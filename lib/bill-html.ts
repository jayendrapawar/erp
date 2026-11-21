/**
 * lib/bill-html.ts — the sale bill (invoice) HTML. Compact layout (owner, 20 Nov 2026).
 *
 *   - A4 / A5; city bill (CGST + SGST) or outside-city bill (IGST + transport details).
 *   - Shop, bank, QR, terms and footer come from the Bill template (Master → Bill template,
 *     lib/bill-template.ts); defaults are the shop's current details.
 *   - Pages like the old ERP bill (owner, 20 Nov 2026): a small script in the bill measures the real
 *     heights for the paper size and fills each page with as many lines as fit. Every page repeats the
 *     shop header, party, bill no. ("Page x of y") and column headings; non-last pages end with
 *     "Continued on page n". The totals block is printed once, on the last page — when it does not fit
 *     under the last lines, those lines stay on their page and the totals go to the next page.
 *     Each page is a fixed-height box: the totals block sits at the bottom of the last page, the
 *     spare space is between the lines and the totals (as on the old ERP bill), on A4 and A5.
 *     Without scripts the browser paginates (headings repeat, rows never split).
 *   - Amounts: rate = ceil(MRP × (1 − line discount %)); sub total − 4.75 % discount + GST (fixed
 *     rates; see the note in lib/bill-template.ts).
 */

import { DEFAULT_UPI_QR } from './bill-default-qr'
import { DEFAULT_BILL_TEMPLATE, normalizeBillTemplate, type BillTemplate } from './bill-template'

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface InvoiceVendor {
  name:      string
  nameHindi?: string | null
  phone?:    string | null
  area?:     string | null
  address?:  string | null
}

export interface InvoiceOrder {
  orderNumber:    string
  /** Official bill number (migration 0016). Printed instead of the ORD-… order number when set. */
  billNo?:        string | null
  billedAt?:      Date | null
}

/** One line in the financial invoice — artNumber + MRP + qty */
export interface MrpLine {
  artNumber: string
  mrp:       number   // rupees, e.g. 499.00
  qty:       number
  /** HSN code (printed on the big bill, A4). */
  hsn?:      string | null
}

export type PageSize  = 'A4' | 'A5'
export type BillType  = 'city' | 'outside'   // city = within city (CGST+SGST); outside = IGST

export interface BuildInvoiceOptions {
  vendor:       InvoiceVendor
  order:        InvoiceOrder
  lines:        MrpLine[]
  /** Per-unit column discount %. Default 30. */
  lineDiscPct?: number
  pageSize?:    PageSize   // default: the template's default page size
  billType?:    BillType   // default city
  /** Shop / bank / QR / terms. Default: the shop's standard details. */
  template?:    BillTemplate
}

// Fixed rates (see lib/bill-template.ts for why they are not editable yet).
export const BILL_RATES = { discountPct: 4.75, cgstPct: 2.5, sgstPct: 2.5, igstPct: 5 } as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function amountInWords(n: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
    'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  function words(num: number): string {
    if (num === 0)       return ''
    if (num < 20)        return ones[num] + ' '
    if (num < 100)       return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '') + ' '
    if (num < 1000)      return ones[Math.floor(num / 100)] + ' Hundred ' + words(num % 100)
    if (num < 100000)    return words(Math.floor(num / 1000))    + 'Thousand ' + words(num % 1000)
    if (num < 10000000)  return words(Math.floor(num / 100000))  + 'Lakh '     + words(num % 100000)
    return                      words(Math.floor(num / 10000000)) + 'Crore '    + words(num % 10000000)
  }
  const rupees = Math.floor(n)
  const paise  = Math.round((n - rupees) * 100)
  let result = 'Rupees ' + (words(rupees).trim() || 'Zero')
  if (paise > 0) result += ' and ' + words(paise).trim() + ' Paise'
  return result + ' Only'
}

const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** Text from the template or a retailer is never treated as HTML. */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** Bill totals — the same arithmetic as the billing screen. */
export function billTotals(lines: MrpLine[], lineDiscPct: number, billType: BillType) {
  const R = BILL_RATES
  const totalQty  = lines.reduce((s, l) => s + l.qty, 0)
  const subTotal  = lines.reduce((s, l) => s + Math.ceil(l.mrp * (1 - lineDiscPct / 100)) * l.qty, 0)
  const discAmt   = Math.round(subTotal * R.discountPct / 100 * 100) / 100
  const afterDisc = subTotal - discAmt
  const cgstAmt   = billType === 'city' ? Math.round(afterDisc * R.cgstPct / 100 * 100) / 100 : 0
  const sgstAmt   = billType === 'city' ? Math.round(afterDisc * R.sgstPct / 100 * 100) / 100 : 0
  const igstAmt   = billType === 'outside' ? Math.round(afterDisc * R.igstPct / 100 * 100) / 100 : 0
  const netAmt    = Math.round((afterDisc + cgstAmt + sgstAmt + igstAmt) * 100) / 100
  return { totalQty, subTotal, discAmt, cgstAmt, sgstAmt, igstAmt, netAmt }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function css(isA5: boolean): string {
  const base = isA5 ? 10.5 : 12
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #fff; }
  @media screen { html, body { background: #e9e9e9; } body { padding: 12px 0; } }
  body { font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; font-size: ${base}px; color: #111; line-height: 1.35;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @page { size: ${isA5 ? 'A5' : 'A4'} portrait; margin: ${isA5 ? '6mm' : '9mm'}; }
  .bill { break-after: page; }
  .bill:last-child { break-after: auto; }
  /* On screen the page box has the printed width, so the script measures what will print. */
  @media screen {
    .bill, .page { width: ${isA5 ? '148mm' : '210mm'}; margin: 0 auto 16px; padding: ${isA5 ? '6mm' : '9mm'}; background: #fff; box-shadow: 0 0 0 1px #ccc; }
    .page { height: calc(var(--ph) + ${isA5 ? '12mm' : '18mm'}); }
    .bill.paged { width: auto; padding: 0; background: none; box-shadow: none; margin: 0; }
  }
  .page { display: flex; flex-direction: column; break-after: page; }
  @media print { .page { height: var(--ph); } }
  .page > .end { margin-top: auto; padding-top: 6px; }
  .bill.paged .page:last-child { break-after: auto; }
  .cont { margin-top: auto; padding-top: 5px; text-align: center; font-weight: 800; letter-spacing: .5px; font-size: ${base - 1}px; }
  .pg { color: #444; font-weight: 700; }

  .tag { text-align: center; font-size: ${base - 2}px; font-weight: 700; letter-spacing: 1.5px; color: #333; margin-bottom: 3px; }
  .head { display: flex; justify-content: space-between; gap: 12px; border-bottom: 2px solid #111; padding-bottom: 5px; }
  .shop { font-size: ${base + 8}px; font-weight: 900; letter-spacing: .5px; line-height: 1.1; }
  .shop-sub { font-size: ${base - 1.5}px; color: #444; margin-top: 2px; }
  .doc { text-align: right; white-space: nowrap; }
  .doc-title { font-size: ${base + 1}px; font-weight: 800; letter-spacing: 1px; }
  .doc-badge { display: inline-block; margin-top: 2px; background: #111; color: #fff; font-size: ${base - 3}px; font-weight: 700; padding: 1px 5px; letter-spacing: .5px; }
  .k { color: #666; font-size: ${base - 2}px; text-transform: uppercase; letter-spacing: .6px; }
  .v { font-weight: 700; }

  .party { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid #ccc; }
  .party-name { font-size: ${base + 1.5}px; font-weight: 800; }
  .party-sub { color: #444; font-size: ${base - 1}px; }

  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  table.lines { table-layout: fixed; } /* same columns on every page, even the totals-only one */
  td.art { overflow-wrap: anywhere; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th { font-size: ${base - 2}px; text-transform: uppercase; letter-spacing: .5px; color: #333; background: #f1f1f1;
       border-top: 1px solid #bbb; border-bottom: 1px solid #bbb; padding: 3px 5px; }
  td { padding: ${isA5 ? 2 : 3}px 5px; border-bottom: 1px solid #e6e6e6; vertical-align: middle; }
  td.n, th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.c, th.c { text-align: center; }
  td.art { font-weight: 700; }
  td.qty { font-weight: 800; font-size: ${base + 1}px; text-align: center; }
  tr.group td { border-top: 1px solid #cfcfcf; }
  tfoot td { font-weight: 800; border-top: 1.5px solid #111; border-bottom: none; padding-top: 4px; }

  .end { break-inside: avoid; margin-top: 6px; }
  .grid { display: flex; gap: 10px; align-items: stretch; }
  .left { flex: 1.25; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .words { border: 1px solid #ccc; padding: 4px 6px; }
  .words .v { font-size: ${base}px; }
  .pay { display: flex; gap: 8px; border: 1px solid #ccc; padding: 4px 6px; align-items: center; }
  .bank { flex: 1; font-size: ${base - 1}px; line-height: 1.45; }
  .bank b { display: inline-block; min-width: ${isA5 ? 44 : 52}px; color: #555; font-weight: 600; }
  .qr { width: ${isA5 ? 58 : 74}px; text-align: center; font-size: ${base - 3}px; color: #555; }
  .qr img { width: 100%; height: ${isA5 ? 58 : 74}px; object-fit: contain; display: block; }
  .sum { flex: 1; border: 1px solid #bbb; }
  .sum div { display: flex; justify-content: space-between; padding: 2px 7px; }
  .sum .disc span:last-child { color: #b42318; }
  .sum .net { background: #fff; color: #111; border: 1.5px solid #111; font-weight: 900; font-size: ${base + 3}px; padding: 4px 7px; margin: 3px 4px 4px; }
  .transport { display: flex; gap: 10px; margin-top: 5px; border: 1px solid #ccc; padding: 3px 6px; }
  .transport div { flex: 1; } .transport .line { border-bottom: 1px solid #bbb; height: ${base + 4}px; }
  .sign { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-top: 8px; }
  .terms { font-size: ${base - 2.5}px; color: #555; white-space: pre-line; flex: 1; }
  .sig { text-align: center; font-size: ${base - 2}px; color: #444; min-width: ${isA5 ? 90 : 120}px; }
  .sig .line { border-top: 1px solid #555; margin-bottom: 2px; height: ${isA5 ? 18 : 26}px; }
  .foot { text-align: center; font-size: ${base - 2}px; color: #666; letter-spacing: 1px; text-transform: uppercase; margin-top: 6px; border-top: 1px solid #ddd; padding-top: 3px; }
`
}

// ─── One bill ─────────────────────────────────────────────────────────────────

function billBody(o: BuildInvoiceOptions, t: BillTemplate): string {
  const billType = o.billType ?? 'city'
  const isA5 = (o.pageSize ?? t.defaultPageSize) === 'A5'
  const lineDiscPct = o.lineDiscPct ?? 30
  const T = billTotals(o.lines, lineDiscPct, billType)
  const R = BILL_RATES

  const refDate = o.order.billedAt ? new Date(o.order.billedAt) : new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const billNo  = o.order.billNo || o.order.orderNumber || `${String(refDate.getFullYear()).slice(2)}${p2(refDate.getMonth() + 1)}${p2(refDate.getDate())}${p2(refDate.getHours())}${p2(refDate.getMinutes())}${p2(refDate.getSeconds())}`
  const dateStr = `${p2(refDate.getDate())}/${p2(refDate.getMonth() + 1)}/${refDate.getFullYear()}`

  const v = o.vendor
  const shopLine = [t.address, t.gstin && `GSTIN ${t.gstin}`, t.phone && `Ph ${t.phone}`, t.email].filter(Boolean).map(esc).join(' · ')

  // Lines grouped by article: the article name once per group.
  const groups = new Map<string, MrpLine[]>()
  for (const l of o.lines) groups.set(l.artNumber, [...(groups.get(l.artNumber) ?? []), l])
  let n = 0
  const rows = [...groups].map(([art, ls]) => ls.map((l, i) => {
    n++
    const rate = Math.ceil(l.mrp * (1 - lineDiscPct / 100))
    return `<tr data-art="${esc(art)}"${i === 0 && n > 1 ? ' class="group"' : ''}>
      <td class="c">${n}</td><td class="art">${i === 0 ? esc(art) : ''}</td>${isA5 ? '' : `<td class="hsn">${esc(l.hsn ?? '')}</td>`}
      <td class="n">${l.mrp > 0 ? fmt(l.mrp) : '—'}</td><td class="qty">${l.qty}</td>
      <td class="n">${fmt(rate)}</td><td class="n">${fmt(rate * l.qty)}</td></tr>`
  }).join('')).join('')

  const taxRows = billType === 'city'
    ? `<div><span>CGST ${R.cgstPct}%</span><span>${fmt(T.cgstAmt)}</span></div><div><span>SGST ${R.sgstPct}%</span><span>${fmt(T.sgstAmt)}</span></div>`
    : `<div><span>IGST ${R.igstPct}%</span><span>${fmt(T.igstAmt)}</span></div>`
  const qrSrc = t.qrImage || DEFAULT_UPI_QR
  const pay = (t.showBank || t.showQr) ? `<div class="pay">
      ${t.showBank ? `<div class="bank"><div class="k">Bank details</div>
        ${t.bankName ? `<div><b>Bank</b>${esc(t.bankName)}</div>` : ''}${t.accountNo ? `<div><b>A/C No.</b>${esc(t.accountNo)}</div>` : ''}
        ${t.ifsc ? `<div><b>IFSC</b>${esc(t.ifsc)}</div>` : ''}${t.branch ? `<div><b>Branch</b>${esc(t.branch)}</div>` : ''}
        ${t.upiId ? `<div><b>UPI</b>${esc(t.upiId)}</div>` : ''}</div>` : ''}
      ${t.showQr ? `<div class="qr"><img src="${qrSrc}" alt="UPI QR" />Scan to pay</div>` : ''}
    </div>` : ''

  return `<section class="bill" data-ph="${isA5 ? PAGE_H_MM.A5 : PAGE_H_MM.A4}">
  <div class="bill-top">
  ${t.tagline ? `<div class="tag">${esc(t.tagline)}</div>` : ''}
  <div class="head">
    <div><div class="shop">${esc(t.shopName)}</div><div class="shop-sub">${shopLine}</div></div>
    <div class="doc"><div class="doc-title">TAX INVOICE</div>
      ${billType === 'outside' ? '<div class="doc-badge">OUTSIDE CITY</div>' : ''}
      <div><span class="k">Bill No </span><span class="v">${esc(billNo)}</span><span class="pg"></span></div>
      <div><span class="k">Date </span><span class="v">${dateStr}</span></div></div>
  </div>
  <div class="party">
    <div><div class="k">Bill to</div>
      <div class="party-name">M/s. ${esc(v.name)}${t.showHindiName && v.nameHindi ? ` (${esc(v.nameHindi)})` : ''}</div>
      <div class="party-sub">${[v.phone, v.area, v.address].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div></div>
    <div style="text-align:right"><div class="k">Pairs</div><div class="party-name">${T.totalQty}</div></div>
  </div>
  </div>
  <table class="lines">
    <thead><tr><th class="c" style="width:${isA5 ? 22 : 30}px">#</th><th style="text-align:left">Article</th>${isA5 ? '' : '<th style="text-align:left;width:62px">HSN</th>'}
      <th class="n" style="width:${isA5 ? 62 : 80}px">MRP ₹</th><th class="c" style="width:${isA5 ? 34 : 44}px">Qty</th><th class="n" style="width:${isA5 ? 66 : 84}px">Rate ₹</th><th class="n" style="width:${isA5 ? 74 : 96}px">Amount ₹</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td></td><td>Total</td>${isA5 ? '' : '<td></td>'}<td></td><td class="c">${T.totalQty}</td><td class="n">Disc ${lineDiscPct}%</td><td class="n">${fmt(T.subTotal)}</td></tr></tfoot>
  </table>
  <div class="end">
    <div class="grid">
      <div class="left">
        <div class="words"><div class="k">Amount in words</div><div class="v">${amountInWords(T.netAmt)}</div></div>
        ${pay}
      </div>
      <div class="sum">
        <div><span>Sub total</span><span>${fmt(T.subTotal)}</span></div>
        <div class="disc"><span>Discount ${R.discountPct}%</span><span>− ${fmt(T.discAmt)}</span></div>
        ${taxRows}
        <div class="net"><span>Net payable</span><span>₹${fmt(T.netAmt)}</span></div>
      </div>
    </div>
    ${billType === 'outside' ? `<div class="transport">${['Transport', 'Vehicle No.', 'Destination state', 'E-way bill no.'].map(x => `<div><div class="k">${x}</div><div class="line"></div></div>`).join('')}</div>` : ''}
    <div class="sign">
      <div class="terms">${esc(t.terms)}</div>
      <div class="sig"><div class="line"></div>Receiver's signature</div>
      <div class="sig"><div class="line"></div>For ${esc(t.shopName)}</div>
    </div>
    ${t.footer ? `<div class="foot">${esc(t.footer)}</div>` : ''}
  </div>
</section>`
}

// ─── Pages ────────────────────────────────────────────────────────────────────

/** Printable height per page (paper − @page margins − 3 mm safety), in mm. */
const PAGE_H_MM = { A4: 297 - 18 - 3, A5: 210 - 12 - 3 } as const

/**
 * Runs inside the bill window before printing. Measures the header, each line, the totals block and
 * the "continued" line, then rebuilds every bill as fixed pages. Plain ES5 so any browser runs it.
 */
const PAGINATE_JS = `(function(){
var MM=96/25.4;
function h(el){var r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.height+parseFloat(s.marginTop)+parseFloat(s.marginBottom);}
var bills=document.querySelectorAll('section.bill[data-ph]');
for(var b=0;b<bills.length;b++){(function(bill){
  var H=parseFloat(bill.getAttribute('data-ph'))*MM;
  var top=bill.querySelector('.bill-top'),table=bill.querySelector('table.lines'),end=bill.querySelector('.end');
  if(!top||!table||!end||!table.tHead||!table.tBodies[0])return;
  var rows=[].slice.call(table.tBodies[0].rows),foot=table.tFoot;
  var probe=document.createElement('div');probe.className='cont';probe.textContent='Continued';bill.appendChild(probe);
  var contH=h(probe);bill.removeChild(probe);
  var topH=h(top),headH=table.tHead.getBoundingClientRect().height+parseFloat(getComputedStyle(table).marginTop);
  var footH=foot?foot.getBoundingClientRect().height:0,endH=h(end);
  var pages=[],cur=[],used=topH+headH,lim=H-contH;
  for(var i=0;i<rows.length;i++){var rh=rows[i].getBoundingClientRect().height;
    if(cur.length&&used+rh>lim){pages.push(cur);cur=[];used=topH+headH;}
    cur.push(rows[i]);used+=rh;}
  if(cur.length&&used+footH+endH>H){pages.push(cur);cur=[];}
  pages.push(cur);
  var n=pages.length,thead=table.tHead,ph=bill.getAttribute('data-ph')+'mm';
  while(bill.firstChild)bill.removeChild(bill.firstChild);
  for(var p=0;p<n;p++){
    var pg=document.createElement('div');pg.className='page';pg.style.setProperty('--ph',ph);
    var t=top.cloneNode(true),slot=t.querySelector('.pg');if(slot&&n>1)slot.textContent=' · Page '+(p+1)+' of '+n;pg.appendChild(t);
    var tb=document.createElement('table');tb.className='lines';tb.appendChild(thead.cloneNode(true));
    var body=document.createElement('tbody');
    for(var j=0;j<pages[p].length;j++){var r=pages[p][j];
      if(j===0){r.className='';var a=r.querySelector('td.art');if(a&&!a.textContent)a.textContent=r.getAttribute('data-art')||'';}
      body.appendChild(r);}
    tb.appendChild(body);
    var last=p===n-1;if(last&&foot)tb.appendChild(foot);
    pg.appendChild(tb);
    if(last)pg.appendChild(end);else{var c=document.createElement('div');c.className='cont';c.textContent='Continued on page '+(p+2)+' \u2192';pg.appendChild(c);}
    bill.appendChild(pg);}
  bill.className+=' paged';
})(bills[b]);}
})();`

export function buildInvoiceHtml(o: BuildInvoiceOptions): string {
  const t = normalizeBillTemplate(o.template ?? DEFAULT_BILL_TEMPLATE)
  const isA5 = (o.pageSize ?? t.defaultPageSize) === 'A5'
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bill ${esc(o.order.orderNumber)} — ${esc(o.vendor.name)}</title>
<style>${css(isA5)}</style></head><body>${billBody(o, t)}<script>${PAGINATE_JS}</script></body></html>`
}

// ─── Print helper ─────────────────────────────────────────────────────────────

export interface PrintConfig {
  pageSize: PageSize
  billType: BillType
}

/** Retailer name in Hindi script (Google Input Tools). Null when it fails. */
export async function transliterateToHindi(name: string): Promise<string | null> {
  try {
    const url = `https://inputtools.google.com/request?text=${encodeURIComponent(name)}&itc=hi-t-i0-und&num=1`
    const res  = await fetch(url)
    if (!res.ok) return null
    const data = await res.json() as [string, Array<[string, string[]]>]
    if (data[0] !== 'SUCCESS') return null
    return data[1]?.[0]?.[1]?.[0] ?? null
  } catch {
    return null
  }
}

/**
 * Open the print window straight away, inside the click (browsers block windows opened after a wait,
 * e.g. after loading bill lines or Hindi names). Null when pop-ups are blocked; the user is told.
 */
export function openPrintWindow(): Window | null {
  const win = window.open('', '_blank', 'width=860,height=1000')
  if (!win) {
    window.alert('The bill window was blocked. Allow pop-ups for this site (icon at the right of the address bar), then press Print again.')
    return null
  }
  win.document.write('<p style="font-family:system-ui,sans-serif;padding:24px;color:#444">Preparing the bill…</p>')
  return win
}

/**
 * Print one or more bills in one window. Pass `win` from openPrintWindow() when the caller has to
 * wait for something first; otherwise the window is opened here, before any waiting.
 */
export async function printInvoices(bills: Array<BuildInvoiceOptions>, config?: PrintConfig, template?: BillTemplate, win: Window | null = null) {
  if (bills.length === 0) { win?.close(); return }
  const target = win ?? openPrintWindow()
  if (!target) return
  const t = normalizeBillTemplate(template ?? DEFAULT_BILL_TEMPLATE)
  const hindi = new Map<string, string | null>()
  if (t.showHindiName) {
    const names = [...new Set(bills.map(b => b.vendor.name))]
    const res = await Promise.all(names.map(n => transliterateToHindi(n)))
    names.forEach((n, i) => hindi.set(n, res[i]))
  }
  const pageSize = config?.pageSize ?? bills[0].pageSize ?? t.defaultPageSize
  const body = bills.map(b => billBody({
    ...b, template: t, pageSize, billType: config?.billType ?? b.billType ?? 'city',
    vendor: { ...b.vendor, nameHindi: b.vendor.nameHindi ?? hindi.get(b.vendor.name) ?? null },
  }, t)).join('\n')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${bills.length === 1 ? `Bill ${esc(bills[0].order.orderNumber)}` : `Bills (${bills.length})`}</title>
<style>${css(pageSize === 'A5')}</style></head><body>${body}<script>${PAGINATE_JS}</script></body></html>`
  if (target.closed) return
  target.document.open()
  target.document.write(html)
  target.document.close()
  target.focus()
  // The page script lays the bill out into pages as it loads; print once that is done. (Waiting for
  // "load" set after close() can miss the event, and then the print dialog never opened.)
  setTimeout(() => { if (!target.closed) target.print() }, 400)
}
