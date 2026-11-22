'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { PageHeader } from '@/app/orders/_components/shared'
import { PageNav } from '@/components/page-nav'
import { useHashTab } from '@/lib/use-hash-tab'
import { useUrlFilters } from '@/lib/use-url-filters'
import { useListKeys } from '@/lib/shortcuts/list'
import { useTabKeys } from '@/lib/shortcuts/tabs'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OverviewTab } from './overview-tab'
import { FilterBar, FiltersButton, activeFilterCount, type ColumnFilterDef, type FilterValues } from '@/components/column-filters'
import { SEGMENTS } from '@/lib/catalog/assortments'

// Inventory → Stock filters (applied in the database query; the list loads 50 at a time).
const STOCK_FILTERS: ColumnFilterDef<StockVariant>[] = [
  { key: 'name', label: 'Article', kind: 'text', get: v => v.artName },
  { key: 'code', label: 'Article code', kind: 'text', get: v => v.artCode },
  { key: 'color', label: 'Colour', kind: 'text', get: v => v.color },
  { key: 'colorCode', label: 'Colour code', kind: 'text', get: v => v.colorCode },
  { key: 'segment', label: 'Segment', kind: 'select', options: SEGMENTS, get: () => '' },
  { key: 'division', label: 'Division', kind: 'select', options: DIVISIONS, get: v => v.division },
]
import { DIVISIONS } from '@/lib/catalog/assortments'
import {
  correctStockAction, getMovements, getStockPage, getStockSummary, getUnscannedDispatch, getVariantDetail, undoCorrectionAction,
} from '@/app/actions/inventory'
import type { Movement, MovementKind, StockSummary, StockVariant, UnscannedDispatch, VariantDetail } from '@/lib/inventory/stock-queries'

