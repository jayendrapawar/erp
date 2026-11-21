import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getShopSession } from '@/lib/shop/auth'
import { getMyShopOrders } from '@/app/actions/shop'

export const metadata = { title: 'My orders — Shayona order app' }
export const dynamic = 'force-dynamic'

const STATUS: Record<string, { label: string; cls: string }> = {
  to_confirm: { label: 'Waiting for Shayona', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  pending:    { label: 'Confirmed', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  assigned:   { label: 'Being packed', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  packed:     { label: 'Packed', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  billed:     { label: 'Billed', cls: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300' },
  dispatched: { label: 'On the way', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  delivered:  { label: 'Delivered', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  cancelled:  { label: 'Cancelled', cls: 'bg-red-500/15 text-red-700 dark:text-red-300' },
}

// 1 query (the retailer's last 30 shop orders).
export default async function MyShopOrdersPage() {
  const s = await getShopSession()
  if (!s) redirect('/shop/sign-in')
  const orders = await getMyShopOrders()
  return (
    <main className="mx-auto min-h-dvh max-w-2xl bg-background px-3 pb-10 sm:px-4">
      <header className="sticky top-0 z-10 -mx-3 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2.5 backdrop-blur sm:-mx-4 sm:px-4">
        <Link href="/shop" aria-label="Back to the shop" className="flex h-10 w-10 items-center justify-center rounded-xl hover:bg-muted"><ChevronLeft className="h-5 w-5" aria-hidden /></Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold">My orders</h1>
          <p className="truncate text-xs text-muted-foreground" data-no-translate>{s.name}</p>
        </div>
      </header>
      {orders.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-sm text-muted-foreground">No orders yet.</p>
          <Link href="/shop" className="mt-3 inline-flex h-11 items-center rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground">Start shopping</Link>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {orders.map((o) => {
            const st = STATUS[o.status] ?? { label: o.status, cls: 'bg-muted text-foreground' }
            return (
              <li key={o.orderNumber} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-semibold">{o.orderNumber}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(o.orderedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {` · ${o.pairs} pairs · ${o.lines} line${o.lines === 1 ? '' : 's'}`}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${st.cls}`}>{st.label}</span>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
