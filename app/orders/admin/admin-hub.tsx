'use client'

import { ShopOrdersPanel } from '@/components/orders/shop-orders-panel'
import { useState, useCallback, useEffect, useRef } from 'react'
import { AutoRefreshContext } from '@/lib/use-auto-refresh'
import { useCatalogueCache } from '@/lib/use-catalogue-cache'
import { PageNav } from '@/components/page-nav'
import { AdminDashboard } from './admin-dashboard'
import { SalesmanDashboard } from '../salesman/salesman-dashboard'
import { PickerDashboard } from '../picker/picker-dashboard'
import { BillerDashboard } from '../biller/biller-dashboard'
import { DispatcherDashboard } from '../dispatcher/dispatcher-dashboard'
import { ProcurementSummary } from './procurement-summary'
import type { ProcurementRow } from '@/app/actions/orders'
import type { CatalogueData } from '@/app/actions/catalogue'
import type { BillingVendor } from '@/components/billing-scanner-page'
import type { OrderSet } from '@/app/actions/sets'
import { tablistKeyDown, useTabKeys } from '@/lib/shortcuts/tabs'

// ── Prop types (mirroring what each dashboard expects) ────────────────────────

interface OrderRow {
  id: number
  orderNumber: string
  shopkeeperName: string
  status: string
  orderedAt: Date
  updatedAt: Date
  salesmanId: string | null
  pickerId: string | null
  dispatcherId: string | null
}

interface SalesmanOrder {
  id: number
  orderNumber: string
  shopkeeperName: string
  status: string
  notes: string | null
  orderedAt: Date
  updatedAt: Date
}

interface QueueItem {
  totalPairs: number
  packedPairs: number
  id: number
  orderNumber: string
  shopkeeperName: string
  status: string
  orderedAt: Date
  pickerId: string | null
}

interface DispatchOrder {
  id: number
  orderNumber: string
  shopkeeperName: string
  shopkeeperPhone: string | null
  shopkeeperAddress: string | null
  status: string
  packedAt: Date | null
  totalBundles: number | null
  dispatcherId: string | null
}

interface Picker {
  id: string
  name: string | null
  email: string
  role: string | null
  createdAt: Date
}

interface Props {
  adminName: string
  adminId: string
  isAccountant?: boolean
  userRoles?: string[]
  /** Overview tab, prepared by the page. */
  overview: { stats: { total: number; pending: number; packed: number; dispatched: number; delivered: number; cancelled: number }; allOrders: OrderRow[]; pickers: Picker[] }
  /** Time the page was rendered on the server: a newer one means a save re-ran it, so the open tab refetches. */
  renderedAt: number
}

/** One tab's data as GET /api/orders/admin-tab returns it (Orders speed, 22 Nov 2026). */
type TabData = {
  overview: Props['overview']
  salesman: { salesmanOrders: SalesmanOrder[]; sets: OrderSet[]; pickers_list: { id: string; name: string | null }[] }
  picker: { pickerQueue: QueueItem[] }
  biller: { billerOrders: any[]; billingVendors: BillingVendor[] }
  dispatcher: { dispatchOrders: DispatchOrder[] }
  procurement: { procurementRows: ProcurementRow[] }
}
type TabName = keyof TabData

// JSON has no dates: turn ISO timestamps back into Date (the dashboards expect Date, as from the page).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const revive = (_k: string, v: unknown) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v)

const EMPTY_CATALOGUE: CatalogueData = { vendors: [], articles: [] }

/** Reference data only where it is used: the catalogue (browser cache + /api/catalogue) for Salesman and Biller. */
function WithCatalogue({ children }: { children: (c: CatalogueData) => React.ReactNode }) {
  const catalogue = useCatalogueCache(EMPTY_CATALOGUE)
  return <>{children(catalogue)}</>
}

