// The sale bill as a PDF, for sending by email (owner, 21 Nov 2026). Same content and arithmetic as
// the printed bill (lib/bill-html.ts): shop header, party, lines across pages ("Page x of y",
// "Continued on page n"), totals block at the bottom of the last page (moved to a page of its own when
// it does not fit), bank details, UPI QR, terms, signatures. Server only (pdf-lib, no browser).
// Standard PDF fonts: amounts show "Rs." (no ₹ glyph); the retailer's Hindi name is not included.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { BILL_RATES, amountInWords, billTotals, type MrpLine } from './bill-html'
import { DEFAULT_UPI_QR } from './bill-default-qr'
import { normalizeBillTemplate, type BillTemplate } from './bill-template'

export interface BillPdfInput {
  vendor: { name: string; phone?: string | null; address?: string | null }
  order: { orderNumber: string; billedAt?: Date | string | null }
  lines: MrpLine[]
  lineDiscPct: number
  template?: BillTemplate
}

const A4 = { w: 595.28, h: 841.89 }
const M = 28                       // page margin (≈ 10 mm)
const ROW = 17                     // line height in the table
const INK = rgb(0.07, 0.07, 0.07)
const GREY = rgb(0.4, 0.4, 0.4)
const RULE = rgb(0.8, 0.8, 0.8)

/** Standard PDF fonts only know Latin-1 + a few marks: everything else is dropped (₹ → Rs.). */
function clean(s: unknown): string {
  return String(s ?? '')
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[•·]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '')
}
const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  for (const para of clean(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= width) line = next
      else { if (line) out.push(line); line = word }
    }
    out.push(line)
  }
  return out
}

function dataUrlBytes(url: string): { type: 'png' | 'jpg'; bytes: Uint8Array } | null {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(url)
  if (!m) return null
  return { type: m[1] === 'png' ? 'png' : 'jpg', bytes: Uint8Array.from(Buffer.from(m[2], 'base64')) }
}

