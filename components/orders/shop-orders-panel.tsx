'use client'

// Orders → "Retailer orders to confirm" (owner, 21 Nov 2026): orders placed in the shop wait here.
// Confirm → normal order for picking; Not accepted → cancelled with a reason. Shown only when there
// are orders waiting. Loads once per visit (1 query).

import { useCallback, useEffect, useState, useTransition } from 'react'
import { ShoppingBag } from 'lucide-react'
import { confirmShopOrder, getShopOrdersToConfirm, rejectShopOrder, type ShopOrderToConfirm } from '@/app/actions/shop-orders'

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export function ShopOrdersPanel({ canAct = true }: { canAct?: boolean }) {
  const [orders, setOrders] = useState<ShopOrderToConfirm[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => { getShopOrdersToConfirm().then(setOrders).catch(() => setOrders([])) }, [])
  useEffect(() => { load() }, [load])

  if (!orders || orders.length === 0) return null
  return (
    <section aria-labelledby="shop-orders-h" className="mb-4 rounded-2xl border border-amber-500/40 bg-amber-500/5">
      <div className="flex items-center gap-2 border-b border-amber-500/30 px-4 py-3">
        <ShoppingBag className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
        <h2 id="shop-orders-h" className="flex-1 text-sm font-bold">{`Retailer orders to confirm (${orders.length})`}</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">Placed in the shop · pickers see them after you confirm</span>
      </div>
      {error && <p role="alert" className="mx-4 mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <ul className="divide-y divide-border">
        {orders.map((o) => <ShopOrderRow key={o.id} order={o} canAct={canAct} onDone={() => { setError(null); setOrders((list) => (list ?? []).filter((x) => x.id !== o.id)) }} onError={setError} />)}
      </ul>
    </section>
  )
}

function ShopOrderRow({ order: o, canAct, onDone, onError }: { order: ShopOrderToConfirm; canAct: boolean; onDone: () => void; onError: (m: string) => void }) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, start] = useTransition()
  // lines per article + colour: "6×2  7×4"
  const groups = new Map<string, { label: string; sizes: string[] }>()
  for (const l of o.lines) {
    const k = `${l.art}|${l.colour ?? ''}|${l.code ?? ''}`
    const g = groups.get(k) ?? { label: `${l.art}${l.colour ? ` · ${l.colour}` : ''}${l.code ? ` (${l.code})` : ''}`, sizes: [] }
    g.sizes.push(`${l.size ?? '-'}×${l.qty}`); groups.set(k, g)
  }
  const run = (fn: () => Promise<void>) => start(async () => { try { await fn(); onDone() } catch (e) { onError(e instanceof Error ? e.message : 'Not saved.') } })

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <p className="text-sm font-bold" data-no-translate>{o.retailer}</p>
        <p className="font-mono text-xs text-muted-foreground">{o.orderNumber}</p>
        <p className="text-xs text-muted-foreground">{`${when(o.orderedAt)} · ${o.pairs} pairs`}</p>
      </div>
      <ul className="space-y-0.5 text-xs">
        {[...groups.values()].map((g) => <li key={g.label}><span className="font-semibold" data-no-translate>{g.label}</span><span className="text-muted-foreground">{`  ${g.sizes.join('  ')}`}</span></li>)}
      </ul>
      {o.notes && <p className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs"><span className="font-semibold">Note: </span>{o.notes}</p>}
      {canAct && !rejecting && (
        <div className="flex gap-2 pt-1">
          <button type="button" disabled={busy} onClick={() => run(() => confirmShopOrder(o.id))}
            className="h-10 flex-1 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:flex-none">
            {busy ? 'Saving…' : 'Confirm order'}
          </button>
          <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="h-10 rounded-xl border border-border px-4 text-sm font-semibold text-destructive hover:bg-muted disabled:opacity-50">Not accepted</button>
        </div>
      )}
      {canAct && rejecting && (
        <form className="flex flex-wrap gap-2 pt-1" onSubmit={(e) => { e.preventDefault(); run(() => rejectShopOrder(o.id, reason)) }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="Why? e.g. article not available" aria-label="Reason"
            className="h-10 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <button type="submit" disabled={busy || !reason.trim()} className="h-10 rounded-xl bg-destructive px-4 text-sm font-bold text-white disabled:opacity-50">Cancel order</button>
          <button type="button" onClick={() => setRejecting(false)} className="h-10 rounded-xl border border-border px-3 text-sm">Back</button>
        </form>
      )}
    </li>
  )
}
