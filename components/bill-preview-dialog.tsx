'use client'

// Full preview of a generated bill, exactly as it prints (owner, 21 Nov 2026: Receipts → click a bill).
// The bill is drawn in a frame on this page and printed from there — no pop-up window, so pop-up
// blockers cannot stop it. Loads the bill's saved lines and discount: 1 query.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Printer, X } from 'lucide-react'
import { getBillLines } from '@/app/actions/orders'
import { buildInvoiceHtml, transliterateToHindi, type MrpLine, type PageSize } from '@/lib/bill-html'
import type { BillTemplate } from '@/lib/bill-template'
import { DialogKeys } from '@/components/dialog-keys'

export interface PreviewBill {
  id: number
  orderNumber: string
  billNo?: string | null
  shopkeeperName: string
  shopkeeperPhone: string | null
  shopkeeperAddress: string | null
  billedAt: Date | null
}

export function BillPreviewDialog({ bill, template, defaultPageSize, fallbackLines, fallbackDiscPct, onClose }: {
  bill: PreviewBill
  template?: BillTemplate
  defaultPageSize: PageSize
  /** Lines known on this screen already (used only if the saved bill has none). */
  fallbackLines?: MrpLine[]
  fallbackDiscPct: number
  onClose: () => void
}) {
  const [lines, setLines] = useState<MrpLine[] | null>(null)
  const [discPct, setDiscPct] = useState(fallbackDiscPct)
  const [error, setError] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState<PageSize>(defaultPageSize)
  const [hindi, setHindi] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  // Read once per bill (a new array from the parent on each render must not reload the bill).
  const fallbackRef = useRef(fallbackLines)

  useEffect(() => {
    let live = true
    getBillLines(bill.id)
      .then((rows) => {
        if (!live) return
        if (rows.length > 0) {
          setLines(rows.map((r) => ({ artNumber: r.artNumber, mrp: r.mrp, qty: r.qty, hsn: r.hsn })))
          if (Number.isFinite(rows[0].lineDiscPct)) setDiscPct(rows[0].lineDiscPct)
        } else {
          setLines(fallbackRef.current ?? [])
        }
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the bill.') })
    return () => { live = false }
  }, [bill.id])

  useEffect(() => {
    if (!template?.showHindiName) return
    let live = true
    transliterateToHindi(bill.shopkeeperName).then((h) => { if (live) setHindi(h) })
    return () => { live = false }
  }, [bill.shopkeeperName, template?.showHindiName])

  // Esc: <DialogKeys> (focus returns to the opener).

  const html = useMemo(() => (lines && lines.length > 0 ? buildInvoiceHtml({
    vendor: { name: bill.shopkeeperName, nameHindi: hindi, phone: bill.shopkeeperPhone, address: bill.shopkeeperAddress },
    order: { orderNumber: bill.orderNumber, billNo: bill.billNo, billedAt: bill.billedAt },
    lines, lineDiscPct: discPct, pageSize, template,
  }) : ''), [lines, discPct, pageSize, template, hindi, bill])

  function print() {
    const w = frame.current?.contentWindow
    if (!w) return
    w.focus()
    w.print()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70" role="dialog" aria-modal="true" aria-label={`Bill ${bill.orderNumber}`}>
      <DialogKeys onClose={onClose} />
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-foreground" data-no-translate>{bill.shopkeeperName}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{bill.billNo ? `Bill ${bill.billNo} · ` : ''}{bill.orderNumber}</p>
        </div>
        <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Bill size">
          {(['A4', 'A5'] as PageSize[]).map((p) => (
            <button key={p} type="button" onClick={() => setPageSize(p)} aria-pressed={pageSize === p}
              className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${pageSize === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {p === 'A4' ? 'Big (A4)' : 'Small (A5)'}
            </button>
          ))}
        </div>
        <button type="button" onClick={print} disabled={!html} aria-label="Print this bill" title="Print"
          className="flex h-10 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          <Printer className="h-4 w-4" aria-hidden /><span className="hidden sm:inline">Print</span>
        </button>
        <button type="button" onClick={onClose} aria-label="Close preview"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-muted">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-neutral-300 dark:bg-neutral-800">
        {error && <p role="alert" className="p-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!error && lines === null && <p className="p-6 text-center text-sm text-muted-foreground">Loading the bill…</p>}
        {!error && lines !== null && lines.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">This bill has no lines saved.</p>}
        {html && <iframe ref={frame} title={`Bill ${bill.orderNumber}`} srcDoc={html} className="h-full w-full border-0" />}
      </div>
    </div>
  )
}
