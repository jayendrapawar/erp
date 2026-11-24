// Printed orders (pick lists), compact (owner, 24 Nov 2026: "as space saving as possible").
//
// Layout of one order: header in two lines (name + Hindi name; address · order · date), one line per
// colour with the article named once and a tick box, then total · salesman · picked-by. No box around
// orders — a rule above each. Arial 10 px, 5 mm margins. Columns: as many as fit at ≥ 62 mm
// (A5 portrait 2, A5 landscape 3, A4 portrait 3, A4 landscape 4).
//
// Placing orders on the pages (second version, same day — measured on mixed order lengths):
//   the print window draws every order once at the column width, MEASURES its header, lines and
//   footer, then places them itself: longest orders first, each into the first column with room
//   ("first fit decreasing"); an order taller than a column continues in the next column under a
//   short "contd." header. Plain CSS columns (the first version) kept orders in sequence and lost
//   up to a page on busy days (60 orders: A5 7 → 6 pages, A4 landscape 4 → 3); this reaches the
//   minimum or one column more in every test. The same measuring + placing, run for all four paper
//   choices, tells the screen how many pages each needs BEFORE printing (estimatePickListPages).

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
export const FORMATS: ReadonlyArray<{ pageSize: PageSize; orientation: Orientation }> = [
  { pageSize: 'A4', orientation: 'portrait' }, { pageSize: 'A4', orientation: 'landscape' },
  { pageSize: 'A5', orientation: 'portrait' }, { pageSize: 'A5', orientation: 'landscape' },
]

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** Columns per page: as many as fit at MIN_COLUMN_MM each. */
export function columnsFor(pageSize: PageSize, orientation: Orientation): number {
  return geometry(pageSize, orientation).columns
}

/** Page content size, columns, column width and height (mm). */
export function geometry(pageSize: PageSize, orientation: Orientation) {
  const p = PAGE_MM[pageSize]
  const pageW = orientation === 'landscape' ? p.h : p.w
  const pageH = orientation === 'landscape' ? p.w : p.h
  const contentW = pageW - MARGIN_MM * 2
  // 1 mm spare so rounding never pushes the last line onto a blank page.
  const columnH = pageH - MARGIN_MM * 2 - 1
  const columns = Math.max(1, Math.floor((contentW + GAP_MM) / (MIN_COLUMN_MM + GAP_MM)))
  const columnW = (contentW - GAP_MM * (columns - 1)) / columns
  return { pageW, pageH, contentW, columnH, columns, columnW }
}

const sizeOrder = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b)

