// Printed orders (pick lists), compact (owner, 24 Nov 2026: "as space saving as possible").
// Pure: builds the HTML of the print window from plain data, so it can be measured and tested.
//
// What makes it compact (vs the earlier boxed cards, one or two per row):
//   • newspaper columns: orders flow down column 1, then column 2 … then the next page, so a short
//     order never leaves the space beside a tall one empty (that space was lost before);
//   • as many columns as fit (each at least 62 mm): A4 portrait 3, A4 landscape 4, A5 portrait 2,
//     A5 landscape 3;
//   • one line per colour, the article name only on its first colour; no serial numbers; a tick box;
//   • header in two lines (name + Hindi name, then address · order · date); total, salesman and
//     "picked by" on one line; no box around each order, just a rule above it;
//   • a narrower font (Arial instead of Courier), 10 px; 5 mm page margins.
// An order taller than a column may continue in the next column (it is never cut off).

export interface PickLine { artNumber: string; colorNumber: string | null; sizeNumber: string | null; quantityOrdered: number }
export interface PickOrder {
  orderNumber: string
  shopkeeperName: string
  hindiName?: string
  address?: string
  orderedAt: Date | string
  salesman?: string | null
  items: PickLine[]
}
export type PageSize = 'A4' | 'A5'
export type Orientation = 'portrait' | 'landscape'

const PAGE_MM: Record<PageSize, { w: number; h: number }> = { A4: { w: 210, h: 297 }, A5: { w: 148, h: 210 } }
export const MARGIN_MM = 5
export const MIN_COLUMN_MM = 62
const GAP_MM = 4

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** Columns per page: as many as fit at MIN_COLUMN_MM each. */
export function columnsFor(pageSize: PageSize, orientation: Orientation): number {
  const p = PAGE_MM[pageSize]
  const width = (orientation === 'landscape' ? p.h : p.w) - MARGIN_MM * 2
  return Math.max(1, Math.floor((width + GAP_MM) / (MIN_COLUMN_MM + GAP_MM)))
}

const sizeOrder = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b)

/** One order: article → colour → size → pairs, in the order the items come. */
function orderBlock(o: PickOrder): string {
  const arts = new Map<string, Map<string, Map<string, number>>>()
  for (const it of o.items) {
    const colours = arts.get(it.artNumber) ?? new Map<string, Map<string, number>>()
    const sizes = colours.get(it.colorNumber ?? '') ?? new Map<string, number>()
    const sz = it.sizeNumber ?? '?'
    sizes.set(sz, (sizes.get(sz) ?? 0) + it.quantityOrdered)
    colours.set(it.colorNumber ?? '', sizes)
    arts.set(it.artNumber, colours)
  }
  const total = o.items.reduce((s, i) => s + i.quantityOrdered, 0)
  const when = new Date(o.orderedAt)
  const date = `${String(when.getDate()).padStart(2, '0')}/${String(when.getMonth() + 1).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  let rows = ''
  for (const [art, colours] of arts) {
    let first = true
    for (const [colour, sizes] of colours) {
      const s = [...sizes].sort(([a], [b]) => sizeOrder(a, b)).map(([sz, q]) => `${esc(sz)}/${q}`).join(' ')
      rows += `<tr><td class="a">${first ? esc(art) : ''}</td><td class="c">${esc(colour || '—')}</td><td class="s">${s}</td><td class="t"></td></tr>`
      first = false
    }
  }
  return `<section class="o">
<div class="h"><b>${esc(o.shopkeeperName)}</b>${o.hindiName && o.hindiName !== o.shopkeeperName ? `<span class="hi">${esc(o.hindiName)}</span>` : ''}</div>
<div class="m">${o.address ? `${esc(o.address)} · ` : ''}${esc(o.orderNumber)} · ${date}</div>
<table>${rows}</table>
<div class="f"><b>${total} pairs</b><span>SM: ${esc(o.salesman || '—')}</span><span>Picked: ____</span></div>
</section>`
}

/** The whole print window (prints itself when opened). */
export function pickListHtml(orders: PickOrder[], pageSize: PageSize, orientation: Orientation, opts: { autoPrint?: boolean } = {}): string {
  const cols = columnsFor(pageSize, orientation)
  const p = PAGE_MM[pageSize]
  const pageW = orientation === 'landscape' ? p.h : p.w
  const pageH = orientation === 'landscape' ? p.w : p.h
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Orders</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;700&display=swap"/>
<style>
  @page { size: ${pageSize} ${orientation}; margin: ${MARGIN_MM}mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #fff; color: #000; }
  body { font: 10px/1.25 Arial, Helvetica, sans-serif; column-count: ${cols}; column-gap: ${GAP_MM}mm; column-fill: auto; }
  @media screen { body { width: ${pageW - MARGIN_MM * 2}mm; min-height: ${pageH - MARGIN_MM * 2}mm; margin: ${MARGIN_MM}mm auto; } }
  .o { break-inside: avoid; border-top: 1.2px solid #000; padding: 2px 0 4px; }
  .h { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; line-height: 1.2; }
  .h b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hi { font-family: 'Noto Sans Devanagari', Mangal, Arial, sans-serif; font-size: 10.5px; white-space: nowrap; }
  .m { font-size: 8.5px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 1px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0.5px 3px 0.5px 0; vertical-align: top; }
  td.a { font-weight: bold; white-space: nowrap; width: 1%; }
  td.c { white-space: nowrap; width: 1%; }
  td.s { font-weight: bold; font-variant-numeric: tabular-nums; }
  td.t { width: 9px; padding: 0; }
  td.t::after { content: ''; display: inline-block; width: 7px; height: 7px; border: 1px solid #000; margin-top: 2px; }
  tr + tr td { border-top: 0.5px dotted #bbb; }
  .f { display: flex; justify-content: space-between; gap: 6px; font-size: 9px; border-top: 0.5px solid #888; margin-top: 1px; padding-top: 1px; }
  .f b { font-size: 10px; }
</style></head><body>
${orders.map(orderBlock).join('\n')}
${opts.autoPrint === false ? '' : `<script>window.onload = function(){ window.print(); }</` + `script>`}
</body></html>`
}
