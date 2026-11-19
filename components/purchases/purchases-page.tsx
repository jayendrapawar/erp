'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { PageHeader } from '@/app/orders/_components/shared'
import { PageNav } from '@/components/page-nav'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DIVISIONS, formatSizes } from '@/lib/catalog/assortments'
import { useQrScanner } from '@/components/scanner/use-qr-scanner'
import { ManualCartonPanel } from './manual-carton-panel'
import {
  cancelBillAction, getBillDetail, getExpectedStock, getOpenBills, getPurchaseOverview, getReceipts, receiveCartonAction,
  setBillDivisionAction, setBillMailStartAction, setLineAssortmentAction, voidCartonAction,
  type MailStartState,
} from '@/app/actions/purchases'
import type { BillDetail, BillRow, ExpectedStockRow, PurchaseSummary, ReceiptRow, ReceiveOutcome } from '@/lib/purchases/store'
import type { UploadFileResult } from '@/app/api/purchases/upload/route'
import type { MailCheckResult } from '@/lib/purchases/mail'

interface Props {
  initialSummary: PurchaseSummary
  initialBills: BillRow[]
  canUpload: boolean
  mailboxReady: boolean
  mailStart: MailStartState
  canSetMailStart: boolean
  canReceive: boolean
  canManage: boolean
}

const num = new Intl.NumberFormat('en-IN')
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
const when = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
const inputCls = 'rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring'
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
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