/** One order as HTML (head = .h + .m, one <tr> per colour, foot = .f). */
function orderBlock(o: PickOrder, i: number): string {
  const arts = new Map<string, Map<string, Map<string, number>>>()
  for (const it of o.items) {
    const colours = arts.get(it.artNumber) ?? new Map<string, Map<string, number>>()
    const sizes = colours.get(it.colorNumber ?? '') ?? new Map<string, number>()
    const sz = it.sizeNumber ?? '?'
    sizes.set(sz, (sizes.get(sz) ?? 0) + it.quantityOrdered)
    colours.set(it.colorNumber ?? '', sizes)
    arts.set(it.artNumber, colours)
  }
  const total = o.items.reduce((s, x) => s + x.quantityOrdered, 0)
  const when = new Date(o.orderedAt)
  const date = `${String(when.getDate()).padStart(2, '0')}/${String(when.getMonth() + 1).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  let rows = ''
  let n = 0 // line numbers 1, 2, 3 … through the whole order (owner, 24 Nov 2026); they carry on after "contd."
  for (const [art, colours] of arts) {
    let first = true
    for (const [colour, sizes] of colours) {
      const s = [...sizes].sort(([a], [b]) => sizeOrder(a, b)).map(([sz, q]) => `${esc(sz)}/${q}`).join(' ')
      rows += `<tr><td class="n">${++n}</td><td class="a">${first ? esc(art) : ''}</td><td class="c">${esc(colour || '—')}</td><td class="s">${s}</td><td class="t"></td></tr>`
      first = false
    }
  }
  return `<section class="o" data-i="${i}" data-name="${esc(o.shopkeeperName)}" data-no="${esc(o.orderNumber)}">
<div class="h"><b>${esc(o.shopkeeperName)}</b>${o.hindiName && o.hindiName !== o.shopkeeperName ? `<span class="hi">${esc(o.hindiName)}</span>` : ''}</div>
<div class="m">${o.address ? `${esc(o.address)} · ` : ''}${esc(o.orderNumber)} · ${date}</div>
<table>${rows}</table>
<div class="f"><b>${total} pairs</b><span>SM: ${esc(o.salesman || '—')}</span><span>Picked: ____</span></div>
</section>`
}

const STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #fff; color: #000; }
  body { font: 10px/1.25 Arial, Helvetica, sans-serif; }
  .o { border-top: 1.2px solid #000; padding: 2px 0 4px; }
  .h { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; line-height: 1.2; }
  .h b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hi { font-family: 'Noto Sans Devanagari', Mangal, Arial, sans-serif; font-size: 10.5px; white-space: nowrap; }
  .k .h .km { font-size: 8.5px; color: #333; white-space: nowrap; }
  .m { font-size: 8.5px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 1px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0.5px 3px 0.5px 0; vertical-align: top; }
  td.n { width: 1%; padding-right: 2px; text-align: right; color: #555; font-size: 8.5px; font-variant-numeric: tabular-nums; }
  td.a { font-weight: bold; white-space: nowrap; width: 1%; }
  td.c { white-space: nowrap; width: 1%; }
  td.s { font-weight: bold; font-variant-numeric: tabular-nums; }
  td.t { width: 9px; padding: 0; }
  td.t::after { content: ''; display: inline-block; width: 7px; height: 7px; border: 1px solid #000; margin-top: 2px; }
  tr + tr td { border-top: 0.5px dotted #bbb; }
  .f { display: flex; justify-content: space-between; gap: 6px; font-size: 9px; border-top: 0.5px solid #888; margin-top: 1px; padding-top: 1px; }
  .f b { font-size: 10px; }
`
const FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;700&display=swap"/>'

export interface MeasuredBlock { head: number; rows: number[]; foot: number; contdHead: number }
export interface Piece { i: number; from: number; to: number; first: boolean; last: boolean }

/**
 * Place measured orders into columns of height H (mm): longest first, each into the first column with
 * room; an order taller than a column is split by its lines into fresh columns (a "contd." header on
 * the later parts). Returns the columns in order (page = column index ÷ columns per page).
 * Self-contained on purpose (plain loops, no outside names): its source is also run in the print window.
 */
export function packColumns(blocks: MeasuredBlock[], H: number): Piece[][] {
  const cols: { free: number; items: Piece[] }[] = []
  const order: number[] = []
  const totals: number[] = []
  for (let i = 0; i < blocks.length; i++) {
    let t = blocks[i].head + blocks[i].foot
    for (let r = 0; r < blocks[i].rows.length; r++) t += blocks[i].rows[r]
    totals.push(t)
    order.push(i)
  }
  order.sort(function (a, b) { return totals[b] - totals[a] || a - b })
  for (let k = 0; k < order.length; k++) {
    const b = order[k], blk = blocks[b]
    if (totals[b] <= H) {
      let placed = false
      for (let c = 0; c < cols.length; c++) {
        if (cols[c].free >= totals[b]) { cols[c].free -= totals[b]; cols[c].items.push({ i: b, from: 0, to: blk.rows.length, first: true, last: true }); placed = true; break }
      }
      if (!placed) cols.push({ free: H - totals[b], items: [{ i: b, from: 0, to: blk.rows.length, first: true, last: true }] })
      continue
    }
    // Taller than a column: split by lines, each part in a fresh column.
    let from = 0, used = blk.head, first = true
    for (let r2 = 0; r2 < blk.rows.length; r2++) {
      const isLast = r2 === blk.rows.length - 1
      const need = blk.rows[r2] + (isLast ? blk.foot : 0)
      if (used + need > H && r2 > from) {
        cols.push({ free: 0, items: [{ i: b, from: from, to: r2, first: first, last: false }] })
        from = r2; used = blk.contdHead; first = false
      }
      used += blk.rows[r2]
    }
    used += blk.foot
    cols.push({ free: Math.max(0, H - used), items: [{ i: b, from: from, to: blk.rows.length, first: first, last: true }] })
  }
  const out: Piece[][] = []
  for (let q = 0; q < cols.length; q++) out.push(cols[q].items)
  return out
}

/**
 * Measure the order blocks inside `root` (mm). Self-contained (its source also runs in the print
 * window). `sample` is a "contd." block used to measure that shorter header.
 */
export function measureBlocks(root: ParentNode, sample: Element): MeasuredBlock[] {
  const PX = 25.4 / 96
  const sr = sample.getBoundingClientRect(), st = sample.querySelector('table')!.getBoundingClientRect()
  const contdHead = (st.top - sr.top) * PX
  const secs = root.querySelectorAll('section.o:not(.k)')
  const out: MeasuredBlock[] = []
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i].getBoundingClientRect(), tb = secs[i].querySelector('table')!.getBoundingClientRect()
    const trs = secs[i].querySelectorAll('tr'), rows: number[] = []
    for (let r = 0; r < trs.length; r++) rows.push(trs[r].getBoundingClientRect().height * PX)
    out.push({ head: (tb.top - s.top) * PX, rows: rows, foot: (s.bottom - tb.bottom) * PX, contdHead: contdHead })
  }
  return out
}

const sampleContd = (w: number) =>
  `<section class="o k" id="kc" style="width:${w}mm"><div class="h"><b>SAMPLE</b><span class="km">ORD-1 · contd.</span></div><table><tr><td class="a">X</td></tr></table></section>`

