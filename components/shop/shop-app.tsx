'use client'

// Retailer shop (owner, 21 Nov 2026): article colours with photos and the latest MRP; tap one for its
// photos, other colours and a size grid (pairs per size, or + a Master set, or + a carton); cart kept
// on this phone; Place order → staff confirm it before picking. No database queries while browsing.

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, LogOut, Minus, Package, Plus, Search, ShoppingBag, X } from 'lucide-react'
import { placeShopOrder, shopSignOut } from '@/app/actions/shop'
import { coversArticle } from '@/lib/catalog/assortments'
import type { ShopCarton, ShopCatalogue, ShopItem, ShopSet } from '@/lib/shop/catalogue'

type Cart = Record<string, number> // "itemId|size" → pairs
const PAGE = 60
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

function cartKey(retailerId: string) { return `shayona.shop.cart.v1.${retailerId}` }
function loadCart(retailerId: string): Cart {
  try { const v = JSON.parse(localStorage.getItem(cartKey(retailerId)) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
function saveCart(retailerId: string, cart: Cart) {
  try { localStorage.setItem(cartKey(retailerId), JSON.stringify(cart)) } catch { /* private window: this visit only */ }
}

/** Sets whose sizes all exist for this article. */
function setsFor(item: ShopItem, sets: ShopSet[]) {
  return sets.filter((s) => { const k = Object.keys(s.quantities).filter((z) => s.quantities[z] > 0); return k.length > 0 && k.every((z) => item.sizes.includes(z)) })
}
/** Carton assortments for this article: same division + segment, "only for" allows it, sizes exist. */
function cartonsFor(item: ShopItem, cartons: ShopCarton[]) {
  if (!item.division || !item.segment) return []
  const d = item.division.toLowerCase(), g = item.segment.toLowerCase()
  return cartons.filter((c) => c.division.toLowerCase() === d && c.segment.toLowerCase() === g && coversArticle(c.onlyFor, item.code) && c.sizes.every((z) => item.sizes.includes(z.size)))
}

export function ShopApp({ catalogue, retailerId, retailerName }: { catalogue: ShopCatalogue; retailerId: string; retailerName: string }) {
  const router = useRouter()
  const items = catalogue.items
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const [q, setQ] = useState('')
  const [segment, setSegment] = useState('')
  const [division, setDivision] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [openId, setOpenId] = useState<number | null>(null)
  const [cart, setCart] = useState<Cart>({})
  const [cartOpen, setCartOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => { setCart(loadCart(retailerId)); setLoaded(true) }, [retailerId])
  useEffect(() => { if (loaded) saveCart(retailerId, cart) }, [cart, loaded, retailerId])

  const segments = useMemo(() => [...new Set(items.map((i) => i.segment).filter(Boolean) as string[])].sort(), [items])
  const divisions = useMemo(() => [...new Set(items.map((i) => i.division).filter(Boolean) as string[])].sort(), [items])
  const filtered = useMemo(() => {
    const n = norm(q)
    return items.filter((i) => (!segment || i.segment === segment) && (!division || i.division === division)
      && (!n || norm(`${i.name} ${i.code} ${i.color} ${i.colorCode}`).includes(n)))
  }, [items, q, segment, division])
  useEffect(() => { setShown(PAGE) }, [q, segment, division])

  // Cart lines that still exist in the catalogue
  const cartLines = useMemo(() => Object.entries(cart).map(([k, qty]) => {
    const [id, size] = k.split('|'); const item = byId.get(Number(id))
    return item && qty > 0 && item.sizes.includes(size) ? { key: k, item, size, qty } : null
  }).filter(Boolean) as Array<{ key: string; item: ShopItem; size: string; qty: number }>, [cart, byId])
  const cartPairs = cartLines.reduce((t, l) => t + l.qty, 0)
  const open = openId != null ? byId.get(openId) ?? null : null

  return (
    <div className="min-h-dvh bg-background pb-24">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2.5 sm:px-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary font-display text-lg font-bold text-primary-foreground">S</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-base font-bold leading-tight">Shayona</p>
            <p className="truncate text-xs text-muted-foreground" data-no-translate>{retailerName}</p>
          </div>
          <Link href="/shop/orders" className="flex h-10 items-center rounded-xl border border-border px-3 text-sm font-semibold hover:bg-muted">My orders</Link>
          <button type="button" aria-label="Sign out" title="Sign out" onClick={async () => { await shopSignOut(); router.replace('/shop/sign-in'); router.refresh() }}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted"><LogOut className="h-4 w-4" aria-hidden /></button>
        </div>
        <div className="mx-auto max-w-6xl space-y-2 px-3 pb-3 sm:px-4">
          <label className="flex h-11 items-center gap-2 rounded-xl border border-border bg-card px-3">
            <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="sr-only">Search articles</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search article, code or colour" className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" />
            {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="text-muted-foreground"><X className="h-4 w-4" aria-hidden /></button>}
          </label>
          {(segments.length > 1 || divisions.length > 1) && (
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
              {divisions.length > 1 && divisions.map((d) => (
                <button key={d} type="button" onClick={() => setDivision(division === d ? '' : d)} aria-pressed={division === d}
                  className={`h-8 shrink-0 rounded-full border px-3 text-xs font-semibold ${division === d ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-foreground'}`}>{d}</button>
              ))}
              {segments.length > 1 && segments.map((s) => (
                <button key={s} type="button" onClick={() => setSegment(segment === s ? '' : s)} aria-pressed={segment === s}
                  className={`h-8 shrink-0 rounded-full border px-3 text-xs font-semibold ${segment === s ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground'}`}>{s}</button>
              ))}
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-3 pt-3 sm:px-4">
        {items.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">No articles to show yet. Please check again soon.</p>}
        {items.length > 0 && filtered.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">Nothing matches. Try another word or clear the filters.</p>}
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.slice(0, shown).map((i) => {
            const inCart = cartLines.filter((l) => l.item.id === i.id).reduce((t, l) => t + l.qty, 0)
            return (
              <li key={i.id}>
                <button type="button" onClick={() => setOpenId(i.id)} className="block w-full overflow-hidden rounded-2xl border border-border bg-card text-left transition hover:border-primary/60">
                  <div className="relative aspect-square bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element -- photos already small (Blob), no image optimiser */}
                    <img src={i.photos[0]} alt={`${i.name} ${i.color}`} loading="lazy" className="h-full w-full object-contain" />
                    {inCart > 0 && <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">{inCart} in cart</span>}
                  </div>
                  <div className="space-y-0.5 p-2.5">
                    <p className="truncate text-sm font-bold" data-no-translate>{i.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{i.color}{i.segment ? ` · ${i.segment}` : ''}</p>
                    <p className="text-sm font-semibold">{i.mrp != null ? `MRP ${inr(i.mrp)}` : <span className="text-muted-foreground">MRP on request</span>}</p>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
        {filtered.length > shown && (
          <button type="button" onClick={() => setShown((n) => n + PAGE)} className="mx-auto mt-4 block h-11 rounded-xl border border-border px-5 text-sm font-semibold hover:bg-muted">
            {`Show more (${filtered.length - shown} more)`}
          </button>
        )}
      </main>

      {cartPairs > 0 && !open && !cartOpen && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 p-3 backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button type="button" onClick={() => setCartOpen(true)} className="mx-auto flex h-12 w-full max-w-md items-center justify-between rounded-xl bg-primary px-4 text-primary-foreground">
            <span className="flex items-center gap-2 text-sm font-bold"><ShoppingBag className="h-5 w-5" aria-hidden />{`Cart · ${cartPairs} pairs`}</span>
            <span className="text-sm font-semibold">Review order →</span>
          </button>
        </div>
      )}

      {open && (
        <ArticleSheet
          item={open}
          colours={items.filter((x) => x.name === open.name)}
          sets={setsFor(open, catalogue.sets)}
          cartons={cartonsFor(open, catalogue.cartons)}
          inCart={Object.fromEntries(cartLines.filter((l) => l.item.id === open.id).map((l) => [l.size, l.qty]))}
          onPick={(id) => setOpenId(id)}
          onClose={() => setOpenId(null)}
          onSave={(qty) => {
            setCart((c) => {
              const next = { ...c }
              for (const k of Object.keys(next)) if (k.startsWith(`${open.id}|`)) delete next[k]
              for (const [size, n] of Object.entries(qty)) if (n > 0) next[`${open.id}|${size}`] = n
              return next
            })
            setOpenId(null)
          }}
        />
      )}

      {cartOpen && (
        <CartSheet
          lines={cartLines}
          onChange={(key, qty) => setCart((c) => { const n = { ...c }; if (qty > 0) n[key] = qty; else delete n[key]; return n })}
          onEdit={(id) => { setCartOpen(false); setOpenId(id) }}
          onClose={() => setCartOpen(false)}
          onPlaced={() => setCart({})}
        />
      )}
    </div>
  )
}

function Stepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" aria-label={`One less, ${label}`} onClick={() => onChange(Math.max(0, value - 1))}
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-muted"><Minus className="h-4 w-4" aria-hidden /></button>
      <input aria-label={label} value={value || ''} placeholder="0" inputMode="numeric"
        onChange={(e) => onChange(Math.min(999, Math.max(0, parseInt(e.target.value.replace(/\D/g, '') || '0', 10))))}
        className="h-10 w-14 rounded-xl border border-input bg-background text-center text-base font-bold tabular-nums focus:outline-none focus:ring-2 focus:ring-ring" />
      <button type="button" aria-label={`One more, ${label}`} onClick={() => onChange(Math.min(999, value + 1))}
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-muted"><Plus className="h-4 w-4" aria-hidden /></button>
    </div>
  )
}

function ArticleSheet({ item, colours, sets, cartons, inCart, onPick, onClose, onSave }: {
  item: ShopItem; colours: ShopItem[]; sets: ShopSet[]; cartons: ShopCarton[]; inCart: Record<string, number>
  onPick: (id: number) => void; onClose: () => void; onSave: (qty: Record<string, number>) => void
}) {
  const [qty, setQty] = useState<Record<string, number>>(inCart)
  const [photo, setPhoto] = useState(0)
  useEffect(() => { setQty(inCart); setPhoto(0) }, [item.id]) // reset when another colour is opened
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const total = Object.values(qty).reduce((t, n) => t + n, 0)
  const addAll = (add: Record<string, number>) => setQty((q) => { const n = { ...q }; for (const [s, v] of Object.entries(add)) n[s] = Math.min(999, (n[s] ?? 0) + v); return n })

  return (
    <div className="fixed inset-0 z-40 flex justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label={`${item.name} ${item.color}`} onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col bg-background sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:border sm:border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <button type="button" onClick={onClose} aria-label="Back" className="flex h-10 w-10 items-center justify-center rounded-xl hover:bg-muted"><ChevronLeft className="h-5 w-5" aria-hidden /></button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold" data-no-translate>{item.name}</h2>
            <p className="truncate text-xs text-muted-foreground">{item.color}{item.colorCode ? ` (${item.colorCode})` : ''} · {item.code}</p>
          </div>
          <p className="shrink-0 text-base font-bold">{item.mrp != null ? `MRP ${inr(item.mrp)}` : ''}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element -- photos already small (Blob) */}
            <img src={item.photos[photo] ?? item.photos[0]} alt={`${item.name} ${item.color} photo ${photo + 1}`} className="mx-auto aspect-square max-h-[48vh] w-full object-contain" />
          </div>
          {item.photos.length > 1 && (
            <div className="no-scrollbar flex gap-2 overflow-x-auto px-3 py-2">
              {item.photos.map((p, i) => (
                <button key={p} type="button" onClick={() => setPhoto(i)} aria-label={`Photo ${i + 1}`} aria-pressed={photo === i}
                  className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 bg-white ${photo === i ? 'border-primary' : 'border-transparent'}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- thumbnail */}
                  <img src={p} alt="" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          )}

          <div className="space-y-4 p-3">
            {colours.length > 1 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Colours</p>
                <div className="no-scrollbar flex gap-2 overflow-x-auto">
                  {colours.map((c) => (
                    <button key={c.id} type="button" onClick={() => onPick(c.id)} aria-pressed={c.id === item.id}
                      className={`flex shrink-0 items-center gap-2 rounded-xl border p-1.5 pr-3 text-left ${c.id === item.id ? 'border-primary bg-primary/10' : 'border-border'}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- thumbnail */}
                      <img src={c.photos[0]} alt="" className="h-10 w-10 rounded-lg bg-white object-contain" />
                      <span className="text-xs font-semibold">{c.color}<span className="block font-normal text-muted-foreground">{c.code}</span></span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(sets.length > 0 || cartons.length > 0) && (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quick fill</p>
                <div className="flex flex-wrap gap-2">
                  {sets.map((s) => (
                    <button key={`s${s.id}`} type="button" onClick={() => addAll(s.quantities)} className="rounded-xl border border-border px-3 py-2 text-left text-xs hover:bg-muted">
                      <span className="block text-sm font-semibold">{`+ Set: ${s.name}`}</span>
                      {Object.entries(s.quantities).filter(([, n]) => n > 0).map(([z, n]) => `${z}×${n}`).join('  ')}
                    </button>
                  ))}
                  {cartons.map((c) => (
                    <button key={`c${c.id}`} type="button" onClick={() => addAll(Object.fromEntries(c.sizes.map((z) => [z.size, z.pairs])))} className="rounded-xl border border-border px-3 py-2 text-left text-xs hover:bg-muted">
                      <span className="flex items-center gap-1.5 text-sm font-semibold"><Package className="h-4 w-4" aria-hidden />{`+ Carton (${c.pairs} pairs)`}</span>
                      {c.sizes.map((z) => `${z.size}×${z.pairs}`).join('  ')}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pairs per size</p>
              <ul className="divide-y divide-border rounded-2xl border border-border">
                {item.sizes.map((s) => (
                  <li key={s} className="flex items-center justify-between px-3 py-2">
                    <span className="text-base font-bold">{`Size ${s}`}</span>
                    <Stepper value={qty[s] ?? 0} onChange={(n) => setQty((q) => ({ ...q, [s]: n }))} label={`size ${s}`} />
                  </li>
                ))}
              </ul>
              {total > 0 && <button type="button" onClick={() => setQty({})} className="mt-2 text-xs font-semibold text-muted-foreground underline">Clear all sizes</button>}
            </div>
          </div>
        </div>

        <div className="border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button type="button" onClick={() => onSave(qty)} disabled={total === 0 && Object.keys(inCart).length === 0}
            className="h-12 w-full rounded-xl bg-primary text-base font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {total === 0 ? (Object.keys(inCart).length ? 'Remove from cart' : 'Choose sizes') : Object.keys(inCart).length ? `Update cart · ${total} pairs` : `Add to cart · ${total} pairs`}
          </button>
        </div>
      </section>
    </div>
  )
}

function CartSheet({ lines, onChange, onEdit, onClose, onPlaced }: {
  lines: Array<{ key: string; item: ShopItem; size: string; qty: number }>
  onChange: (key: string, qty: number) => void; onEdit: (itemId: number) => void; onClose: () => void; onPlaced: () => void
}) {
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [placed, setPlaced] = useState<{ orderNumber: string; pairs: number } | null>(null)
  const [busy, start] = useTransition()
  const groups = useMemo(() => {
    const m = new Map<number, { item: ShopItem; lines: typeof lines }>()
    for (const l of lines) { const g = m.get(l.item.id) ?? { item: l.item, lines: [] }; g.lines.push(l); m.set(l.item.id, g) }
    return [...m.values()]
  }, [lines])
  const pairs = lines.reduce((t, l) => t + l.qty, 0)

  return (
    <div className="fixed inset-0 z-40 flex justify-center bg-black/60 sm:items-center sm:p-4" onClick={() => !busy && onClose()}>
      <section role="dialog" aria-modal="true" aria-labelledby="cart-h" onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col bg-background sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:border sm:border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <button type="button" onClick={onClose} disabled={busy} aria-label="Back" className="flex h-10 w-10 items-center justify-center rounded-xl hover:bg-muted"><ChevronLeft className="h-5 w-5" aria-hidden /></button>
          <h2 id="cart-h" className="flex-1 text-base font-bold">{placed ? 'Order placed' : `Your order · ${pairs} pairs`}</h2>
        </div>

        {placed ? (
          <div className="space-y-4 p-5 text-center">
            <p className="text-lg font-bold">Thank you!</p>
            <p className="text-sm text-muted-foreground">{`Order ${placed.orderNumber} (${placed.pairs} pairs) is sent. Shayona will check it and confirm.`}</p>
            <Link href="/shop/orders" className="mx-auto flex h-12 max-w-xs items-center justify-center rounded-xl border border-border text-sm font-bold hover:bg-muted">See my orders</Link>
            <button type="button" onClick={onClose} className="mx-auto block h-12 w-full max-w-xs rounded-xl bg-primary text-sm font-bold text-primary-foreground">Continue shopping</button>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {groups.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">The cart is empty.</p>}
              {groups.map((g) => (
                <div key={g.item.id} className="rounded-2xl border border-border">
                  <div className="flex items-center gap-3 border-b border-border p-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element -- thumbnail */}
                    <img src={g.item.photos[0]} alt="" className="h-12 w-12 rounded-lg bg-white object-contain" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold" data-no-translate>{g.item.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{g.item.color} · {g.item.code}{g.item.mrp != null ? ` · MRP ${inr(g.item.mrp)}` : ''}</p>
                    </div>
                    <button type="button" onClick={() => onEdit(g.item.id)} className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold hover:bg-muted">Change</button>
                  </div>
                  <ul className="divide-y divide-border">
                    {g.lines.map((l) => (
                      <li key={l.key} className="flex items-center justify-between px-3 py-1.5">
                        <span className="text-sm font-semibold">{`Size ${l.size}`}</span>
                        <Stepper value={l.qty} onChange={(n) => onChange(l.key, n)} label={`${g.item.name} size ${l.size}`} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {groups.length > 0 && (
                <label className="block text-sm font-medium">Note for Shayona (optional)
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} rows={2} placeholder="e.g. send by Monday"
                    className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring" />
                </label>
              )}
              {error && <p role="alert" className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
            </div>
            <div className="border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <button type="button" disabled={busy || pairs === 0}
                onClick={() => start(async () => {
                  setError(null)
                  try {
                    const r = await placeShopOrder({ lines: lines.map((l) => ({ itemId: l.item.id, size: l.size, qty: l.qty })), notes })
                    setPlaced(r); onPlaced()
                  } catch (e) { setError(e instanceof Error ? e.message : 'Order not sent. Try again.') }
                })}
                className="h-12 w-full rounded-xl bg-primary text-base font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {busy ? 'Sending…' : `Place order · ${pairs} pairs`}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
