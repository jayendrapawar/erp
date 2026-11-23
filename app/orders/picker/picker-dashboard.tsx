'use client'
import { useState, useTransition, useMemo, useEffect, useRef } from 'react'
import { useListKeys } from '@/lib/shortcuts/list'
import { StatusPill, fmt } from '../_components/shared'
import { PageNav } from '@/components/page-nav'
import {
  getOrderWithItems,
  bulkSaveAndPackOrder,
  unassignOrder,
} from '@/app/actions/orders'
import type { Order, OrderItem, OrderItemStatus } from '@/lib/db/schema'
import {
  buildProgress, clearPackProgress, packStorageKey, readPackStore, restorableTouched, savePackProgress,
  type PackProgress,
} from '@/lib/orders/pack-progress'

interface QueueItem {
  id: number
  orderNumber: string
  shopkeeperName: string
  status: string
  orderedAt: Date
  pickerId: string | null
  totalPairs: number
  packedPairs: number
}

interface Props {
  queue: QueueItem[]
  currentPickerId: string
  embedded?: boolean
  /** Called when a picker releases an order (pickerId null) */
  onPickerChange?: (orderId: number, pickerId: string | null) => void
}

function StatTile({ label, value, color, hint }: { label: string; value: number; color: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card px-2.5 py-2 sm:px-4 sm:py-3" title={hint}>
      <p className="truncate text-[11px] font-medium text-muted-foreground sm:text-xs sm:uppercase sm:tracking-wide">{label}</p>
      <p className={`mt-0.5 text-xl font-bold tabular-nums sm:text-2xl ${color}`}>{value}</p>
    </div>
  )
}

