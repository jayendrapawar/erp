'use client'

// A billed order's bill on the Orders screens (admin and biller detail): its lines and the SAVED
// amounts (sale_bills, owner 23 Nov 2026) — the same numbers the printed bill shows. A bill made
// before the amounts were saved is worked out from its lines with the print arithmetic.

import { ratePaise } from '@/lib/billing/bill-totals'
import { TAX_TYPE_SHORT, billTotalRows, formatRs, type BillAmounts } from '@/lib/billing/bill-amounts'

export interface BillCardLine { artNumber: string; mrp: number; qty: number }

export function BillDetailCard({ lines, lineDiscPct, amounts }: { lines: BillCardLine[]; lineDiscPct: number; amounts: BillAmounts }) {
  const groups = new Map<string, BillCardLine[]>()
  for (const l of lines) {
    if (!groups.has(l.artNumber)) groups.set(l.artNumber, [])
    groups.get(l.artNumber)!.push(l)
  }
  const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground'
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Bill Items</p>
        <span className="text-xs tabular-nums text-muted-foreground">
          {`${lines.length} line${lines.length !== 1 ? 's' : ''} · ${amounts.totalQty} box${amounts.totalQty !== 1 ? 'es' : ''}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/10 px-4 py-2 text-xs">
        <span className="text-muted-foreground">Disc % <b className="tabular-nums text-foreground">{lineDiscPct}</b></span>
        <span className="text-muted-foreground">Bill type <b className={amounts.taxType === 'untaxed' ? 'text-amber-700 dark:text-amber-300' : 'text-foreground'}>{amounts.walkIn ? 'Walk-in, without GST' : TAX_TYPE_SHORT[amounts.taxType]}</b></span>
        {!amounts.frozen && <span className="text-amber-700 dark:text-amber-300" title="Billed before amounts were saved on the bill">worked out from the lines</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="border-b border-border bg-muted/20">
            <tr>
              <th className={`${th} pl-4 text-left`}>Article</th>
              <th className={`${th} text-right`}>MRP</th>
              <th className={`${th} whitespace-nowrap text-right`}>{`Disc ${lineDiscPct}%`}</th>
              <th className={`${th} text-center`}>Qty</th>
              <th className={`${th} pr-4 text-right`}>Amt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {Array.from(groups.entries()).map(([art, ls]) => ls.map((l, i) => {
              const rate = ratePaise(l.mrp, lineDiscPct)
              return (
                <tr key={`${art}-${i}`} className="odd:bg-card even:bg-muted/10">
                  <td className="px-4 py-2 font-semibold text-foreground" data-no-translate>{i === 0 ? art : ''}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatRs(Math.round(l.mrp * 100))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatRs(rate)}</td>
                  <td className="px-3 py-2 text-center font-bold tabular-nums">{l.qty}</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">{formatRs(rate * l.qty)}</td>
                </tr>
              )
            }))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-border/60 border-t border-border">
        {billTotalRows(amounts).map((r) => (
          <div key={r.key} className="flex items-center justify-between px-4 py-2 text-xs">
            <span className="text-muted-foreground">{r.label}</span>
            <span className={`tabular-nums ${r.tone === 'minus' ? 'text-red-600 dark:text-red-400' : r.tone === 'plain' ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{r.value}</span>
          </div>
        ))}
        <div className="flex items-center justify-between bg-muted/20 px-4 py-3">
          <span className="text-sm font-bold text-foreground">Net Payable</span>
          <span className="text-sm font-extrabold tabular-nums text-foreground">{formatRs(amounts.grandTotalPaise)}</span>
        </div>
      </div>
    </div>
  )
}
