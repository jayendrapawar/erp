'use client'

// Print settings: pages each paper choice needs for the selected orders, worked out before printing
// (owner, 24 Nov 2026). The orders are drawn off-screen and placed exactly as the print does
// (lib/orders/pick-list-print.ts). The least paper is chosen for you; tap another to use it.

import { useEffect, useState } from 'react'
import { estimatePickListPages, type FormatEstimate, type Orientation, type PageSize, type PickOrder } from '@/lib/orders/pick-list-print'

type Props = {
  /** Changes when the selected orders change (their ids), so the estimate is not redone on every render. */
  ordersKey: string
  orders: PickOrder[]
  pageSize: PageSize
  orientation: Orientation
  onPick: (pageSize: PageSize, orientation: Orientation) => void
}

const label = (e: { pageSize: PageSize; orientation: Orientation }) => `${e.pageSize} ${e.orientation === 'portrait' ? 'upright' : 'sideways'}`
const sheets = (n: number) => (n === 0.5 ? 'half an A4 sheet' : n === 1 ? '1 A4 sheet' : `${Math.floor(n)}${n % 1 ? '½' : ''} A4 sheets`)

export function PaperEstimate({ ordersKey, orders, pageSize, orientation, onPick }: Props) {
  const [est, setEst] = useState<FormatEstimate[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setEst(null); setFailed(false)
    estimatePickListPages(orders)
      .then((r) => {
        if (!live) return
        setEst(r)
        if (r[0]) onPick(r[0].pageSize, r[0].orientation) // least paper first
      })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
    // Recomputed only when the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordersKey])

  if (failed) return null
  return (
    <div className="px-4 pt-3">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Paper needed for these orders</p>
      {!est ? (
        <p className="text-xs text-muted-foreground animate-pulse">Working out the pages…</p>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {est.map((e, i) => {
            const on = e.pageSize === pageSize && e.orientation === orientation
            return (
              <button key={label(e)} type="button" onClick={() => onPick(e.pageSize, e.orientation)}
                className={`rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${on ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'}`}>
                <span className="block font-semibold text-foreground">
                  {label(e)}{i === 0 && <span className="ml-1 rounded bg-green-100 px-1 text-[10px] text-green-800 dark:bg-green-900/40 dark:text-green-300">least paper</span>}
                </span>
                <span className="block text-muted-foreground">{`${e.pages} page${e.pages === 1 ? '' : 's'}${e.pageSize === 'A5' ? ` = ${sheets(e.a4Sheets)}` : ''}`}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