export async function buildBillPdf(input: BillPdfInput): Promise<Uint8Array> {
  const t = normalizeBillTemplate(input.template)
  const doc = await PDFDocument.create()
  doc.setTitle(`Bill ${input.order.orderNumber}`)
  doc.setAuthor(t.shopName)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  let qr: PDFImage | null = null
  if (t.showQr) {
    const img = dataUrlBytes(t.qrImage || DEFAULT_UPI_QR)
    if (img) qr = img.type === 'png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes)
  }

  const T = billTotals(input.lines, input.lineDiscPct, 'city')
  const R = BILL_RATES
  const when = input.order.billedAt ? new Date(input.order.billedAt) : new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const dateStr = `${p2(when.getDate())}/${p2(when.getMonth() + 1)}/${when.getFullYear()}`

  const text = (pg: PDFPage | null, s: string, x: number, y: number, size: number, f: PDFFont = font, color = INK) =>
    pg?.drawText(clean(s), { x, y, size, font: f, color })
  const right = (pg: PDFPage | null, s: string, x: number, y: number, size: number, f: PDFFont = font, color = INK) =>
    pg?.drawText(clean(s), { x: x - f.widthOfTextAtSize(clean(s), size), y, size, font: f, color })
  const center = (pg: PDFPage | null, s: string, x: number, y: number, size: number, f: PDFFont = font, color = INK) =>
    pg?.drawText(clean(s), { x: x - f.widthOfTextAtSize(clean(s), size) / 2, y, size, font: f, color })
  const hline = (pg: PDFPage | null, y: number, thick = 0.6, color = RULE) =>
    pg?.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: thick, color })

  // Table columns (right edges for numbers)
  const W = A4.w - 2 * M
  const col = { n: M + 4, art: M + 30, mrpR: M + W * 0.58, qtyC: M + W * 0.66, rateR: M + W * 0.80, amtR: A4.w - M - 4 }

  /** Header, party, column headings. Returns the y where table rows start. */
  /** With a null page it only measures. */
  function drawTop(pg: PDFPage | null, pageNo: number, pages: number): number {
    let y = A4.h - M
    if (t.tagline) { center(pg, t.tagline, A4.w / 2, y - 8, 8, bold, GREY); y -= 14 }
    text(pg, t.shopName, M, y - 18, 18, bold)
    right(pg, 'TAX INVOICE', A4.w - M, y - 12, 11, bold)
    right(pg, `Bill No  ${input.order.orderNumber}`, A4.w - M, y - 26, 9, bold)
    right(pg, `Date  ${dateStr}${pages > 1 ? `   Page ${pageNo} of ${pages}` : ''}`, A4.w - M, y - 38, 9)
    const shopLine = [t.address, t.gstin && `GSTIN ${t.gstin}`, t.phone && `Ph ${t.phone}`, t.email].filter(Boolean).join('  -  ')
    let sy = y - 32
    for (const l of wrap(shopLine, font, 8, W * 0.6)) { text(pg, l, M, sy, 8, font, GREY); sy -= 10 }
    y = Math.min(sy, y - 44) - 4
    hline(pg, y, 1.4, INK)
    // party
    text(pg, 'BILL TO', M, y - 12, 7, bold, GREY)
    text(pg, `M/s. ${input.vendor.name}`, M, y - 25, 11, bold)
    const sub = [input.vendor.phone, input.vendor.address].filter(Boolean).join('  -  ')
    if (sub) text(pg, sub.slice(0, 110), M, y - 37, 8, font, GREY)
    right(pg, 'PAIRS', A4.w - M, y - 12, 7, bold, GREY)
    right(pg, String(T.totalQty), A4.w - M, y - 26, 12, bold)
    y -= 44
    hline(pg, y)
    // column headings
    y -= 13
    pg?.drawRectangle({ x: M, y: y - 4, width: W, height: 15, color: rgb(0.95, 0.95, 0.95) })
    text(pg, '#', col.n, y, 7.5, bold, GREY)
    text(pg, 'ARTICLE', col.art, y, 7.5, bold, GREY)
    right(pg, 'MRP', col.mrpR, y, 7.5, bold, GREY)
    center(pg, 'QTY', col.qtyC, y, 7.5, bold, GREY)
    right(pg, 'RATE', col.rateR, y, 7.5, bold, GREY)
    right(pg, 'AMOUNT', col.amtR, y, 7.5, bold, GREY)
    return y - 6
  }

  // Footer block height (bottom of the last page)
  const termsLines = wrap(t.terms, font, 7, W * 0.45)
  const wordsLines = wrap(amountInWords(T.netAmt), bold, 8.5, W * 0.55 - 12)
  const bankRows = t.showBank ? [['Bank', t.bankName], ['A/C No.', t.accountNo], ['IFSC', t.ifsc], ['Branch', t.branch], ['UPI', t.upiId]].filter(([, v]) => v) : []
  const leftH = 14 + wordsLines.length * 11 + 10 + (t.showBank || qr ? Math.max(bankRows.length * 11 + 14, qr ? 70 : 0) : 0)
  const FOOT = Math.max(leftH, 92) + 18 + Math.max(termsLines.length * 9, 30) + (t.footer ? 16 : 0) + 10
  const TOTAL_ROW = 20
  const CONT = 18

  // Lay out rows into pages (same rule as the printed bill)
  const firstTop = drawTop(null, 1, 2) // measure only
  const rowsFull = Math.floor((firstTop - M - CONT) / ROW)
  const rowsLast = Math.floor((firstTop - M - FOOT - TOTAL_ROW) / ROW)
  const lines = input.lines
  const pages: MrpLine[][] = []
  for (let i = 0; ;) {
    const rest = lines.length - i
    if (rest <= rowsLast) { pages.push(lines.slice(i)); break }                     // rows + totals fit
    if (rest <= rowsFull) { pages.push(lines.slice(i)); pages.push([]); break }     // totals on a page of their own
    pages.push(lines.slice(i, i + rowsFull)); i += rowsFull
  }

  let n = 0
  let prevArt = ''
  pages.forEach((rows, p) => {
    const pg = doc.addPage([A4.w, A4.h])
    let y = drawTop(pg, p + 1, pages.length)
    rows.forEach((l, j) => {
      n++
      const rate = Math.ceil(l.mrp * (1 - input.lineDiscPct / 100))
      y -= ROW
      text(pg, String(n), col.n, y + 4, 8.5, font, GREY)
      if (l.artNumber !== prevArt || j === 0) text(pg, l.artNumber, col.art, y + 4, 9, bold)
      prevArt = l.artNumber
      right(pg, l.mrp > 0 ? money(l.mrp) : '-', col.mrpR, y + 4, 9)
      center(pg, String(l.qty), col.qtyC, y + 4, 10, bold)
      right(pg, money(rate), col.rateR, y + 4, 9)
      right(pg, money(rate * l.qty), col.amtR, y + 4, 9)
      pg.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: 0.4, color: rgb(0.9, 0.9, 0.9) })
    })
    const last = p === pages.length - 1
    if (!last) { center(pg, `Continued on page ${p + 2}`, A4.w / 2, M + 4, 9, bold); return }

    // Total row right under the lines
    y -= 16
    hline(pg, y + 12, 1, INK)
    text(pg, 'Total', col.art, y, 9.5, bold)
    center(pg, String(T.totalQty), col.qtyC, y, 10, bold)
    right(pg, `Disc ${input.lineDiscPct}%`, col.rateR, y, 9, bold)
    right(pg, money(T.subTotal), col.amtR, y, 9.5, bold)

    // Footer block anchored at the bottom
    const fy = M + FOOT - 4
    const leftW = W * 0.55, rightX = M + leftW + 12, rightW = W - leftW - 12
    // amount in words
    text(pg, 'AMOUNT IN WORDS', M, fy, 6.5, bold, GREY)
    let wy = fy - 11
    for (const l of wordsLines) { text(pg, l, M, wy, 8.5, bold); wy -= 11 }
    // bank + QR
    let by = wy - 8
    if (t.showBank && bankRows.length) {
      text(pg, 'BANK DETAILS', M, by, 6.5, bold, GREY); by -= 11
      for (const [k, v] of bankRows) { text(pg, k, M, by, 8, font, GREY); text(pg, v, M + 48, by, 8); by -= 11 }
    }
    if (qr) {
      const s = 64
      pg.drawImage(qr, { x: M + leftW - s, y: wy - 8 - s, width: s, height: s })
      center(pg, 'Scan to pay', M + leftW - s / 2, wy - 8 - s - 8, 6.5, font, GREY)
    }
    // totals
    let ty = fy
    const row = (label: string, value: string, f: PDFFont = font, color = INK) => { text(pg, label, rightX, ty, 9, f, GREY); right(pg, value, A4.w - M, ty, 9, f, color); ty -= 13 }
    row('Sub total', money(T.subTotal))
    row(`Discount ${R.discountPct}%`, `- ${money(T.discAmt)}`, font, rgb(0.7, 0.13, 0.2))
    row(`CGST ${R.cgstPct}%`, money(T.cgstAmt))
    row(`SGST ${R.sgstPct}%`, money(T.sgstAmt))
    pg.drawRectangle({ x: rightX - 4, y: ty - 8, width: rightW + 4, height: 22, borderColor: INK, borderWidth: 1.2 })
    text(pg, 'Net payable', rightX + 2, ty - 1, 11, bold)
    right(pg, `Rs. ${money(T.netAmt)}`, A4.w - M - 4, ty - 1, 12, bold)
    // terms, signatures, footer
    let sy = M + (t.footer ? 18 : 4) + Math.max(termsLines.length * 9, 30)
    for (const l of termsLines) { text(pg, l, M, sy, 7, font, GREY); sy -= 9 }
    const sigY = M + (t.footer ? 22 : 8)
    pg.drawLine({ start: { x: A4.w - M - 250, y: sigY + 12 }, end: { x: A4.w - M - 140, y: sigY + 12 }, thickness: 0.6, color: GREY })
    pg.drawLine({ start: { x: A4.w - M - 120, y: sigY + 12 }, end: { x: A4.w - M, y: sigY + 12 }, thickness: 0.6, color: GREY })
    center(pg, "Receiver's signature", A4.w - M - 195, sigY, 7, font, GREY)
    center(pg, `For ${t.shopName}`.slice(0, 34), A4.w - M - 60, sigY, 7, font, GREY)
    if (t.footer) { hline(pg, M + 10, 0.4); center(pg, t.footer.toUpperCase(), A4.w / 2, M, 7, font, GREY) }
  })

  return doc.save()
}