function TabSkeleton() {
  return (
    <div className="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map(i => <div key={i} className="h-20 rounded-xl bg-muted" />)}</div>
      {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-12 rounded-xl bg-muted" />)}
    </div>
  )
}

// ── Grid-based tab bar ────────────────────────────────────────────────────────
// Mobile (<sm): 2-row segment container matching desktop pill style
// Desktop (sm+): single row muted-pill segment control
function gridColsClass(n: number): string {
  if (n <= 3) return `grid-cols-${n}`
  if (n === 4) return 'grid-cols-2'
  return 'grid-cols-3'
}

interface Tab { value: string; label: string; icon?: React.ReactNode }

function GridTabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: Tab[]
  active: string
  onChange: (v: string) => void
}) {
  const mobileGrid = gridColsClass(tabs.length)
  return (
    <>
      {/* Mobile: segmented pill style arranged in grid / 2 rows */}
      <div className="sm:hidden mb-5">
        <div className={`grid ${mobileGrid} w-full items-center justify-center rounded-lg bg-muted p-[3px] gap-1 text-muted-foreground`} role="tablist" aria-label="Orders" onKeyDown={tablistKeyDown}>
          {tabs.map(tab => {
            const isActive = tab.value === active
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onChange(tab.value)}
                className={`inline-flex items-center justify-center whitespace-nowrap rounded-md border border-transparent px-2 py-2 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground/60 hover:text-foreground'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Desktop: single row pill/segment control */}
      <div className="hidden sm:block mb-6">
        <div
          className="grid w-full items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
          role="tablist"
          aria-label="Orders"
          onKeyDown={tablistKeyDown}
        >
          {tabs.map(tab => {
            const isActive = active === tab.value
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onChange(tab.value)}
                className={`inline-flex items-center justify-center whitespace-nowrap rounded-md border border-transparent px-2 py-1.5 text-sm font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground/60 hover:text-foreground'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ── Hub ───────────────────────────────────────────────────────────────────────

export function AdminHub({
  adminName,
  adminId,
  isAccountant = false,
  userRoles = [],
  overview,
  renderedAt,
}: Props) {
  // ── One tab at a time (Orders speed, 22 Nov 2026) ──
  // Each tab's data is kept once loaded (switching back is instant) and refetched in the background
  // whenever the tab is opened again, so it is never older than the last time it was shown.
  const [data, setData] = useState<Partial<TabData>>({ overview })
  const [tabError, setTabError] = useState<Partial<Record<TabName, string>>>({})
  const seq = useRef<Partial<Record<TabName, number>>>({})
  const fetchTab = useCallback(async (tab: TabName) => {
    const n = (seq.current[tab] ?? 0) + 1
    seq.current[tab] = n
    try {
      const res = await fetch(`/api/orders/admin-tab?tab=${tab}`, { cache: 'no-store' })
      const text = await res.text()
      if (seq.current[tab] !== n) return // a newer request for this tab is on its way
      if (!res.ok) throw new Error((() => { try { return JSON.parse(text).error } catch { return '' } })() || `Error ${res.status}`)
      const body = JSON.parse(text, revive) as TabData[typeof tab]
      setData(d => ({ ...d, [tab]: body }))
      setTabError(e => ({ ...e, [tab]: undefined }))
    } catch (e) {
      if (seq.current[tab] === n) setTabError(prev => ({ ...prev, [tab]: e instanceof Error ? e.message : 'Could not load this tab' }))
    }
  }, [])

  // A save that re-ran the page brings new Overview data; the open tab refetches too.
  const firstRender = useRef(true)
  const activeTabRef = useRef('overview')
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    setData(d => ({ ...d, overview }))
    if (activeTabRef.current !== 'overview') void fetchTab(activeTabRef.current as TabName)
  }, [renderedAt, overview, fetchTab])

  const { stats, allOrders, pickers } = data.overview ?? overview

  // Shared picker assignment map — owned here so Overview + Picker tab stay in sync
  const [sharedPickerMap, setSharedPickerMap] = useState<Record<number, string>>(() =>
    Object.fromEntries(allOrders.filter(o => o.pickerId).map(o => [o.id, o.pickerId!]))
  )

  const handlePickerChange = useCallback((orderId: number, pickerId: string | null) => {
    setSharedPickerMap(prev => {
      const next = { ...prev }
      if (pickerId) next[orderId] = pickerId
      else delete next[orderId]
      return next
    })
  }, [])

  // For accountants: show picker/biller/dispatcher tabs only if those roles are explicitly assigned
  const showPicker     = !isAccountant || userRoles.includes('picker')
  const showBiller     = !isAccountant || userRoles.includes('biller')
  const showDispatcher = !isAccountant || userRoles.includes('dispatcher')

  const TABS: Tab[] = [
    { value: 'overview',     label: 'Overview' },
    { value: 'salesman',     label: 'Salesman' },
    ...(showPicker     ? [{ value: 'picker',      label: 'Picker' }]      : []),
    ...(showBiller     ? [{ value: 'biller',      label: 'Biller' }]      : []),
    ...(showDispatcher ? [{ value: 'dispatcher',  label: 'Dispatcher' }]  : []),
    { value: 'procurement',  label: 'Procurement' },
  ]

  const VALID_TABS = TABS.map(t => t.value)
  const [activeTab, setActiveTab] = useState('overview')

  // Tab from the address (#biller); the sidebar changes it without reloading the page.
  useEffect(() => {
    const read = () => {
      const hash = window.location.hash.replace('#', '')
      if (VALID_TABS.includes(hash)) setActiveTab(hash)
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  function handleTabChange(tab: string) {
    setActiveTab(tab)
    window.location.hash = tab
  }
  // Keyboard: Alt+1…9 switch tabs (the biller's own tabs inside use Alt+Shift).
  useTabKeys(TABS, handleTabChange, { group: 'Orders tabs' })

  // Opening a tab loads it (skeleton the first time) or refreshes it in the background. Overview
  // comes with the page, so it is refetched only when opened again later.
  const leftOverview = useRef(false)
  useEffect(() => {
    activeTabRef.current = activeTab
    if (activeTab === 'overview' && !leftOverview.current) return // the page's own copy is fresh
    leftOverview.current = true
    void fetchTab(activeTab as TabName)
  }, [activeTab, fetchTab])

  // Embedded dashboards' refresh (salesman's 30 s auto-refresh) refetches only the open tab.
  const refreshOpenTab = useCallback(() => { void fetchTab(activeTabRef.current as TabName) }, [fetchTab])

  /** The tab's data, or a skeleton / error with retry until it arrives. */
  function tabBody<T extends TabName>(tab: T, render: (d: TabData[T]) => React.ReactNode) {
    const d = data[tab] as TabData[T] | undefined
    if (d) return render(d)
    if (tabError[tab]) {
      return (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          {`Could not load this tab: ${tabError[tab]}`}
          <button type="button" onClick={() => void fetchTab(tab)} className="ml-3 underline">Try again</button>
        </div>
      )
    }
    return <TabSkeleton />
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6">

        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Orders<span className="hidden md:inline"> · {TABS.find(t => t.value === activeTab)?.label}</span>
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isAccountant ? 'View orders & procurement overview' : 'Manage all orders across every role'}
            </p>
          </div>
          <PageNav />
        </div>

        {/* Retailer shop orders waiting for staff (owner, 21 Nov 2026): shown only when there are some. */}
        <ShopOrdersPanel canAct={!isAccountant} />

        {/* Tab bar on phones only; computers use the sidebar's Orders sections (owner, 21 Nov 2026). */}
        <div className="md:hidden"><GridTabBar tabs={TABS} active={activeTab} onChange={handleTabChange} /></div>

        {/* Tab content */}
        {activeTab === 'overview' && (
          <AdminDashboard
            stats={stats}
            orders={allOrders}
            pickers={pickers}
            embedded
            readOnly={isAccountant}
            pickerMapOverride={sharedPickerMap}
            onPickerChange={handlePickerChange}
          />
        )}

        <AutoRefreshContext.Provider value={refreshOpenTab}>
        {activeTab === 'salesman' && tabBody('salesman', d => (
          <WithCatalogue>{catalogue => (
            <SalesmanDashboard orders={d.salesmanOrders} userName={adminName} userId={adminId} embedded catalogue={catalogue} sets={d.sets} pickers={d.pickers_list} />
          )}</WithCatalogue>
        ))}

        {showPicker && activeTab === 'picker' && tabBody('picker', d => (
          <PickerDashboard
            queue={d.pickerQueue}
            currentPickerId={adminId}
            embedded
            onPickerChange={handlePickerChange}
          />
        ))}

        {/* Biller stays mounted once loaded (its scanner keeps its state when another tab is open). */}
        {showBiller && (data.biller || activeTab === 'biller') && (
          <div className={activeTab === 'biller' ? '' : 'hidden'}>
            {tabBody('biller', d => (
              <WithCatalogue>{catalogue => (
                <BillerDashboard orders={d.billerOrders} currentBillerId={adminId} vendors={d.billingVendors} articles={catalogue.articles.map(a => a.artNumber)} embedded />
              )}</WithCatalogue>
            ))}
          </div>
        )}

        {showDispatcher && activeTab === 'dispatcher' && tabBody('dispatcher', d => (
          <DispatcherDashboard orders={d.dispatchOrders} currentDispatcherId={adminId} embedded />
        ))}

        {activeTab === 'procurement' && (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-foreground">Procurement Requirements</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Total pairs needed per article · colour · vendor — use these numbers to place upstream orders.
              </p>
            </div>
            {tabBody('procurement', d => <ProcurementSummary initialRows={d.procurementRows} />)}
          </div>
        )}
        </AutoRefreshContext.Provider>

      </div>
    </div>
  )
}