/** Thin progress bar: `done` of `total`. */
function ProgressBar({ done, total, tone = 'blue' }: { done: number; total: number; tone?: 'blue' | 'green' }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div className={`h-full rounded-full transition-[width] duration-300 ${tone === 'green' || pct === 100 ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function PickerDashboard({ queue: initialQueue, currentPickerId, embedded, onPickerChange }: Props) {
  const [queue, setQueue] = useState<QueueItem[]>(initialQueue)
  // Keyboard: ↑↓ / j k orders, Enter opens (lib/shortcuts/list.ts).
  const queueListRef = useRef<HTMLDivElement>(null)
  useListKeys(queueListRef, { label: 'Picker queue' })
  const [selectedOrder, setSelectedOrder] = useState<{ order: Order; items: OrderItem[] } | null>(null)
  const [isPending, startTransition] = useTransition()
  const [loadingId, setLoadingId] = useState<number | null>(null)
  const [unassigningId, setUnassigningId] = useState<number | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [packError, setPackError] = useState<string | null>(null)
  // touched: itemId → confirmed qty
  const [touched, setTouched] = useState<Record<number, number>>({})
  // pending: itemId → staged (selected but not yet confirmed) qty
  const [pending, setPending] = useState<Record<number, number | undefined>>({})
  // customDraft: staged value in the "other" input before the user confirms
  const [customDraft, setCustomDraft] = useState<Record<number, string>>({})

  // ── Packing progress kept on this phone (lib/orders/pack-progress.ts) ───────
  const packKey = packStorageKey(currentPickerId)
  const [packStore, setPackStore] = useState<Record<string, PackProgress>>({})
  useEffect(() => { setPackStore(readPackStore(packKey)) }, [packKey])
  // The order whose touched/pending were seeded; saving waits for it so a half-set state is never stored.
  const [seededId, setSeededId] = useState<number | null>(null)
  const [restoredCount, setRestoredCount] = useState(0)

  // ── My orders only (owner, 23 Nov 2026): the salesman or admin assigns orders; no "All orders" list.
  const myOrders = useMemo(() => queue.filter(o => o.pickerId === currentPickerId), [queue, currentPickerId])

  /** Pairs of an order already checked: saved progress on this phone, else what the server knows. */
  const checkedPairs = (o: QueueItem) => Math.min(o.totalPairs, packStore[o.id]?.doneOrderedPairs ?? o.packedPairs)

  const counts = {
    mine:      myOrders.length,
    toPack:    myOrders.reduce((s, o) => s + Math.max(0, o.totalPairs - checkedPairs(o)), 0),
  }

  // ── Open order detail ────────────────────────────────────────────────────────
  function openOrder(orderId: number) {
    setLoadingId(orderId)
    setPackError(null)
    startTransition(async () => {
      try {
        const data = await getOrderWithItems(orderId)
        setSelectedOrder(data)
      } catch (err) {
        setClaimError(err instanceof Error ? err.message : 'Could not open the order')
      } finally {
        setLoadingId(null)
      }
    })
  }

  // ── Pack order — flush all local touched state to DB in one call ─────────────
  function handleMarkPacked() {
    if (!selectedOrder) return
    const orderId = selectedOrder.order.id
    setPackError(null)
    startTransition(async () => {
      const items = selectedOrder.items.map(item => {
        const qty = touched[item.id] ?? 0
        return {
          id: item.id,
          quantityPacked: qty,
          status: (qty === 0
            ? 'out_of_stock'
            : qty >= item.quantityOrdered
            ? 'packed'
            : 'pending') as 'packed' | 'out_of_stock' | 'pending',
        }
      })
      try {
        await bulkSaveAndPackOrder(orderId, items)
      } catch (err) {
        // Progress stays saved on the phone; the picker can try again.
        setPackError(err instanceof Error ? err.message : 'Could not save. Please try again.')
        return
      }
      setPackStore(clearPackProgress(packKey, orderId))
      setQueue(prev => prev.filter(o => o.id !== orderId))
      setSelectedOrder(null)
    })
  }

  // Pre-seed touched/pending/customDraft whenever selectedOrder changes; bring back saved progress.
  useEffect(() => {
    if (!selectedOrder) { setTouched({}); setPending({}); setCustomDraft({}); setSeededId(null); setRestoredCount(0); return }
    const { order, items } = selectedOrder
    const saved = restorableTouched(readPackStore(packKey)[order.id], order, items)
    const touchedSeed: Record<number, number> = {}
    const pendingSeed: Record<number, number> = {}
    const draftSeed: Record<number, string> = {}
    for (const item of items) {
      if (item.status === 'packed' || item.status === 'out_of_stock') {
        touchedSeed[item.id] = item.quantityPacked
      } else if (item.id in saved) {
        touchedSeed[item.id] = saved[item.id]
      } else if (item.quantityOrdered <= 5) {
        // fits on a chip — pre-select it
        pendingSeed[item.id] = item.quantityOrdered
      } else {
        // exceeds fixed chips — pre-fill the custom input box instead
        draftSeed[item.id] = String(item.quantityOrdered)
      }
    }
    setTouched(touchedSeed)
    setPending(pendingSeed)
    setCustomDraft(draftSeed)
    setRestoredCount(Object.keys(saved).length)
    setSeededId(order.id)
  }, [selectedOrder?.order.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Save confirmed quantities on every change (packing view only, once seeded).
  useEffect(() => {
    if (!selectedOrder || seededId !== selectedOrder.order.id) return
    const { order, items } = selectedOrder
    const confirmedHere = items.some(i => i.status !== 'packed' && i.status !== 'out_of_stock' && i.id in touched)
    setPackStore(confirmedHere
      ? savePackProgress(packKey, order.id, buildProgress(order, items, touched))
      : clearPackProgress(packKey, order.id))
  }, [touched, seededId])

  const allItemsDone = selectedOrder
    ? selectedOrder.items.every(i => i.status === 'out_of_stock' || i.id in touched)
    : false

  const doneCount  = selectedOrder ? selectedOrder.items.filter(i => i.status === 'out_of_stock' || i.id in touched).length : 0
  const totalCount = selectedOrder ? selectedOrder.items.length : 0

  // ── Grouped article view (article → distinct colors → sizes) ─────────────────
  const articleGroups = useMemo(() => {
    if (!selectedOrder) return []
    // level 1: artNumber
    const artMap = new Map<string, OrderItem[]>()
    for (const item of selectedOrder.items) {
      if (!artMap.has(item.artNumber)) artMap.set(item.artNumber, [])
      artMap.get(item.artNumber)!.push(item)
    }
    return Array.from(artMap.entries()).map(([artNumber, items]) => {
      // level 2: colorNumber (deduplicated)
      const colorMap = new Map<string, OrderItem[]>()
      for (const item of items) {
        const color = item.colorNumber ?? '—'
        if (!colorMap.has(color)) colorMap.set(color, [])
        colorMap.get(color)!.push(item)
      }
      const colorGroups = Array.from(colorMap.entries()).map(([color, colorItems]) => ({
        color,
        items: colorItems,
      }))
      return { artNumber, colorGroups }
    })
  }, [selectedOrder])

  // active color tab per article: artNumber → color string
  const [activeColorTab, setActiveColorTab] = useState<Record<string, string>>({})

  // whenever selectedOrder changes, reset color tabs to first color of each article
  useEffect(() => {
    if (!selectedOrder) { setActiveColorTab({}); return }
    const init: Record<string, string> = {}
    for (const { artNumber, colorGroups } of articleGroups) {
      init[artNumber] = colorGroups[0].color
    }
    setActiveColorTab(init)
  }, [selectedOrder?.order.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Order detail view ────────────────────────────────────────────────────────
  if (selectedOrder) {
    const totalPairs = selectedOrder.items.reduce((s, i) => s + i.quantityOrdered, 0)
    return (
      <div className="min-h-screen bg-background">
        {/* Sticky top bar */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-3 sm:px-4 py-2.5">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl border border-border bg-card hover:bg-muted transition-colors"
                aria-label="Back"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{selectedOrder.order.shopkeeperName}</p>
                <p className="text-[11px] text-muted-foreground">
                  <span className="font-mono" data-no-translate>{selectedOrder.order.orderNumber}</span>
                  {` · ${totalPairs} pairs`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusPill status={selectedOrder.order.status} />
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <ProgressBar done={doneCount} total={totalCount} />
              <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">{`${doneCount}/${totalCount} sizes`}</span>
            </div>
          </div>
        </div>

        <div className="max-w-2xl mx-auto px-3 sm:px-4 py-3 sm:py-4 pb-44 md:pb-28">

          {restoredCount > 0 && (
            <p role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
              <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582M20 20v-5h-.581M4.582 9A8 8 0 0120 15M19.418 15A8 8 0 014 9" /></svg>
              {`Your earlier packing was kept: ${restoredCount} sizes already confirmed`}
            </p>
          )}

          {/* ── Packing view ── */}
          <div className="space-y-3">
            {articleGroups.map(({ artNumber, colorGroups }) => {
              const allItems = colorGroups.flatMap(cg => cg.items)
              const allDone  = allItems.every(i => i.status === 'out_of_stock' || i.id in touched)
              const activeColor = activeColorTab[artNumber] ?? colorGroups[0].color
              const activeColorGroup = colorGroups.find(cg => cg.color === activeColor) ?? colorGroups[0]

              // Confirm all pending/draft items in this article at once — local only, no DB call
              function confirmArticle() {
                const allColorItems = colorGroups.flatMap(cg => cg.items)
                const newTouched = { ...touched }
                const newPending = { ...pending }
                const newDraft   = { ...customDraft }
                for (const item of allColorItems) {
                  if (item.id in newTouched) continue
                  const draftVal = newDraft[item.id] !== undefined && newDraft[item.id] !== ''
                    ? parseInt(newDraft[item.id]!)
                    : NaN
                  const qty = !isNaN(draftVal) && draftVal >= 0 ? draftVal : newPending[item.id]
                  if (qty === undefined || qty === null) continue
                  newTouched[item.id] = qty as number
                  delete newPending[item.id]
                  delete newDraft[item.id]
                }
                setTouched(newTouched)
                setPending(newPending)
                setCustomDraft(newDraft)
              }

              // Article confirm is enabled when any unconfirmed item has a staged/draft value
              const artHasSelection = allItems
                .filter(i => !(i.id in touched))
                .some(i => pending[i.id] !== undefined || (customDraft[i.id] !== undefined && customDraft[i.id] !== ''))

              return (
                <div
                  key={artNumber}
                  className={`rounded-xl border bg-card transition-colors ${
                    allDone ? 'border-green-300 dark:border-green-800' : 'border-border'
                  }`}
                >
                  {/* Article header row */}
                  <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                    <div className={`shrink-0 w-2 h-2 rounded-full ${allDone ? 'bg-green-500' : 'bg-border'}`} />
                    <p className="min-w-0 flex-1 truncate text-sm font-bold font-mono text-foreground">
                      {artNumber}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">
                        {`(${allItems.reduce((s, i) => s + i.quantityOrdered, 0)} pairs)`}
                      </span>
                    </p>
                    {/* Confirm (pending) or Edit (all done) */}
                    {allDone ? (
                      <button
                        type="button"
                        onClick={() => {
                          const artItems = colorGroups.flatMap(cg => cg.items)
                          // Re-seed pending with the previously confirmed values so chips stay selected
                          setPending(prev => {
                            const n = { ...prev }
                            artItems.forEach(i => {
                              if (i.id in touched) {
                                const v = touched[i.id]
                                if (v > 0 && v <= 5) n[i.id] = v
                                else if (v > 5) setCustomDraft(d => ({ ...d, [i.id]: String(v) }))
                              }
                            })
                            return n
                          })
                          // Remove from touched so chips reappear
                          setTouched(prev => {
                            const n = { ...prev }
                            artItems.forEach(i => delete n[i.id])
                            return n
                          })
                        }}
                        className="shrink-0 h-9 rounded-lg bg-amber-500 hover:bg-amber-600 text-white px-4 text-xs font-semibold transition-colors shadow-sm"
                      >
                        Edit
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={confirmArticle}
                        disabled={isPending || !artHasSelection}
                        className="shrink-0 h-9 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                      >
                        {isPending ? '…' : 'Confirm'}
                      </button>
                    )}
                  </div>

                  {/* Color tabs — scroll sideways when there are many */}
                  {colorGroups.length > 0 && (
                    <div className="flex gap-1.5 overflow-x-auto px-3 pb-2.5 [scrollbar-width:none]">
                      {colorGroups.map(cg => {
                        const cgTotal   = cg.items.reduce((s, i) => s + i.quantityOrdered, 0)
                        const cgAllDone = cg.items.every(i => i.status === 'out_of_stock' || i.id in touched)
                        const isActive  = cg.color === activeColor
                        return (
                          <button
                            key={cg.color}
                            type="button"
                            aria-pressed={isActive}
                            onClick={() => setActiveColorTab(prev => ({ ...prev, [artNumber]: cg.color }))}
                            className={`shrink-0 h-8 rounded-lg border px-3 text-xs font-semibold transition-colors ${
                              isActive
                                ? 'bg-foreground text-background border-foreground'
                                : cgAllDone
                                  ? 'border-green-300 dark:border-green-700 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20'
                                  : 'border-border text-muted-foreground bg-background hover:border-foreground hover:text-foreground'
                            }`}
                          >
                            {cgAllDone && !isActive ? '✓ ' : ''}{cg.color} <span className="opacity-60 font-normal">({cgTotal})</span>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {/* Active color — list all size rows */}
                  <div className="border-t border-border divide-y divide-border">
                    {activeColorGroup.items.map(item => {
                      const isOOS     = (item.status as OrderItemStatus) === 'out_of_stock'
                      const isDone    = isOOS || item.id in touched
                      const chips     = [1, 2, 3, 4, 5]
                      const staged    = pending[item.id]
                      const confirmed = touched[item.id]
                      const selected  = staged

                      function stageQty(qty: number) {
                        setPending(prev => ({ ...prev, [item.id]: prev[item.id] === qty ? undefined : qty }))
                        setCustomDraft(prev => { const n = { ...prev }; delete n[item.id]; return n })
                      }

                      function confirmQty() {
                        const draftVal = customDraft[item.id] !== undefined && customDraft[item.id] !== ''
                          ? parseInt(customDraft[item.id]!)
                          : NaN
                        const qty = !isNaN(draftVal) && draftVal >= 0 ? draftVal : staged
                        if (qty === undefined || qty === null) return
                        setTouched(prev => ({ ...prev, [item.id]: qty as number }))
                        setPending(prev => { const n = { ...prev }; delete n[item.id]; return n })
                        setCustomDraft(prev => { const n = { ...prev }; delete n[item.id]; return n })
                      }

                      return (
                        <div key={item.id} className="px-3 pt-2.5 pb-3">
                          {/* Size / ordered row */}
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-foreground">
                              {item.sizeNumber ? `Size ${item.sizeNumber}` : activeColorGroup.color}
                              {item.artCode ? <span className="ml-1 text-[10px] font-normal text-muted-foreground" data-no-translate>{item.artCode}</span> : null}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              Ordered: <span className="font-semibold text-foreground tabular-nums">{item.quantityOrdered}</span>
                            </span>
                          </div>

                          {/* Packed qty / action */}
                          {isDone ? (
                            confirmed === 0 || isOOS ? (
                              <div className="flex items-center gap-1 text-xs font-medium text-red-500">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                Out of stock
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><polyline points="20 6 9 17 4 12"/></svg>
                                {`${confirmed} packed`}
                              </div>
                            )
                          ) : (
                            // 0 · 1–5 · other: seven equal thumb-sized boxes across the card
                            <div className="grid grid-cols-7 gap-1.5">
                              <button
                                type="button"
                                aria-label="0 (out of stock)"
                                aria-pressed={selected === 0}
                                onClick={() => stageQty(0)}
                                disabled={isPending}
                                className={`h-10 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-40 ${
                                  selected === 0
                                    ? 'border-red-400 bg-red-400 text-white shadow-sm'
                                    : 'border-red-200 dark:border-red-800 bg-background text-red-500 hover:border-red-400 hover:bg-red-50 dark:hover:bg-red-950/20'
                                }`}
                              >
                                0
                              </button>
                              {chips.map(n => (
                                <button
                                  key={n}
                                  type="button"
                                  aria-pressed={selected === n}
                                  onClick={() => stageQty(n)}
                                  disabled={isPending}
                                  className={`h-10 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-40 ${
                                    selected === n
                                      ? 'border-orange-400 bg-orange-400 text-white shadow-sm'
                                      : 'border-border bg-background text-foreground hover:border-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950/20'
                                  }`}
                                >
                                  {n}
                                </button>
                              ))}
                              <input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                placeholder="…"
                                aria-label={`Other quantity for size ${item.sizeNumber ?? ''}`.trim()}
                                value={customDraft[item.id] ?? ''}
                                onChange={e => {
                                  setCustomDraft(prev => ({ ...prev, [item.id]: e.target.value }))
                                  setPending(prev => { const n = { ...prev }; delete n[item.id]; return n })
                                }}
                                onKeyDown={e => { if (e.key === 'Enter') confirmQty() }}
                                disabled={isPending}
                                className="h-10 w-full min-w-0 rounded-lg border border-border bg-background px-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-orange-400 placeholder:text-muted-foreground disabled:opacity-40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Sticky bottom CTA, above the phone's bottom menu */}
        <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 bg-background/95 backdrop-blur border-t border-border px-3 sm:px-4 py-2.5 md:bottom-0 md:pb-[calc(0.625rem+env(safe-area-inset-bottom))]">
            <div className="max-w-2xl mx-auto space-y-2">
              {packError && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">{packError}</p>
              )}
              <button
                type="button"
                onClick={handleMarkPacked}
                disabled={!allItemsDone || isPending}
                className={`w-full h-12 rounded-xl text-sm font-semibold transition-colors shadow-sm ${
                  allItemsDone
                    ? 'bg-purple-600 hover:bg-purple-700 text-white'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                }`}
              >
                {isPending ? 'Saving…' : allItemsDone ? '✓ Pack Order' : `Confirm all items first (${doneCount}/${totalCount} done)`}
              </button>
            </div>
          </div>
      </div>
    )
  }

  // ── Unassign handler ─────────────────────────────────────────────────────────
  function doUnassign(orderId: number) {
    setClaimError(null)
    setUnassigningId(orderId)
    startTransition(async () => {
      try {
        const result = await unassignOrder(orderId)
        // Released: it goes back to the salesman / admin to assign; whoever gets it next starts fresh.
        setQueue(prev => prev.filter(o => o.id !== orderId))
        setPackStore(clearPackProgress(packKey, orderId))
        onPickerChange?.(result.orderId, null)
      } catch (err) {
        setClaimError(err instanceof Error ? err.message : 'Failed to release order')
      } finally {
        setUnassigningId(null)
      }
    })
  }

  // ── Queue view ───────────────────────────────────────────────────────────────
  const displayList = myOrders

  return (
    <div className={embedded ? '' : 'min-h-screen bg-background'}>
      <div className={embedded ? '' : 'max-w-2xl mx-auto px-3 sm:px-4 py-4 sm:py-6'}>

        {/* Header */}
        {!embedded && (
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">Packing Queue</h1>
              <p className="text-xs text-muted-foreground mt-0.5">Orders awaiting packing</p>
            </div>
            <PageNav />
          </div>
        )}

        {/* My orders only (owner, 23 Nov 2026) */}
        <div className="grid grid-cols-2 gap-2 sm:gap-3 mb-3">
          <StatTile label="My Orders" value={counts.mine} color="text-blue-600 dark:text-blue-400" />
          <StatTile label="Pairs to pack" value={counts.toPack} color="text-purple-600 dark:text-purple-400" hint="Pairs still to check in your orders" />
        </div>

        {/* Error banner */}
        {claimError && (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-400">
            <span>{claimError}</span>
            <button type="button" aria-label="Close" onClick={() => setClaimError(null)} className="shrink-0 text-red-400 hover:text-red-600">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}

        {/* Order list */}
        <div ref={queueListRef} className="space-y-2">
          {displayList.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 opacity-40">
                <path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><polyline points="16 3 12 7 8 3"/>
              </svg>
              <p className="text-sm">No orders assigned to you yet</p>
              <p className="text-xs">The salesman or admin assigns orders to you.</p>
            </div>
          )}

          {displayList.map(order => {
            const isLoading     = loadingId === order.id
            const isUnassigning = unassigningId === order.id
            const checked       = checkedPairs(order)
            const started       = checked > 0

            return (
              <div
                key={order.id}
                data-list-row
                className={`rounded-xl border border-blue-200 bg-card transition-all dark:border-blue-900 ${isLoading ? 'opacity-60' : ''}`}
              >
                <div className="flex items-stretch">
                  {/* The order itself opens it; the action button sits beside it (no button inside a button). */}
                  <button
                    type="button"
                    data-row-open
                    onClick={() => !isLoading && openOrder(order.id)}
                    disabled={isLoading}
                    className="min-w-0 flex-1 px-3.5 py-3 text-left rounded-l-xl hover:bg-muted/30 active:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <p className="truncate text-sm font-semibold text-foreground">{order.shopkeeperName}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      <span className="font-mono" data-no-translate>{order.orderNumber}</span>
                      {` · ${fmt(order.orderedAt)}`}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <ProgressBar done={checked} total={order.totalPairs} />
                      <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
                        {`${checked}/${order.totalPairs} pairs`}
                      </span>
                    </div>
                    {isLoading && <p className="mt-1 text-[11px] text-muted-foreground">Loading…</p>}
                  </button>
                  <div className="flex shrink-0 flex-col items-end justify-center gap-1.5 py-3 pr-3">
                        <button
                          type="button"
                          onClick={() => openOrder(order.id)}
                          disabled={isLoading}
                          className="h-9 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3.5 text-xs font-semibold transition-colors disabled:opacity-40"
                        >
                          {started ? 'Continue →' : 'Pack →'}
                        </button>
                        <button
                          type="button"
                          onClick={() => doUnassign(order.id)}
                          disabled={isPending || isUnassigning}
                          className="h-8 rounded-lg px-2 text-[11px] font-medium text-muted-foreground hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {isUnassigning ? 'Releasing…' : 'Release'}
                        </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