const STATUS: Record<string, { label: string; cls: string }> = {
  expected: { label: 'Expected', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  partial: { label: 'Part received', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  received: { label: 'Received', cls: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  cancelled: { label: 'Cancelled', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
}

/** Purchases: expected stock from supplier bills, receiving cartons against them. */
export function PurchasesPage({ initialSummary, initialBills, canUpload, mailboxReady, mailStart: initialMailStart, canSetMailStart, canReceive, canManage }: Props) {
  const [mailStart, setMailStart] = useState(initialMailStart)
  const [summary, setSummary] = useState(initialSummary)
  const [bills, setBills] = useState(initialBills)
  const [tab, setTab] = useState<string>('bills')
  const [openBill, setOpenBill] = useState<number | null>(null)

  const refresh = useCallback(() => {
    getPurchaseOverview().then((o) => { setSummary(o.summary); setBills(o.bills) }).catch(() => {})
  }, [])
  // Receiving updates the figures, at most every 2 s.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; refresh() }, 2000)
  }, [refresh])

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-2">
          <PageHeader title="Purchases" subtitle="Expected stock, carton receiving and verification" />
          <PageNav />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Tile label="Open bills" value={num.format(summary.openBills)} />
          <Tile label="Overdue" value={num.format(summary.overdueBills)} warn={summary.overdueBills > 0} hint="Not received 5 days after the bill date" />
          <Tile label="Cartons to arrive" value={num.format(summary.cartonsExpected)} />
          <Tile label="Pairs to arrive" value={num.format(summary.pairsExpected)} />
        </div>
        {(summary.unexpectedCartons > 0 || summary.cartonsCheckedOnly > 0) && (
          <div className="mb-4 space-y-1.5 text-xs">
            {summary.cartonsCheckedOnly > 0 && (
              <p className="rounded-lg px-3 py-2 bg-muted text-foreground">
                {summary.cartonsCheckedOnly} received carton{summary.cartonsCheckedOnly === 1 ? ' was' : 's were'} checked against the bill without adding stock (no carton assortment, or the article is not in the master). Their boxes add stock when scanned with the warehouse scanner.
              </p>
            )}
            {summary.unexpectedCartons > 0 && (
              <p className="rounded-lg px-3 py-2 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300">
                {summary.unexpectedCartons} carton{summary.unexpectedCartons === 1 ? '' : 's'} arrived that are not on any open bill — see the Unexpected tab.
              </p>
            )}
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="w-full">
          <TabsList className="flex w-full mb-4">
            <TabsTrigger value="bills" className="text-xs sm:text-sm">Bills</TabsTrigger>
            <TabsTrigger value="receive" className="text-xs sm:text-sm">Receive</TabsTrigger>
            <TabsTrigger value="expected" className="text-xs sm:text-sm">Expected stock</TabsTrigger>
            <TabsTrigger value="unexpected" className="text-xs sm:text-sm">Unexpected ({summary.unexpectedCartons})</TabsTrigger>
          </TabsList>
          <TabsContent value="bills">
            <MailStartPanel state={mailStart} onChange={setMailStart} canSet={canSetMailStart} mailboxReady={mailboxReady} />
            <BillsTab bills={bills} canUpload={canUpload} mailReady={mailboxReady && mailStart.day != null} onOpen={setOpenBill} onUploaded={refresh} />
          </TabsContent>
          <TabsContent value="receive">
            {tab === 'receive' && (canReceive
              ? <ReceiveTab onReceived={refreshSoon} onOpenBill={setOpenBill} />
              : <p className="text-center py-10 text-sm text-muted-foreground">Receiving cartons needs the warehouse, supervisor or admin role.</p>)}
          </TabsContent>
          <TabsContent value="expected">
            {tab === 'expected' && <ExpectedTab />}
          </TabsContent>
          <TabsContent value="unexpected">
            {tab === 'unexpected' && <ReceiptsList unexpected canManage={canManage} onChanged={refresh} />}
          </TabsContent>
        </Tabs>
      </div>
      {openBill != null && <BillDialog billId={openBill} canManage={canManage} onClose={() => setOpenBill(null)} onChanged={refresh} />}
    </div>
  )
}

function Tile({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className={`rounded-xl border bg-card p-3 sm:p-4 ${warn ? 'border-red-300 dark:border-red-800' : 'border-border'}`}>
      <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold mt-1 tabular-nums ${warn ? 'text-red-600' : 'text-foreground'}`}>{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  )
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden"><div className={`h-full ${pct >= 100 ? 'bg-green-600' : 'bg-foreground/70'}`} style={{ width: `${pct}%` }} /></div>
      <span className="text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">{done}/{total} ctn</span>
    </div>
  )
}

// ── Reading bills from mail: on / off ─────────────────────────────────

function MailStartPanel({ state, onChange, canSet, mailboxReady }: { state: MailStartState; onChange: (s: MailStartState) => void; canSet: boolean; mailboxReady: boolean }) {
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
  const [editing, setEditing] = useState(false)
  const [day, setDay] = useState(state.day ?? today)
  const [sure, setSure] = useState(false)
  const [error, setError] = useState('')
  const [busy, start] = useTransition()
  const on = state.day != null
  const save = (value: string | null) => start(async () => {
    setError('')
    try { onChange(await setBillMailStartAction(value)); setEditing(false); setSure(false) } catch (e) { setError(errText(e, 'Could not save.')) }
  })

  return (
    <div className={`mb-3 rounded-xl border px-3 py-2.5 text-xs ${on ? 'border-green-300 bg-green-50 text-green-950 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100' : 'border-border bg-muted/40 text-foreground'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 min-w-[200px]">
          <span className="font-semibold">Bills from mail: {on ? 'ON' : 'OFF'}</span>
          {on
            ? <> — bills mailed from <b>{state.day ? new Date(`${state.day}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}</b> onwards are read with “Check mail”.{state.updatedByName ? ` Set by ${state.updatedByName}.` : ''}</>
            : <> — switch it on once the stocktake of the whole warehouse is complete. Until then, bills can still be uploaded as PDFs.</>}
        </p>
        {canSet && !editing && (
          <>
            <button onClick={() => { setEditing(true); setDay(state.day ?? today) }} className="rounded-lg border border-border bg-background px-2.5 py-1 font-medium hover:bg-muted">{on ? 'Change date' : 'Turn on…'}</button>
            {on && <button onClick={() => { if (window.confirm('Stop reading bills from mail? Bills already imported stay.')) save(null) }} disabled={busy} className="rounded-lg border border-border bg-background px-2.5 py-1 font-medium text-red-600 hover:bg-muted">Turn off</button>}
          </>
        )}
      </div>
      {canSet && !mailboxReady && (
        <p className="mt-1.5 text-amber-700 dark:text-amber-400">The mailbox is not connected on the server yet (one-time setup in Vercel — see the guide “Bills from mail”).</p>
      )}
      {canSet && editing && (
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2">Read bills mailed from
            <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} className={`${inputCls} py-1 text-xs`} />
          </label>
          {!on && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="mt-0.5 accent-foreground" />
              <span>The stocktake of the whole warehouse is complete. Bills from this date become expected stock.</span>
            </label>
          )}
          <div className="flex gap-2">
            <button onClick={() => save(day)} disabled={busy || !day || (!on && !sure)} className="rounded-lg bg-foreground text-background px-3 py-1.5 font-semibold disabled:opacity-50">{busy ? 'Saving…' : on ? 'Save date' : 'Turn on'}</button>
            <button onClick={() => { setEditing(false); setSure(false) }} disabled={busy} className="rounded-lg border border-border bg-background px-3 py-1.5 font-medium hover:bg-muted">Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="mt-1.5 text-red-600">{error}</p>}
    </div>
  )
}

// ── Bills ──────────────────────────────────────────────────────────────

function BillsTab({ bills, canUpload, mailReady, onOpen, onUploaded }: { bills: BillRow[]; canUpload: boolean; mailReady: boolean; onOpen: (id: number) => void; onUploaded: () => void }) {
  const [showAll, setShowAll] = useState(false)
  const [results, setResults] = useState<UploadFileResult[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(20)
  const [mailSince, setMailSince] = useState('')
  const [mail, setMail] = useState<MailCheckResult | null>(null)
  const q = query.trim().toLowerCase()
  const all = (showAll ? bills : bills.filter((b) => b.status === 'expected' || b.status === 'partial'))
    .filter((b) => !q || b.refNo.toLowerCase().includes(q) || b.invoiceNo.toLowerCase().includes(q) || b.division.toLowerCase().includes(q))
  const list = all.slice(0, shown)

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setBusy(true); setError(''); setResults(null)
    const fd = new FormData()
    for (const f of Array.from(files)) fd.append('files', f)
    try {
      const res = await fetch('/api/purchases/upload', { method: 'POST', body: fd })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Upload failed.')
      setResults(body.results)
      onUploaded()
    } catch (e) { setError(errText(e, 'Upload failed.')) }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function checkMail() {
    setBusy(true); setError(''); setResults(null); setMail(null)
    try {
      const res = await fetch('/api/purchases/check-mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mailSince ? { since: mailSince } : {}) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Checking mail failed.')
      setMail(body)
      setResults(body.files)
      onUploaded()
    } catch (e) { setError(errText(e, 'Checking mail failed.')) }
    finally { setBusy(false) }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {canUpload && mailReady && (
          <>
            <button onClick={checkMail} disabled={busy} className="rounded-lg bg-foreground text-background px-3 py-2 text-xs font-semibold hover:opacity-90 disabled:opacity-50">
              {busy ? 'Working…' : 'Check mail'}
            </button>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Leave empty: new mails since the last check (first time: last 7 days)">
              from
              <input type="date" value={mailSince} onChange={(e) => setMailSince(e.target.value)} className={`${inputCls} py-1 text-xs`} />
            </label>
          </>
        )}
        {canUpload && (
          <>
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-muted disabled:opacity-50">
              {busy ? 'Reading bills…' : 'Upload bill PDFs'}
            </button>
          </>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-foreground" />
          Show received and cancelled bills
        </label>
      </div>
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      {mail && (
        <p className="mb-2 text-xs text-muted-foreground">
          Mail since {when.format(new Date(mail.since))}: {mail.found} bill mail{mail.found === 1 ? '' : 's'} found, {mail.alreadyDone} already imported, {mail.processed} read now
          {mail.remaining > 0 ? <span className="text-amber-700 dark:text-amber-400"> · {mail.remaining} more — press Check mail again</span> : null}.
        </p>
      )}
      {results && results.length > 0 && (
        <div className="mb-3 rounded-xl border border-border divide-y divide-border text-xs">
          {results.map((r) => (
            <div key={r.file} className="px-3 py-2">
              <span className="font-medium">{r.file}</span>{' — '}
              {r.status === 'saved' && <span className="text-green-700 dark:text-green-400">saved: bill {r.refNo}, {r.lines} lines, {r.cartons} cartons, {num.format(r.pairs ?? 0)} pairs{r.division ? `, ${r.division}` : ''}{r.lines && r.assortmentsFound !== r.lines ? ` · ${r.lines - (r.assortmentsFound ?? 0)} line(s) need a carton assortment` : ''}</span>}
              {r.status === 'duplicate' && <span className="text-muted-foreground">already uploaded (bill {r.refNo})</span>}
              {r.status === 'error' && <span className="text-red-600">not saved: {r.errors?.join(' ')}</span>}
              {r.warnings?.length ? <span className="block text-amber-700 dark:text-amber-400">{r.warnings.join(' ')}</span> : null}
            </div>
          ))}
        </div>
      )}
      {bills.length > 0 && (
        <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(20) }} placeholder="Search bill no., invoice or division…" aria-label="Search bills"
          className={`${inputCls} w-full mb-3`} />
      )}
      {list.length === 0 && (
        <p className="text-center py-10 text-sm text-muted-foreground">{q ? 'No bill matches.' : bills.length ? 'No open bills. Everything uploaded has been received.' : 'No bills yet. Upload the bill PDFs Relaxo sends by mail.'}</p>
      )}
      {list.length > 0 && <p className="mb-1.5 text-[11px] text-muted-foreground">{all.length} bill{all.length === 1 ? '' : 's'}</p>}
      <div className={`rounded-xl border border-border divide-y divide-border overflow-hidden ${list.length ? '' : 'hidden'}`}>
        {list.map((b) => (
          <button key={b.id} onClick={() => onOpen(b.id)} className="w-full text-left px-3 sm:px-4 py-3 hover:bg-muted/40 flex flex-col sm:flex-row gap-2 sm:gap-3 sm:items-center">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span>{b.refNo}</span>
                <span className="font-normal text-muted-foreground text-xs">{b.invoiceNo}</span>
                <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${STATUS[b.status]?.cls ?? ''}`}>{STATUS[b.status]?.label ?? b.status}</span>
                {b.overdue && <span className="rounded-full px-1.5 py-px text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">Overdue</span>}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Bill {day(b.billDate)} · expected {day(b.expectedOn)} · {b.division || 'division?'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {num.format(b.totalPairs)} pairs{b.grossAmount != null ? ` · ${inr.format(b.grossAmount)}` : ''}
                {b.pendingStock > 0 ? <span> · {b.pendingStock} carton(s) checked only — scan their boxes</span> : null}
              </p>
            </div>
            <div className="w-full sm:w-40 shrink-0"><Progress done={b.receivedCartons} total={b.totalCartons} /></div>
          </button>
        ))}
      </div>
      {all.length > list.length && (
        <button onClick={() => setShown((n) => n + 20)} className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">
          Show more ({all.length - list.length} left)
        </button>
      )}
    </div>
  )
}

function BillDialog({ billId, canManage, onClose, onChanged }: { billId: number; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<BillDetail | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, start] = useTransition()
  const [voiding, setVoiding] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [cancelling, setCancelling] = useState(false)

  const load = useCallback(() => {
    getBillDetail(billId).then((x) => { setD(x); if (!x) setError('Bill not found.') }).catch((e) => setError(errText(e, 'Could not load.')))
  }, [billId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const run = (f: () => Promise<string | void>) => start(async () => {
    setError(''); setNote('')
    try { const msg = await f(); if (msg) setNote(msg); load(); onChanged() } catch (e) { setError(errText(e, 'Failed.')) }
  })

  const b = d?.bill
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm sm:px-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={b ? `Bill ${b.refNo}` : 'Bill'} className="w-full sm:max-w-3xl rounded-t-2xl sm:rounded-2xl border border-border bg-background shadow-2xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
          {b ? (
            <div className="min-w-0">
              <p className="font-semibold text-foreground">Bill {b.refNo} <span className={`ml-1 rounded-full px-1.5 py-px text-[10px] font-medium align-middle ${STATUS[b.status]?.cls ?? ''}`}>{STATUS[b.status]?.label}</span>{b.overdue && <span className="ml-1 rounded-full px-1.5 py-px text-[10px] font-medium align-middle bg-red-100 text-red-700">Overdue</span>}</p>
              <p className="text-xs text-muted-foreground">
                {b.docType === 'proforma' ? 'Proforma' : 'Invoice'} {b.invoiceNo} · {day(b.billDate)} · expected {day(b.expectedOn)}{b.soNo ? ` · SO ${b.soNo}` : ''} · uploaded by {b.uploadedByName || '—'}
              </p>
            </div>
          ) : <p className="text-sm text-muted-foreground">{error || 'Loading…'}</p>}
          <button onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted">✕</button>
        </div>

        {d && b && (
          <div className="overflow-y-auto p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="w-48"><Progress done={b.receivedCartons} total={b.totalCartons} /></div>
              <p className="text-xs text-muted-foreground">{num.format(b.receivedPairs)} of {num.format(b.totalPairs)} pairs received{b.grossAmount != null ? ` · ${inr.format(b.grossAmount)}` : ''}</p>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">Division
                <select value={b.division} disabled={!canManage || busy} onChange={(e) => run(async () => { await setBillDivisionAction(billId, e.target.value) })} className={`${inputCls} py-1 text-xs`}>
                  {!b.division && <option value="">—</option>}
                  {[...new Set([...DIVISIONS, b.division].filter(Boolean))].map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
            </div>
            {error && <p className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{error}</p>}
            {note && <p className="text-xs bg-muted rounded-lg px-3 py-2">{note}</p>}
            {b.pendingStock > 0 && (
              <p className="text-xs text-muted-foreground">{b.pendingStock} received carton(s) were checked against this bill without adding stock: scan their boxes with the warehouse scanner.</p>
            )}

            <div className="rounded-xl border border-border divide-y divide-border">
              {d.lines.map((l) => {
                const complete = l.receivedCartons >= l.cartons
                return (
                  <div key={l.id} className="px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[11px] text-muted-foreground w-5">{l.lineNo}</span>
                      <span className="font-medium">{l.articleName ?? l.articleCode}</span>
                      <span className="text-muted-foreground font-mono text-xs">{l.articleCode} {l.colourCode} · {l.sizeFrom === l.sizeTo ? `size ${l.sizeTo}` : `${l.sizeFrom}–${l.sizeTo}`}{l.packLetter ? ` ${l.packLetter}` : ''}</span>
                      <span className="text-xs text-muted-foreground">· {l.pairsPerCarton}/ctn · MRP ₹{l.mrp}</span>
                      <span className={`ml-auto text-xs tabular-nums font-semibold ${complete ? 'text-green-700 dark:text-green-400' : ''}`}>{l.receivedCartons}/{l.cartons} ctn</span>
                    </div>
                    <div className="pl-7 mt-1 text-[11px] text-muted-foreground space-y-0.5">
                      {!l.articleName && <p className="text-amber-700 dark:text-amber-400">Article not in the article master — cartons are checked against the bill; stock comes from scanning their boxes.</p>}
                      {l.sizeFrom === l.sizeTo ? (
                        <p>Single-size carton: {l.pairsPerCarton} pairs of size {l.sizeTo}{l.receivedCartons ? ` · ${l.postedCartons} of ${l.receivedCartons} received carton(s) added stock` : ''}</p>
                      ) : l.assortment ? (
                        <p>Assortment: {l.assortment.segment} v{l.assortment.version} · <span className="font-mono">{formatSizes(l.assortment.sizes)}</span>{l.receivedCartons ? ` · ${l.postedCartons} of ${l.receivedCartons} received carton(s) added stock` : ''}</p>
                      ) : l.options.length ? (
                        <p className="flex flex-wrap items-center gap-1.5">
                          <span className="text-amber-700 dark:text-amber-400">Choose the carton assortment (for cartons received from now on):</span>
                          {l.options.map((o) => (
                            <button key={o.id} disabled={!canManage || busy} onClick={() => run(async () => { await setLineAssortmentAction(l.id, o.id); return 'Assortment saved. Cartons received from now on add stock.' })}
                              className="rounded-md border border-border px-1.5 py-0.5 hover:bg-muted disabled:opacity-60">
                              {o.segment}: <span className="font-mono">{formatSizes(o.sizes)}</span>
                            </button>
                          ))}
                        </p>
                      ) : (
                        <p className="text-amber-700 dark:text-amber-400">No carton assortment for {b.division || 'this division'} · {l.pairsPerCarton} pairs · code {l.sizeFrom}{l.sizeTo.padStart(2, '0')} — cartons are checked against the bill and stock comes from scanning their boxes. Add the assortment in Master → Assortments to add stock from the carton itself.</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Cartons received ({d.receipts.length})</p>
              {d.receipts.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
              <ReceiptRows rows={d.receipts} canManage={canManage} busy={busy} voiding={voiding} setVoiding={setVoiding} reason={reason} setReason={setReason}
                onVoid={(id) => run(async () => { await voidCartonAction(id, reason); setVoiding(null); setReason('') })} />
            </div>

            {canManage && b.status !== 'cancelled' && d.receipts.length === 0 && (
              cancelling ? (
                <div className="flex gap-2">
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why cancel this bill?" aria-label="Reason" className={`${inputCls} flex-1`} />
                  <button disabled={busy || reason.trim().length < 3} onClick={() => run(async () => { await cancelBillAction(billId, reason); setCancelling(false); setReason('') })}
                    className="rounded-lg bg-red-600 text-white px-3 text-xs font-semibold disabled:opacity-50">Cancel bill</button>
                </div>
              ) : (
                <button onClick={() => setCancelling(true)} className="text-xs text-red-600 hover:underline">Cancel this bill (goods will not come)</button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ReceiptRows({ rows, canManage, busy, voiding, setVoiding, reason, setReason, onVoid }: {
  rows: ReceiptRow[]; canManage: boolean; busy: boolean; voiding: number | null; setVoiding: (id: number | null) => void
  reason: string; setReason: (s: string) => void; onVoid: (id: number) => void
}) {
  if (!rows.length) return null
  return (
    <div className="rounded-xl border border-border divide-y divide-border">
      {rows.map((r) => (
        <div key={r.id} className="px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="w-[68px] shrink-0 text-muted-foreground tabular-nums">{when.format(new Date(r.at))}</span>
            <span className="font-mono flex-1 min-w-0 truncate">{r.articleCode} {r.colourCode} {r.sizeFrom}–{r.sizeTo}{r.packLetter ? ` ${r.packLetter}` : ''}{r.mrp != null ? ` · ₹${r.mrp}` : ''}</span>
            <span className="text-muted-foreground hidden sm:inline">{r.userName}</span>
            {r.match === 'matched'
              ? <span className={r.posted ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>{r.posted ? `+${r.postedPairs} in stock` : 'checked · scan boxes'}</span>
              : <span className="text-red-600">unexpected</span>}
            {canManage && <button onClick={() => { setVoiding(voiding === r.id ? null : r.id); setReason('') }} className="rounded-md border border-border px-1.5 py-0.5 hover:bg-muted">Undo</button>}
          </div>
          {voiding === r.id && (
            <div className="flex gap-2 mt-1.5">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why undo?" aria-label="Reason for undo" className={`${inputCls} flex-1 py-1.5 text-xs`} />
              <button onClick={() => onVoid(r.id)} disabled={busy || reason.trim().length < 3} className="rounded-lg bg-foreground text-background px-3 text-xs font-semibold disabled:opacity-50">Undo</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Receive ────────────────────────────────────────────────────────────

interface LogItem { id: string; raw: string; at: number; pending: boolean; out?: ReceiveOutcome; error?: string }

function ReceiveTab({ onReceived, onOpenBill }: { onReceived: () => void; onOpenBill: (id: number) => void }) {
  const [openBills, setOpenBills] = useState<BillRow[]>([])
  const [billId, setBillId] = useState<number | ''>('')
  const [log, setLog] = useState<LogItem[]>([])
  const [manualOpen, setManualOpen] = useState(false)
  // While manual entry waits for a pair box, scanned codes go to it instead of carton receiving.
  const boxHandlerRef = useRef<((raw: string) => void) | null>(null)
  const registerBoxHandler = useCallback((fn: ((raw: string) => void) | null) => { boxHandlerRef.current = fn }, [])
  const billRef = useRef<number | ''>('')
  useEffect(() => { billRef.current = billId }, [billId])
  useEffect(() => { getOpenBills().then(setOpenBills).catch(() => {}) }, [])

  const submit = useCallback((raw: string) => {
    if (boxHandlerRef.current) { boxHandlerRef.current(raw); return }
    const id = uuid()
    setLog((l) => [{ id, raw, at: Date.now(), pending: true }, ...l].slice(0, 100))
    receiveCartonAction({ rawInput: raw, clientEventId: id, billId: billRef.current || null })
      .then((out) => {
        setLog((l) => l.map((x) => (x.id === id ? { ...x, pending: false, out } : x)))
        try { navigator.vibrate?.(out.status === 'received' && out.match === 'matched' ? 60 : [60, 60, 60]) } catch { /* ignore */ }
        if (out.status === 'received') onReceived()
      })
      .catch((e) => setLog((l) => l.map((x) => (x.id === id ? { ...x, pending: false, error: errText(e, 'Not saved — scan again.') } : x))))
  }, [onReceived])

  const { videoRef, active, error, start, stop } = useQrScanner(submit)
  const last = log[0]

  const addManualResult = useCallback((raw: string, out: ReceiveOutcome) => {
    setLog((l) => [{ id: uuid(), raw, at: Date.now(), pending: false, out }, ...l].slice(0, 100))
    if (out.status === 'received') onReceived()
  }, [onReceived])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={billId} onChange={(e) => setBillId(e.target.value ? Number(e.target.value) : '')} aria-label="Bill" className={`${inputCls} text-xs flex-1 min-w-[200px]`}>
          <option value="">Match to any open bill (oldest first)</option>
          {openBills.map((b) => <option key={b.id} value={b.id}>{b.refNo} · {day(b.billDate)} · {b.receivedCartons}/{b.totalCartons} ctn</option>)}
        </select>
        <button onClick={active ? stop : start} className={`rounded-lg px-3 py-2 text-xs font-semibold ${active ? 'border border-border hover:bg-muted' : 'bg-foreground text-background hover:opacity-90'}`}>
          {active ? 'Stop camera' : 'Scan with camera'}
        </button>
        {!manualOpen && (
          <button onClick={() => setManualOpen(true)} className="rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-muted">
            Manual entry
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {manualOpen ? 'Manual entry: scan one pair box from the carton.' : 'Scan the outer carton label. A USB / Bluetooth scanner works without the camera. Label damaged? Use Manual entry.'}
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className={`relative overflow-hidden rounded-xl border border-border bg-black ${active ? '' : 'hidden'}`}>
        <video ref={videoRef} playsInline muted className="w-full max-h-[45vh] object-cover" />
      </div>
      {manualOpen && (
        <ManualCartonPanel registerBoxHandler={registerBoxHandler} cameraActive={active} onStartCamera={start}
          onResult={addManualResult} onClose={() => setManualOpen(false)} />
      )}

      {last && <ResultBanner item={last} onOpenBill={onOpenBill} />}

      {log.length > 1 && (
        <div className="rounded-xl border border-border divide-y divide-border">
          {log.slice(1).map((x) => <ResultLine key={x.id} item={x} />)}
        </div>
      )}
    </div>
  )
}

function describe(x: LogItem): { tone: 'ok' | 'warn' | 'err' | 'wait'; title: string; detail: string } {
  if (x.pending) return { tone: 'wait', title: 'Saving…', detail: x.raw }
  if (x.error) return { tone: 'err', title: 'Not saved', detail: x.error }
  const o = x.out!
  if (o.status === 'rejected') return { tone: 'err', title: 'Not a carton', detail: o.message }
  if (o.status === 'duplicate') return { tone: 'warn', title: `Already received · ${o.label}`, detail: o.message }
  if (o.match === 'unexpected') return { tone: 'err', title: `Unexpected carton · ${o.label}`, detail: o.reason }
  return {
    tone: o.warnings.length ? 'warn' : 'ok',
    title: `${o.label} · bill ${o.refNo} line ${o.lineNo} · ${o.lineReceived}/${o.lineCartons}`,
    detail: [o.posted ? `+${o.postedPairs} pairs in stock.` : o.pendingReason, ...o.warnings].filter(Boolean).join(' '),
  }
}

const TONE = {
  ok: 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200',
  warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200',
  err: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200',
  wait: 'border-border bg-muted text-foreground',
}

function ResultBanner({ item, onOpenBill }: { item: LogItem; onOpenBill: (id: number) => void }) {
  const d = describe(item)
  const o = item.out
  return (
    <div className={`rounded-xl border px-4 py-3 ${TONE[d.tone]}`} role="status" aria-live="polite">
      <p className="text-sm font-semibold">{d.title}</p>
      <p className="text-xs mt-0.5">{d.detail}</p>
      {o?.status === 'received' && o.match === 'matched' && (
        <button onClick={() => onOpenBill(o.billId)} className="mt-1.5 text-xs underline">Open bill {o.refNo}</button>
      )}
    </div>
  )
}

function ResultLine({ item }: { item: LogItem }) {
  const d = describe(item)
  const dot = { ok: 'bg-green-600', warn: 'bg-amber-500', err: 'bg-red-600', wait: 'bg-muted-foreground' }[d.tone]
  return (
    <div className="flex items-start gap-2 px-3 py-2 text-xs">
      <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${dot}`} />
      <div className="min-w-0"><p className="truncate">{d.title}</p><p className="text-muted-foreground truncate">{d.detail}</p></div>
    </div>
  )
}

// ── Expected stock ────────────────────────────────────────────────────

function ExpectedTab() {
  const [rows, setRows] = useState<ExpectedStockRow[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [busy, start] = useTransition()
  const q = useDebounced(search)
  useEffect(() => {
    start(async () => {
      try { setRows(await getExpectedStock(q)); setError('') } catch (e) { setError(errText(e, 'Could not load.')) }
    })
  }, [q])
  const today = new Date().toISOString().slice(0, 10)
  return (
    <div>
      <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Article, colour…" aria-label="Search expected stock" className={`${inputCls} w-full mb-3`} />
      <p className="text-xs text-muted-foreground mb-2">Pairs on open bills not received yet. {rows.length ? `${num.format(rows.reduce((n, r) => n + r.pairs, 0))} pairs in ${rows.length} rows.` : ''}</p>
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      {!busy && rows.length === 0 && <p className="text-center py-10 text-sm text-muted-foreground">Nothing expected.</p>}
      <div className={`rounded-xl border border-border divide-y divide-border overflow-hidden ${rows.length ? '' : 'hidden'} ${busy ? 'opacity-70' : ''}`}>
        {rows.map((r) => (
          <div key={`${r.articleCode}|${r.colourCode}|${r.sizeFrom}|${r.sizeTo}`} className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground truncate">{r.articleName ?? r.articleCode} <span className="text-muted-foreground font-mono text-xs">{r.articleCode} {r.colourCode} · {r.sizeFrom}–{r.sizeTo}</span></p>
              <p className={`text-[11px] ${r.earliest < today ? 'text-red-600' : 'text-muted-foreground'}`}>{r.bills} bill{r.bills === 1 ? '' : 's'} · first expected {day(r.earliest)}{r.earliest < today ? ' (overdue)' : ''}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-base font-bold tabular-nums">{num.format(r.pairs)}</p>
              <p className="text-[11px] text-muted-foreground">{r.cartons} ctn</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Unexpected cartons ─────────────────────────────────────────────────

function ReceiptsList({ unexpected, canManage, onChanged }: { unexpected?: boolean; canManage: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<ReceiptRow[]>([])
  const [error, setError] = useState('')
  const [busy, start] = useTransition()
  const [voiding, setVoiding] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const load = useCallback(() => start(async () => {
    try { setRows(await getReceipts({ unexpected })); setError('') } catch (e) { setError(errText(e, 'Could not load.')) }
  }), [unexpected])
  useEffect(() => { load() }, [load])
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">Cartons scanned at receiving that match no open bill (or more cartons than the bill lists). Stock was not changed. Upload the missing bill, then undo and scan the carton again — or undo it if it was scanned by mistake.</p>
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      {!busy && rows.length === 0 && <p className="text-center py-10 text-sm text-muted-foreground">None.</p>}
      <ReceiptRows rows={rows} canManage={canManage} busy={busy} voiding={voiding} setVoiding={setVoiding} reason={reason} setReason={setReason}
        onVoid={(id) => start(async () => {
          try { await voidCartonAction(id, reason); setVoiding(null); setReason(''); load(); onChanged() } catch (e) { setError(errText(e, 'Could not undo.')) }
        })} />
    </div>
  )
}