interface Props {
  initialSummary: StockSummary
  initialStock: { rows: StockVariant[]; total: number }
  staff: { id: string; name: string }[]
  canAdjust: boolean
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const num = new Intl.NumberFormat('en-IN')
const when = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
const inputCls = 'rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring'

const KIND_LABEL: Record<MovementKind, string> = { scan: 'Scan', received: 'Carton received', billed: 'Billed', undo: 'Undo', correction: 'Correction', other: 'Other' }
const KIND_STYLE: Record<MovementKind, string> = {
  scan: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  received: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
  billed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  undo: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  correction: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  other: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
}

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Plain-http LAN testing has no crypto.randomUUID.
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

/** Inventory: stock on hand per article / colour / size, its value at MRP, and the movement history. */
/** Sections (sidebar sub-items on computers, tab row on phones). */
const INVENTORY_TABS = ['overview', 'stock', 'movements', 'dispatch'] as const
const INVENTORY_LABEL: Record<string, string> = { overview: 'Overview', stock: 'Stock', movements: 'Movements', dispatch: 'Unscanned dispatch' }

export function InventoryPage({ initialSummary, initialStock, staff, canAdjust }: Props) {
  const [summary, setSummary] = useState(initialSummary)
  const [tab, setTab] = useHashTab(INVENTORY_TABS, 'overview')
  useTabKeys(INVENTORY_TABS.map((t) => ({ value: t, label: INVENTORY_LABEL[t] })), setTab, { group: 'Inventory tabs' })
  const [openId, setOpenId] = useState<number | null>(null)
  const [stockPatch, setStockPatch] = useState<StockVariant | null>(null)

  const refreshSummary = useCallback(() => { getStockSummary().then(setSummary).catch(() => {}) }, [])

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-2">
          <PageHeader title={`Inventory · ${INVENTORY_LABEL[tab] ?? ''}`} subtitle="Stock health, what sells, and every movement" />
          <PageNav />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Tile label="Pairs in stock" value={num.format(summary.pairs)} />
          <Tile label="Value at MRP" value={inr.format(summary.value)} hint={summary.unvaluedPairs ? `${num.format(summary.unvaluedPairs)} pairs have no MRP` : undefined} />
          <Tile label="Articles in stock" value={num.format(summary.variantsInStock)} hint={`${num.format(summary.sizesInStock)} sizes`} />
          <Tile label="Movements today" value={num.format(summary.movementsToday)} />
        </div>
        {(summary.negativeSizes > 0 || summary.waitingScans > 0) && (
          <div className="mb-4 space-y-1.5 text-xs">
            {summary.negativeSizes > 0 && (
              <p className="rounded-lg px-3 py-2 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300">
                {summary.negativeSizes} size{summary.negativeSizes === 1 ? '' : 's'} below zero — check and correct them.
              </p>
            )}
            {summary.waitingScans > 0 && (
              <p className="rounded-lg px-3 py-2 bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                {num.format(summary.waitingPairs)} scanned pairs ({summary.waitingScans} scans) are waiting for their article to be added — not counted above.{' '}
                <a href="/master" className="underline">Master → Articles → Missing articles</a>
              </p>
            )}
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="w-full">
          <TabsList className="flex w-full mb-4 md:hidden">
            <TabsTrigger value="overview" className="text-xs sm:text-sm">Overview</TabsTrigger>
            <TabsTrigger value="stock" className="text-xs sm:text-sm">Stock</TabsTrigger>
            <TabsTrigger value="movements" className="text-xs sm:text-sm">Movements</TabsTrigger>
            <TabsTrigger value="dispatch" className="text-xs sm:text-sm">Unscanned dispatch ({num.format(summary.unscannedDispatch)})</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            {tab === 'overview' && <OverviewTab onOpen={setOpenId} />}
          </TabsContent>
          <TabsContent value="stock">
            <StockTab initial={initialStock} onOpen={setOpenId} patch={stockPatch} />
          </TabsContent>
          <TabsContent value="movements">
            {tab === 'movements' && <MovementsTab staff={staff} onOpen={setOpenId} />}
          </TabsContent>
          <TabsContent value="dispatch">
            {tab === 'dispatch' && <DispatchTab />}
          </TabsContent>
        </Tabs>
      </div>

      {openId != null && (
        <VariantDialog
          articleId={openId}
          canAdjust={canAdjust}
          onClose={() => setOpenId(null)}
          onChanged={(v) => { setStockPatch(v); refreshSummary() }}
        />
      )}
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
      <p className="text-xl sm:text-2xl font-bold mt-1 text-foreground tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  )
}

function SizeChips({ sizes }: { sizes: StockVariant['sizes'] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {sizes.map((s) => (
        <span key={s.skuId} className={`inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums ${
          s.pairs < 0 ? 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300' : s.pairs === 0 ? 'border-border text-muted-foreground/60' : 'border-border text-foreground'}`}>
          <span className="text-muted-foreground">{s.size}</span><span className="font-semibold">{s.pairs}</span>
        </span>
      ))}
    </div>
  )
}

// ── Stock ──────────────────────────────────────────────────────────────

function StockTab({ initial, onOpen, patch }: { initial: { rows: StockVariant[]; total: number }; onOpen: (id: number) => void; patch: StockVariant | null }) {
  const [rows, setRows] = useState(initial.rows)
  const [total, setTotal] = useState(initial.total)
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState<FilterValues>({})
  const [showEmpty, setShowEmpty] = useState(false)
  const [error, setError] = useState('')
  const [busy, start] = useTransition()
  // Opened from Ctrl+K "# " search (/inventory?f.code=…#stock): show the article even with no stock.
  useUrlFilters(['code', 'name'], (v) => { setFilters((f) => ({ ...f, ...v })); setShowEmpty(true) })
  const listRef = useRef<HTMLDivElement>(null)
  useListKeys(listRef, { label: 'Stock list' })
  const fq = useDebounced(JSON.stringify(filters))
  const query = (page: number) => {
    const v = JSON.parse(fq) as FilterValues
    return { name: v.name, code: v.code, color: v.color, colorCode: v.colorCode, segment: v.segment || undefined, division: v.division || undefined, inStockOnly: !showEmpty, page }
  }
  const first = useRef(true)
  const req = useRef(0)

  // Re-query when a filter changes (the first render already has page 0 from the server).
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const id = ++req.current
    start(async () => {
      try {
        const r = await getStockPage(query(0))
        if (id !== req.current) return
        setRows(r.rows); setTotal(r.total); setPage(0); setError('')
      } catch (e) { if (id === req.current) setError(errText(e, 'Could not load stock.')) }
    })
  }, [fq, showEmpty])

  // A correction in the detail dialog: replace that row in place.
  useEffect(() => {
    if (patch) setRows((rs) => rs.map((r) => (r.articleId === patch.articleId ? patch : r)))
  }, [patch])

  function loadMore() {
    const next = page + 1
    const id = ++req.current
    start(async () => {
      try {
        const r = await getStockPage(query(next))
        if (id !== req.current) return
        setRows((rs) => [...rs, ...r.rows]); setTotal(r.total); setPage(next)
      } catch (e) { setError(errText(e, 'Could not load more.')) }
    })
  }

  return (
    <div ref={listRef}>
      <FilterBar className="mb-2" defs={STOCK_FILTERS} values={filters} onChange={setFilters} />
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <FiltersButton className="sm:hidden" defs={STOCK_FILTERS} values={filters} onChange={setFilters} />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} className="accent-foreground" />
          Show articles with no stock
        </label>
      </div>
      <p className="text-xs text-muted-foreground mb-2">
        {busy && rows.length === 0 ? 'Loading…' : `${num.format(total)} article${total === 1 ? '' : 's'}${busy ? ' · updating…' : ''}`}
      </p>
      {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!busy && rows.length === 0 && (
        <p className="text-center py-10 text-sm text-muted-foreground">
          {activeFilterCount(filters) ? 'Nothing matches.' : showEmpty ? 'No articles.' : 'No stock yet. Scanned boxes appear here.'}
        </p>
      )}

      <div className={`rounded-xl border border-border divide-y divide-border overflow-hidden ${rows.length ? '' : 'hidden'} ${busy ? 'opacity-70' : ''}`}>
        {rows.map((v) => (
          <button key={v.articleId} data-list-row onClick={() => onOpen(v.articleId)} className="w-full text-left px-3 sm:px-4 py-3 hover:bg-muted/40 transition-colors flex gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {v.artName} <span className="font-normal text-muted-foreground">· {v.color}</span>
                {!v.active && <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground align-middle">retired</span>}
              </p>
              <p className="text-[11px] text-muted-foreground font-mono mb-1.5">{v.artCode} {v.colorCode}{v.division ? <span className="font-sans"> · {v.division}</span> : null}</p>
              <SizeChips sizes={v.sizes} />
            </div>
            <div className="text-right shrink-0">
              <p className={`text-lg font-bold tabular-nums ${v.pairs < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>{num.format(v.pairs)}</p>
              <p className="text-[11px] text-muted-foreground">pairs</p>
              {v.value > 0 && <p className="text-xs text-muted-foreground tabular-nums mt-0.5">{inr.format(v.value)}</p>}
            </div>
          </button>
        ))}
      </div>
      {rows.length < total && (
        <button type="button" data-show-more onClick={loadMore} disabled={busy} className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
          {busy ? 'Loading…' : `Show more (${num.format(total - rows.length)} left)`}
        </button>
      )}
    </div>
  )
}

// ── Movements ──────────────────────────────────────────────────────────

function MovementRow({ m, onOpen, action }: { m: Movement; onOpen?: () => void; action?: React.ReactNode }) {
  const body = (
    <>
      <div className="w-[68px] shrink-0 text-[11px] text-muted-foreground tabular-nums leading-tight pt-0.5">{when.format(new Date(m.at))}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">
          {m.artName} <span className="text-muted-foreground">· {m.color} · size {m.size}</span>
        </p>
        <p className="text-[11px] text-muted-foreground">
          <span className={`rounded-full px-1.5 py-px mr-1.5 text-[10px] font-medium ${KIND_STYLE[m.kind]}`}>{KIND_LABEL[m.kind]}</span>
          {m.userName || '—'}{m.mrp != null ? ` · MRP ₹${m.mrp}` : ''}{m.undone ? ' · undone' : ''}
        </p>
        {m.reason && <p className="text-[11px] text-muted-foreground italic truncate">“{m.reason}”</p>}
      </div>
      <div className={`shrink-0 text-sm font-semibold tabular-nums ${m.quantity > 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>
        {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
      </div>
      {action}
    </>
  )
  return onOpen
    ? <button type="button" data-list-row onClick={onOpen} className="w-full text-left flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted/40">{body}</button>
    : <div className="flex items-start gap-2.5 px-3 py-2.5">{body}</div>
}

function MovementsTab({ staff, onOpen }: { staff: Props['staff']; onOpen: (id: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  useListKeys(listRef, { label: 'Movements list' })
  const [rows, setRows] = useState<Movement[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [kind, setKind] = useState<MovementKind | 'all'>('all')
  const [userId, setUserId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [busy, start] = useTransition()
  const q = useDebounced(search)
  const req = useRef(0)
  const filters = { kind, userId: userId || undefined, from: from || undefined, to: to || undefined, search: q || undefined }

  useEffect(() => {
    const id = ++req.current
    start(async () => {
      try {
        const r = await getMovements({ kind, userId: userId || undefined, from: from || undefined, to: to || undefined, search: q || undefined })
        if (id !== req.current) return
        setRows(r.rows); setHasMore(r.hasMore); setError('')
      } catch (e) { if (id === req.current) setError(errText(e, 'Could not load movements.')) }
    })
  }, [kind, userId, from, to, q])

  function loadMore() {
    const last = rows[rows.length - 1]
    if (!last) return
    const id = ++req.current
    start(async () => {
      try {
        const r = await getMovements({ ...filters, before: last.id })
        if (id !== req.current) return
        setRows((rs) => [...rs, ...r.rows]); setHasMore(r.hasMore)
      } catch (e) { setError(errText(e, 'Could not load more.')) }
    })
  }

  return (
    <div ref={listRef}>
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 mb-3">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Article, code or colour…" aria-label="Search movements" className={`${inputCls} col-span-2 sm:flex-1 sm:min-w-[160px]`} />
        <select value={kind} onChange={(e) => setKind(e.target.value as MovementKind | 'all')} aria-label="Type" className={`${inputCls} text-xs`}>
          <option value="all">All types</option>
          <option value="scan">Scans</option>
          <option value="received">Cartons received</option>
          <option value="billed">Billed</option>
          <option value="undo">Undone (scans, bills, corrections)</option>
          <option value="correction">Corrections</option>
          <option value="other">Other (box from carton, …)</option>
        </select>
        <select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Staff" className={`${inputCls} text-xs`}>
          <option value="">All staff</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} text-xs py-1.5 w-full`} />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputCls} text-xs py-1.5 w-full`} />
        </label>
      </div>
      {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {busy && rows.length === 0 && <p className="text-center py-10 text-sm text-muted-foreground">Loading…</p>}
      {!busy && rows.length === 0 && !error && <p className="text-center py-10 text-sm text-muted-foreground">No movements.</p>}
      <div className={`rounded-xl border border-border divide-y divide-border overflow-hidden ${rows.length ? '' : 'hidden'} ${busy ? 'opacity-70' : ''}`}>
        {rows.map((m) => <MovementRow key={m.id} m={m} onOpen={() => onOpen(m.articleId)} />)}
      </div>
      {hasMore && (
        <button type="button" data-show-more onClick={loadMore} disabled={busy} className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
          {busy ? 'Loading…' : 'Show older'}
        </button>
      )}
    </div>
  )
}

// ── One article: sizes, corrections, history ──────────────────────────

function VariantDialog({ articleId, canAdjust, onClose, onChanged }: { articleId: number; canAdjust: boolean; onClose: () => void; onChanged: (v: StockVariant) => void }) {
  const [detail, setDetail] = useState<VariantDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, start] = useTransition()
  const [skuId, setSkuId] = useState<number | null>(null)
  const [dir, setDir] = useState<'add' | 'remove'>('add')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [requestId, setRequestId] = useState(uuid)
  const [undoing, setUndoing] = useState<number | null>(null)
  const [undoReason, setUndoReason] = useState('')

  useEffect(() => {
    let live = true
    getVariantDetail(articleId).then((d) => { if (live) setDetail(d) }).catch((e) => { if (live) setError(errText(e, 'Could not load.')) })
    return () => { live = false }
  }, [articleId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const v = detail?.variant
  const selected = v?.sizes.find((s) => s.skuId === skuId)
  const amount = Number(qty)
  const valid = !!selected && Number.isInteger(amount) && amount > 0 && reason.trim().length >= 3 && (dir === 'add' || amount <= selected.pairs)

  function applied(d: VariantDetail) {
    setDetail(d)
    if (d.variant) onChanged(d.variant)
  }

  function saveCorrection() {
    if (!selected || !valid) return
    setError('')
    start(async () => {
      try {
        applied(await correctStockAction({ articleId, skuId: selected.skuId, delta: dir === 'add' ? amount : -amount, reason: reason.trim(), requestId }))
        setQty(''); setReason(''); setSkuId(null); setRequestId(uuid())
      } catch (e) { setError(errText(e, 'Could not save the correction.')) }
    })
  }

  function undo(movementId: number) {
    setError('')
    start(async () => {
      try {
        applied(await undoCorrectionAction({ articleId, movementId, reason: undoReason.trim() }))
        setUndoing(null); setUndoReason('')
      } catch (e) { setError(errText(e, 'Could not undo.')) }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm sm:px-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={v ? `${v.artName} ${v.color}` : 'Article stock'}
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-border bg-background shadow-2xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
          {v ? (
            <div className="min-w-0">
              <p className="font-semibold text-foreground truncate">{v.artName} · {v.color}</p>
              <p className="text-xs text-muted-foreground font-mono">{v.artCode} {v.colorCode}{v.division ? <span className="font-sans"> · {v.division}</span> : null}{!v.active ? <span className="font-sans"> · retired</span> : null}</p>
            </div>
          ) : <p className="text-sm text-muted-foreground">{error || 'Loading…'}</p>}
          <button onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted">✕</button>
        </div>

        {v && (
          <div className="overflow-y-auto p-5 space-y-5">
            <div className="flex items-baseline gap-4">
              <p><span className="text-2xl font-bold tabular-nums">{num.format(v.pairs)}</span> <span className="text-sm text-muted-foreground">pairs</span></p>
              {v.value > 0 && <p className="text-sm text-muted-foreground tabular-nums">{inr.format(v.value)} at MRP</p>}
              {v.unvaluedPairs > 0 && <p className="text-xs text-muted-foreground">{v.unvaluedPairs} without MRP</p>}
            </div>

            <div>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                Pairs per size{canAdjust ? ' — tap a size to correct it' : ''}
              </p>
              <div className="grid grid-cols-5 sm:grid-cols-7 gap-1.5">
                {v.sizes.map((s) => {
                  const on = s.skuId === skuId
                  return (
                    <button key={s.skuId} disabled={!canAdjust || busy} onClick={() => setSkuId(on ? null : s.skuId)}
                      className={`rounded-lg border px-1 py-1.5 text-center transition-colors ${on ? 'border-foreground bg-muted' : 'border-border'} ${canAdjust ? 'hover:bg-muted' : 'cursor-default'}`}>
                      <span className="block text-[10px] text-muted-foreground">{s.size}</span>
                      <span className={`text-sm font-semibold tabular-nums ${s.pairs < 0 ? 'text-red-600 dark:text-red-400' : s.pairs === 0 ? 'text-muted-foreground/60' : ''}`}>{s.pairs}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {canAdjust && selected && (
              <div className="rounded-xl border border-border p-3 space-y-2.5">
                <p className="text-sm font-medium">Correct size {selected.size} <span className="text-muted-foreground font-normal">(now {selected.pairs})</span></p>
                <div className="flex gap-2">
                  <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
                    {(['add', 'remove'] as const).map((d) => (
                      <button key={d} onClick={() => setDir(d)} className={`px-3 py-2 ${dir === d ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>{d === 'add' ? '+ Add' : '− Remove'}</button>
                    ))}
                  </div>
                  <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} placeholder="Pairs" aria-label="Pairs" className={`${inputCls} w-24`} />
                </div>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required), e.g. counted shelf, damaged" aria-label="Reason" className={`${inputCls} w-full`} />
                {dir === 'remove' && amount > selected.pairs && <p className="text-xs text-red-600 dark:text-red-400">Only {selected.pairs} in stock for this size.</p>}
                <button onClick={saveCorrection} disabled={!valid || busy} className="w-full rounded-lg bg-foreground text-background px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                  {busy ? 'Saving…' : qty ? `${dir === 'add' ? 'Add' : 'Remove'} ${amount} pair${amount === 1 ? '' : 's'} — size ${selected.size} becomes ${selected.pairs + (dir === 'add' ? amount : -amount)}` : 'Enter pairs'}
                </button>
              </div>
            )}

            {error && <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{error}</p>}

            <div>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Latest movements</p>
              {detail.movements.length === 0 && <p className="text-sm text-muted-foreground">No movements yet.</p>}
              <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
                {detail.movements.map((m) => (
                  <div key={m.id}>
                    <MovementRow m={m} action={canAdjust && m.canUndo ? (
                      <button onClick={() => { setUndoing(undoing === m.id ? null : m.id); setUndoReason('') }} className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-muted">Undo</button>
                    ) : null} />
                    {undoing === m.id && (
                      <div className="flex gap-2 px-3 pb-2.5">
                        <input value={undoReason} onChange={(e) => setUndoReason(e.target.value)} placeholder="Why undo?" aria-label="Reason for undo" className={`${inputCls} flex-1 py-1.5`} />
                        <button onClick={() => undo(m.id)} disabled={busy || undoReason.trim().length < 3} className="rounded-lg bg-foreground text-background px-3 text-xs font-semibold disabled:opacity-50">Undo</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {detail.hasMore && <p className="mt-1.5 text-[11px] text-muted-foreground">Older movements: Movements tab, search “{v.artCode}”.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Unscanned dispatch ─────────────────────────────────────────────────

/** Billed boxes the warehouse never scanned into stock (and with no hand-counted stock to take from). */
function DispatchTab() {
  const [rows, setRows] = useState<UnscannedDispatch[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [busy, start] = useTransition()

  useEffect(() => {
    start(async () => {
      try { const r = await getUnscannedDispatch(); setRows(r.rows); setHasMore(r.hasMore) }
      catch (e) { setError(errText(e, 'Could not load.')) }
    })
  }, [])

  function loadMore() {
    const last = rows[rows.length - 1]
    if (!last) return
    start(async () => {
      try { const r = await getUnscannedDispatch(last.id); setRows((rs) => [...rs, ...r.rows]); setHasMore(r.hasMore) }
      catch (e) { setError(errText(e, 'Could not load more.')) }
    })
  }

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-3">
        Boxes billed that were never scanned into stock, so stock was not reduced. Check whether they should have been counted.
      </p>
      {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {busy && rows.length === 0 && <p className="text-center py-10 text-sm text-muted-foreground">Loading…</p>}
      {!busy && rows.length === 0 && !error && <p className="text-center py-10 text-sm text-muted-foreground">None. Every billed box came out of stock.</p>}
      <div className={`rounded-xl border border-border divide-y divide-border overflow-hidden ${rows.length ? '' : 'hidden'}`}>
        {rows.map((d) => (
          <div key={d.id} className="flex items-start gap-2.5 px-3 py-2.5">
            <div className="w-[68px] shrink-0 text-[11px] text-muted-foreground tabular-nums leading-tight pt-0.5">{when.format(new Date(d.at))}</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground truncate">
                {d.artName ?? d.articleCode} <span className="text-muted-foreground">· {d.color ?? d.colourCode} · size {d.size || '?'}</span>
              </p>
              <p className="text-[11px] text-muted-foreground">
                Bill {d.orderNumber} · {d.userName || '—'}{d.mrp != null ? ` · MRP ₹${d.mrp}` : ''}{d.artName ? '' : ' · article not in master'}
              </p>
            </div>
          </div>
        ))}
      </div>
      {hasMore && (
        <button type="button" data-show-more onClick={loadMore} disabled={busy} className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
          {busy ? 'Loading…' : 'Show older'}
        </button>
      )}
    </div>
  )
}