/** The whole print window: draws, measures, places, then prints itself. */
export function pickListHtml(orders: PickOrder[], pageSize: PageSize, orientation: Orientation, opts: { autoPrint?: boolean } = {}): string {
  const g = geometry(pageSize, orientation)
  const script = `
(function () {
  var pack = ${packColumns.toString()};
  var measure = ${measureBlocks.toString()};
  function layout() {
    var src = document.getElementById('src'), sample = document.getElementById('kc');
    var secs = src.querySelectorAll('section.o');
    var cols = pack(measure(src, sample), ${g.columnH});
    var out = document.getElementById('out');
    var page = null;
    for (var c = 0; c < cols.length; c++) {
      if (c % ${g.columns} === 0) { page = document.createElement('div'); page.className = 'page'; out.appendChild(page); }
      var col = document.createElement('div'); col.className = 'col'; page.appendChild(col);
      for (var p = 0; p < cols[c].length; p++) {
        var it = cols[c][p], node = secs[it.i].cloneNode(true);
        var trs = node.querySelectorAll('tr');
        for (var r = trs.length - 1; r >= 0; r--) if (r < it.from || r >= it.to) trs[r].parentNode.removeChild(trs[r]);
        if (!it.last) node.removeChild(node.querySelector('.f'));
        if (!it.first) {
          node.className += ' k';
          node.removeChild(node.querySelector('.m'));
          var h = node.querySelector('.h'); var hi = h.querySelector('.hi'); if (hi) h.removeChild(hi);
          var km = document.createElement('span'); km.className = 'km'; km.textContent = node.getAttribute('data-no') + ' · contd.'; h.appendChild(km);
        }
        col.appendChild(node);
      }
    }
    src.parentNode.removeChild(src); sample.parentNode.removeChild(sample);
    document.title = 'Orders · ' + Math.ceil(cols.length / ${g.columns}) + ' page(s)';
    ${opts.autoPrint === false ? '' : 'window.print();'}
  }
  var done = false; function go() { if (!done) { done = true; layout(); } }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(go);
  setTimeout(go, 2500);
})();`
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Orders</title>
${FONT_LINK}
<style>
  @page { size: ${pageSize} ${orientation}; margin: ${MARGIN_MM}mm; }
  ${STYLE}
  #src { position: absolute; left: -10000px; top: 0; width: ${g.columnW}mm; }
  .page { display: flex; gap: ${GAP_MM}mm; width: ${g.contentW}mm; height: ${g.columnH}mm; overflow: hidden; break-after: page; }
  .page:last-child { break-after: auto; }
  .col { width: ${g.columnW}mm; flex: none; }
  @media screen { #out { margin: ${MARGIN_MM}mm auto; width: ${g.contentW}mm; } .page { outline: 1px dashed #ccc; margin-bottom: 6mm; } }
</style></head><body>
<div id="src">${orders.map(orderBlock).join('\n')}</div>
${sampleContd(g.columnW)}
<div id="out"></div>
<script>${script}</script>
</body></html>`
}

export interface FormatEstimate { pageSize: PageSize; orientation: Orientation; pages: number; columns: number; a4Sheets: number }

/**
 * Before printing (browser only): pages each paper choice needs, by drawing the orders off-screen at
 * every column width and placing them as the print does. Best = least paper (an A5 page is half an
 * A4 sheet), then fewer pages. One hidden frame; no network or database.
 */
export async function estimatePickListPages(orders: PickOrder[]): Promise<FormatEstimate[]> {
  if (!orders.length) return []
  const geos = FORMATS.map((f) => ({ ...f, g: geometry(f.pageSize, f.orientation) }))
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1600px;height:1200px;border:0;visibility:hidden'
  frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${FONT_LINK}<style>${STYLE} .w{position:absolute;left:0;top:0}</style></head><body>${
    geos.map((x, n) => `<div class="w" id="w${n}" style="width:${x.g.columnW}mm">${orders.map(orderBlock).join('')}${sampleContd(x.g.columnW).replace('id="kc"', `id="kc${n}"`)}</div>`).join('')
  }</body></html>`
  document.body.appendChild(frame)
  try {
    await new Promise<void>((resolve) => { frame.onload = () => resolve() })
    const doc = frame.contentDocument!
    await Promise.race([doc.fonts?.ready, new Promise((r) => setTimeout(r, 2000))])
    return geos.map((x, n) => {
      const cols = packColumns(measureBlocks(doc.getElementById(`w${n}`)!, doc.getElementById(`kc${n}`)!), x.g.columnH).length
      const pages = Math.ceil(cols / x.g.columns)
      return { pageSize: x.pageSize, orientation: x.orientation, pages, columns: cols, a4Sheets: x.pageSize === 'A5' ? pages / 2 : pages }
    }).sort((a, b) => a.a4Sheets - b.a4Sheets || a.pages - b.pages)
  } finally {
    frame.remove()
  }
}
