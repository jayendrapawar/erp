'use client'

// Payments (payments step 5): Outstanding (who owes what, by age), Payments & cheques (cheques to
// deposit, recent payments; deposit / return / bounced / reverse), Party statement (running balance,
// print, WhatsApp). Record payment: the button or "n" from any tab. Reads go through GET /api/payments
// (one query each); saves update the screen in place (no page refresh).

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { PageHeader } from '@/app/orders/_components/shared'
import { PageNav } from '@/components/page-nav'
import { DialogKeys } from '@/components/dialog-keys'
import { useHashTab } from '@/lib/use-hash-tab'
import { useShortcut } from '@/lib/shortcuts'
import { useListKeys } from '@/lib/shortcuts/list'
import { tablistKeyDown, tabProps, useTabKeys } from '@/lib/shortcuts/tabs'
import { formatRs } from '@/lib/billing/bill-amounts'
import { toPaise } from '@/lib/billing/bill-totals'
import { bouncePaymentAction, depositChequeAction, returnChequeAction, reversePaymentAction } from '@/app/actions/payments'
import type { OutstandingPage, OutstandingSort, PartyChoice, PaymentRow, Statement } from '@/lib/payments/queries'
import { PartyPicker } from './party-picker'
import { OpeningTab } from './opening-tab'
import { CreditNotesTab } from './credit-notes-tab'
import { BankStatementTab } from './bank-statement-tab'
import { RecordPayment } from './record-payment'
import { dayText, istToday, printSlip, printStatement, statementText, whatsappLink } from './print'
import type { BankAccount, SlipInto, SlipView } from '@/lib/payments/slips'

const TABS = ['outstanding', 'slips', 'bank', 'cheques', 'statement', 'creditnotes', 'opening'] as const
const LABEL: Record<string, string> = { outstanding: 'Outstanding', slips: 'Slips', bank: 'Bank statement', cheques: 'Payments & cheques', statement: 'Party statement', creditnotes: 'Credit notes', opening: 'Opening balances' }
const inputCls = 'h-10 rounded-xl border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Cheque received', cls: 'bg-amber-500/15 text-amber-800 dark:text-amber-300' },
  active: { label: 'Counted', cls: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' },
  returned: { label: 'Returned', cls: 'bg-muted text-muted-foreground' },
  bounced: { label: 'Bounced', cls: 'bg-red-500/15 text-red-700 dark:text-red-300' },
  reversed: { label: 'Reversed', cls: 'bg-muted text-muted-foreground' },
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error || 'Could not load. Check the connection.')
  return j as T
}
/** Start of the Indian financial year (1 April) for a date. */
function fyStart(iso: string): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7))
  return `${m >= 4 ? y : y - 1}-04-01`
}

export function PaymentsPage({ initialOutstanding, parties, banks = [], canRecord }: { initialOutstanding: OutstandingPage; parties: PartyChoice[]; banks?: BankAccount[]; canRecord: boolean }) {
  const [tab, setTab] = useHashTab(TABS, 'outstanding')
  useTabKeys(TABS.map((t) => ({ value: t, label: LABEL[t] })), setTab, { group: 'Payments tabs' })
  const [recordFor, setRecordFor] = useState<{ partyId: string | null; into?: SlipInto; date?: string } | null>(null)
  const [statementParty, setStatementParty] = useState<PartyChoice | null>(null)
  /** Bumped after any save, so the open lists load again. */
  const [version, setVersion] = useState(0)
  useShortcut('n', () => setRecordFor({ partyId: null }), { label: 'Record payment', group: 'Payments', enabled: canRecord })

  const openStatement = (id: string) => { setStatementParty(parties.find((p) => p.id === id) ?? null); setTab('statement') }
  return (
    <div className="mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-6 pb-28 md:pb-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Payments" subtitle="What parties owe, money received, cheques" />
        <div className="flex items-center gap-2">
          {canRecord && (
            <button type="button" onClick={() => setRecordFor({ partyId: statementParty?.id ?? null })}
              className="h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              + Record payment <kbd className="ml-1 hidden rounded border border-primary-foreground/40 px-1 text-[10px] sm:inline">n</kbd>
            </button>
          )}
          <PageNav />
        </div>
      </div>
      <div role="tablist" aria-label="Payments" onKeyDown={tablistKeyDown} className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-border bg-muted/40 p-1">
        {TABS.map((t) => (
          <button key={t} type="button" {...tabProps(tab === t)} onClick={() => setTab(t)}
            className={`h-9 shrink-0 rounded-lg px-4 text-sm font-semibold ${tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'outstanding' && <OutstandingTab initial={initialOutstanding} version={version} canRecord={canRecord}
        onStatement={openStatement} onRecord={(id) => setRecordFor({ partyId: id })} />}
      {tab === 'slips' && <SlipsTab banks={banks} version={version} canRecord={canRecord}
        onAdd={(into, date) => setRecordFor({ partyId: null, into, date })} onChanged={() => setVersion((v) => v + 1)} />}
      {tab === 'bank' && <BankStatementTab banks={banks} parties={parties} canRecord={canRecord} onChanged={() => setVersion((v) => v + 1)} />}
      {tab === 'cheques' && <PaymentsTab version={version} canRecord={canRecord} onChanged={() => setVersion((v) => v + 1)} onStatement={openStatement} />}
      {tab === 'creditnotes' && <CreditNotesTab parties={parties} canRecord={canRecord} onChanged={() => setVersion((v) => v + 1)} />}
      {tab === 'opening' && <OpeningTab parties={parties} canRecord={canRecord} onChanged={() => setVersion((v) => v + 1)} />}
      {tab === 'statement' && <StatementTab parties={parties} party={statementParty} onParty={setStatementParty} version={version} />}

      {recordFor && (
        <RecordPayment parties={parties} banks={banks} initialPartyId={recordFor.partyId} initialInto={recordFor.into} initialDate={recordFor.date}
          onClose={() => setRecordFor(null)} onSaved={() => setVersion((v) => v + 1)} />
      )}
    </div>
  )
}

// ── Outstanding ───────────────────────────────────────────────────────────────

function OutstandingTab({ initial, version, canRecord, onStatement, onRecord }: {
  initial: OutstandingPage; version: number; canRecord: boolean; onStatement: (id: string) => void; onRecord: (id: string) => void
}) {
  const [data, setData] = useState(initial)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<OutstandingSort>('balance')
  const [overdue, setOverdue] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  useListKeys(listRef, { label: 'Outstanding parties' })
  const first = useRef(true)

  const load = useCallback(async (offset: number) => {
    setLoading(true); setErr('')
    try {
      const page = await getJson<OutstandingPage>(`/api/payments?view=outstanding&q=${encodeURIComponent(q)}&sort=${sort}&overdue=${overdue ? 1 : 0}&offset=${offset}`)
      setData((d) => (offset ? { ...page, rows: [...d.rows, ...page.rows] } : page))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.') } finally { setLoading(false) }
  }, [q, sort, overdue])
  // Search waits for typing to stop (300 ms); the first paint uses the page's own data.
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => { void load(0) }, 300)
    return () => clearTimeout(t)
  }, [load, version])

  const s = data.sums
  const card = (label: string, v: number, cls = '') => (
    <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-2">
      <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className={`mt-0.5 truncate text-base font-bold tabular-nums sm:text-lg ${cls}`}>{formatRs(v)}</p>
    </div>
  )
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        {card('Total owed', s.balancePaise)}
        {card('0–30 days', s.age0)}
        {card('31–60 days', s.age30)}
        {card('61–90 days', s.age60, s.age60 ? 'text-amber-700 dark:text-amber-300' : '')}
        {card('Over 90 days', s.age90, s.age90 ? 'text-red-600 dark:text-red-400' : '')}
        {card('Advance held', s.advancePaise)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="out-q">Search party</label>
        <input id="out-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search party, area, city…" className={`${inputCls} min-w-0 flex-1`} />
        <label className="sr-only" htmlFor="out-sort">Sort</label>
        <select id="out-sort" value={sort} onChange={(e) => setSort(e.target.value as OutstandingSort)} className={inputCls}>
          <option value="balance">Most owed</option><option value="overdue">Most over 90 days</option>
          <option value="oldest">Oldest unpaid bill</option><option value="name">Name</option>
        </select>
        <label className="flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Over 90 days only
        </label>
      </div>
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      <p className="text-xs text-muted-foreground" aria-live="polite">{loading ? 'Loading…' : `${data.total} part${data.total === 1 ? 'y' : 'ies'}`}</p>
      <div ref={listRef} className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Party</th>
              <th className="px-2 py-2 text-right font-semibold">Balance</th>
              <th className="px-2 py-2 text-right font-semibold">0–30</th><th className="px-2 py-2 text-right font-semibold">31–60</th>
              <th className="px-2 py-2 text-right font-semibold">61–90</th><th className="px-2 py-2 text-right font-semibold">90+</th>
              <th className="px-2 py-2 text-left font-semibold">Oldest unpaid</th><th className="px-2 py-2 text-left font-semibold">Last paid</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.rows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">{q || overdue ? 'No party matches.' : 'Nothing owed — no bills or payments yet.'}</td></tr>}
            {data.rows.map((r) => (
              <tr key={r.retailerId} data-list-row className="hover:bg-muted/30">
                <td className="px-3 py-2">
                  <button type="button" data-row-open onClick={() => onStatement(r.retailerId)} className="text-left font-semibold hover:underline" data-no-translate>{r.partyName}</button>
                  <span className="block text-[11px] text-muted-foreground">{[r.area, r.city].filter(Boolean).join(', ')}{r.pendingCheques ? ` · ${r.pendingCheques} cheque${r.pendingCheques > 1 ? 's' : ''} to deposit` : ''}</span>
                </td>
                <td className={`px-2 py-2 text-right font-bold tabular-nums whitespace-nowrap ${r.balancePaise < 0 ? 'text-emerald-700 dark:text-emerald-300' : ''}`}>
                  {r.balancePaise < 0 ? `${formatRs(-r.balancePaise)} adv.` : formatRs(r.balancePaise)}
                </td>
                {[r.age0, r.age30, r.age60, r.age90].map((v, i) => (
                  <td key={i} className={`px-2 py-2 text-right tabular-nums whitespace-nowrap ${!v ? 'text-muted-foreground/50' : i === 3 ? 'font-semibold text-red-600 dark:text-red-400' : i === 2 ? 'text-amber-700 dark:text-amber-300' : ''}`}>{v ? formatRs(v) : '—'}</td>
                ))}
                <td className="px-2 py-2 text-xs">{dayText(r.oldestUnpaid)}</td>
                <td className="px-2 py-2 text-xs">{dayText(r.lastPaid)}</td>
                <td className="px-3 py-2 text-right">
                  {canRecord && <button type="button" onClick={() => onRecord(r.retailerId)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted">Record payment</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.rows.length < data.total && (
        <button type="button" data-show-more disabled={loading} onClick={() => void load(data.rows.length)}
          className="w-full rounded-xl border border-dashed border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50">
          {loading ? 'Loading…' : `Show more (${data.total - data.rows.length} more)`}
        </button>
      )}
    </div>
  )
}

// ── Slips (owner, 24 Nov 2026) ────────────────────────────────────────────────
// A day's cash slip or bank slip: every party's line, reversed ones struck out, the total. "Add entry"
// opens Record payment for that slip and day. One query (GET /api/payments?view=slip).

function SlipsTab({ banks, version, canRecord, onAdd, onChanged }: {
  banks: BankAccount[]; version: number; canRecord: boolean; onAdd: (into: SlipInto, date: string) => void; onChanged: () => void
}) {
  const [into, setInto] = useState<SlipInto>({ kind: 'cash' })
  const [date, setDate] = useState(istToday())
  const [view, setView] = useState<SlipView | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [rev, setRev] = useState<PaymentRow | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useListKeys(listRef, { label: 'Slip lines' })
  const key = into.kind === 'cash' ? 'cash' : String(into.bankAccountId)
  useEffect(() => {
    let live = true
    setErr('')
    getJson<SlipView>(`/api/payments?view=slip&bank=${key}&date=${date}`)
      .then((v) => { if (live) setView(v) }).catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load.') })
    return () => { live = false }
  }, [key, date, version])
  const options: SlipInto[] = [{ kind: 'cash' }, ...banks.map((b): SlipInto => ({ kind: 'bank', bankAccountId: b.id }))]
  const label = (i: SlipInto) => (i.kind === 'cash' ? 'Cash' : banks.find((b) => b.id === i.bankAccountId)?.name ?? 'Bank')
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div role="tablist" aria-label="Cash or bank" onKeyDown={tablistKeyDown} className="flex flex-wrap gap-1 rounded-xl border border-border bg-muted/40 p-1">
          {options.map((o) => {
            const k = o.kind === 'cash' ? 'cash' : String(o.bankAccountId)
            return (
              <button key={k} type="button" {...tabProps(k === key)} onClick={() => setInto(o)}
                className={`h-9 rounded-lg px-4 text-sm font-semibold ${k === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                {label(o)}
              </button>
            )
          })}
        </div>
        <label className="text-xs font-medium text-muted-foreground">Date
          <input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value)} className={`${inputCls} mt-1 block`} />
        </label>
        <span className="flex-1" />
        {view?.slip && <button type="button" onClick={() => void printSlip(view)} className="h-10 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">Print slip</button>}
        {canRecord && (
          <button type="button" onClick={() => onAdd(into, date)} className="h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">
            {`+ Add entry to ${label(into)}`}
          </button>
        )}
      </div>
      {banks.length === 0 && <p className="text-xs text-muted-foreground">Add your banks in Master → Banks to keep bank slips.</p>}
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      {msg && <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">{msg}</p>}
      <p className="text-sm">
        {view?.slip ? <>Slip <b className="font-mono">{view.slip.slipNo}</b>{` · ${dayText(view.slip.slipDate)} · ${label(into)}`}</> : `No ${label(into)} slip on ${dayText(date)} yet — the first entry opens it.`}
      </p>
      <div ref={listRef} className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-3 py-2 text-left font-semibold">#</th><th className="px-2 py-2 text-left font-semibold">Party</th><th className="px-2 py-2 text-left font-semibold">How</th>
              <th className="px-2 py-2 text-left font-semibold">Against bills</th><th className="px-2 py-2 text-right font-semibold">Amount</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {view && view.lines.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No entries on this slip.</td></tr>}
            {view?.lines.map((l, i) => (
              <tr key={l.paymentId} data-list-row className={l.status !== 'active' ? 'text-muted-foreground line-through decoration-1' : ''}>
                <td className="px-3 py-2 text-xs tabular-nums">{i + 1}</td>
                <td className="px-2 py-2 font-medium" data-no-translate>{l.partyName}{l.note && <span className="block text-[11px] font-normal text-muted-foreground">{l.note}</span>}
                  {l.reversalReason && <span className="block text-[11px] font-normal no-underline">{`Reversed: ${l.reversalReason}`}</span>}</td>
                <td className="px-2 py-2 text-xs">{l.mode.toUpperCase()}{l.chequeNo ? ` ${l.chequeNo}` : ''}{l.reference ? ` · ${l.reference}` : ''}</td>
                <td className="px-2 py-2 text-xs">{l.setAgainst.map((a) => `${a.refNo} ${formatRs(a.amountPaise)}`).join(', ') || (l.status === 'active' ? 'Advance' : '')}
                  {l.discountPaise > 0 && <span className="block text-emerald-700 dark:text-emerald-300">{`Discount ${formatRs(l.discountPaise)}`}</span>}</td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums whitespace-nowrap">{formatRs(l.amountPaise)}</td>
                <td className="px-3 py-2 text-right">
                  {canRecord && l.status === 'active' && (
                    <button type="button" data-row-open onClick={() => setRev({ paymentId: l.paymentId, receiptNo: l.receiptNo, retailerId: l.retailerId, partyName: l.partyName, mode: l.mode,
                      amountPaise: l.amountPaise, receivedOn: date, countedOn: date, status: l.status, chequeNo: l.chequeNo, chequeBank: '', chequeDate: null, reference: l.reference, note: l.note, createdByName: l.createdByName })}
                      className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30">Reverse</button>
                  )}
                </td>
              </tr>
            ))}
            {view && view.lines.length > 0 && (
              <tr className="bg-muted/20"><td className="px-3 py-2" colSpan={4}><b>Total</b></td><td className="px-2 py-2 text-right font-bold tabular-nums whitespace-nowrap">{formatRs(view.totalPaise)}</td><td /></tr>
            )}
          </tbody>
        </table>
      </div>
      {rev && <PaymentActionDialog kind="reverse" p={rev} onClose={() => setRev(null)} onDone={(t) => { setRev(null); setMsg(t); onChanged() }} />}
    </div>
  )
}

// ── Payments & cheques ────────────────────────────────────────────────────────

type ActionKind = 'deposit' | 'return' | 'bounce' | 'reverse'

function PaymentsTab({ version, canRecord, onChanged, onStatement }: { version: number; canRecord: boolean; onChanged: () => void; onStatement: (id: string) => void }) {
  const [data, setData] = useState<{ pending: PaymentRow[]; recent: PaymentRow[] } | null>(null)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [act, setAct] = useState<{ kind: ActionKind; p: PaymentRow } | null>(null)
  const [msg, setMsg] = useState('')
  const pendRef = useRef<HTMLDivElement>(null)
  const recRef = useRef<HTMLDivElement>(null)
  useListKeys(pendRef, { label: 'Cheques to deposit' })
  useListKeys(recRef, { label: 'Recent payments' })
  useEffect(() => {
    const t = setTimeout(() => {
      getJson<{ pending: PaymentRow[]; recent: PaymentRow[] }>(`/api/payments?view=payments&q=${encodeURIComponent(q)}`)
        .then((d) => { setData(d); setErr('') }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.'))
    }, data ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const row = (p: PaymentRow, actions: React.ReactNode) => (
    <tr key={p.paymentId} data-list-row className="hover:bg-muted/30">
      <td className="px-3 py-2 font-mono text-xs">{p.receiptNo}</td>
      <td className="px-2 py-2"><button type="button" data-row-open onClick={() => onStatement(p.retailerId)} className="text-left font-medium hover:underline" data-no-translate>{p.partyName}</button></td>
      <td className="px-2 py-2 text-right font-semibold tabular-nums whitespace-nowrap">{formatRs(p.amountPaise)}</td>
      <td className="px-2 py-2 text-xs">{p.mode === 'cheque' ? `Cheque ${p.chequeNo}, ${p.chequeBank}` : p.mode.toUpperCase()}{p.reference ? ` · ${p.reference}` : ''}</td>
      <td className="px-2 py-2 text-xs">{p.mode === 'cheque' ? `Dated ${dayText(p.chequeDate)}` : dayText(p.receivedOn)}{p.countedOn && p.mode === 'cheque' ? ` · deposited ${dayText(p.countedOn)}` : ''}</td>
      <td className="px-2 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS[p.status]?.cls ?? ''}`}>{STATUS[p.status]?.label ?? p.status}</span></td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{canRecord && actions}</td>
    </tr>
  )
  const btn = (label: string, onClick: () => void, danger = false) => (
    <button type="button" onClick={onClick} className={`ml-1 rounded-lg border px-2.5 py-1 text-xs font-semibold ${danger ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30' : 'border-border hover:bg-muted'}`}>{label}</button>
  )
  const head = (
    <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
      <tr><th className="px-3 py-2 text-left font-semibold">Receipt</th><th className="px-2 py-2 text-left font-semibold">Party</th><th className="px-2 py-2 text-right font-semibold">Amount</th>
        <th className="px-2 py-2 text-left font-semibold">How</th><th className="px-2 py-2 text-left font-semibold">Date</th><th className="px-2 py-2 text-left font-semibold">Status</th><th /></tr>
    </thead>
  )
  return (
    <div className="space-y-4">
      <label className="sr-only" htmlFor="pay-q">Search payments</label>
      <input id="pay-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search party, receipt or cheque no.…" className={`${inputCls} w-full`} />
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      {msg && <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">{msg}</p>}
      {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <section aria-labelledby="pend-h">
            <h2 id="pend-h" className="mb-2 text-sm font-semibold">{`Cheques to deposit (${data.pending.length}) · ${formatRs(data.pending.reduce((s, p) => s + p.amountPaise, 0))}`}</h2>
            <div ref={pendRef} className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[760px] text-sm">{head}<tbody className="divide-y divide-border">
                {data.pending.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No cheques waiting.</td></tr>}
                {data.pending.map((p) => row(p, <>{btn('Deposit', () => setAct({ kind: 'deposit', p }))}{btn('Return', () => setAct({ kind: 'return', p }), true)}</>))}
              </tbody></table>
            </div>
          </section>
          <section aria-labelledby="rec-h">
            <h2 id="rec-h" className="mb-2 text-sm font-semibold">Payments in the last 60 days</h2>
            <div ref={recRef} className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[760px] text-sm">{head}<tbody className="divide-y divide-border">
                {data.recent.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No payments yet.</td></tr>}
                {data.recent.map((p) => row(p, p.status === 'active' ? <>
                  {p.mode === 'cheque' && btn('Bounced', () => setAct({ kind: 'bounce', p }), true)}
                  {btn('Reverse', () => setAct({ kind: 'reverse', p }), true)}</> : null))}
              </tbody></table>
            </div>
          </section>
        </>
      )}
      {act && <PaymentActionDialog kind={act.kind} p={act.p} onClose={() => setAct(null)}
        onDone={(text) => { setAct(null); setMsg(text); onChanged() }} />}
    </div>
  )
}

const ACTION_TITLE: Record<ActionKind, string> = { deposit: 'Cheque deposited', return: 'Cheque given back', bounce: 'Cheque bounced', reverse: 'Reverse payment' }

function PaymentActionDialog({ kind, p, onClose, onDone }: { kind: ActionKind; p: PaymentRow; onClose: () => void; onDone: (text: string) => void }) {
  const [date, setDate] = useState(istToday())
  const [reason, setReason] = useState('')
  const [charge, setCharge] = useState('')
  const [err, setErr] = useState('')
  const [busy, start] = useTransition()
  function go() {
    setErr('')
    let chargePaise = 0
    if (kind === 'bounce' && charge.trim()) {
      try { chargePaise = toPaise(charge.replace(/,/g, '').trim()) } catch { setErr('The bounce charge is not a number.'); return }
    }
    start(async () => {
      try {
        if (kind === 'deposit') { const r = await depositChequeAction(p.paymentId, date); onDone(`${p.receiptNo} deposited: ${formatRs(r.allocatedPaise)} set against bills. Balance now ${formatRs(r.party.balancePaise)}.`) }
        else if (kind === 'return') { await returnChequeAction(p.paymentId, reason); onDone(`${p.receiptNo}: cheque marked given back (never counted).`) }
        else if (kind === 'bounce') { const r = await bouncePaymentAction(p.paymentId, reason, chargePaise); onDone(`${p.receiptNo} bounced. Balance now ${formatRs(r.party.balancePaise)}.`) }
        else { const r = await reversePaymentAction(p.paymentId, reason); onDone(`${p.receiptNo} reversed. Balance now ${formatRs(r.party.balancePaise)}.`) }
      } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') }
    })
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <DialogKeys onClose={onClose} label={ACTION_TITLE[kind]} />
      <form role="dialog" aria-modal="true" aria-labelledby="pa-title" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); go() }}
        className="w-full space-y-4 rounded-t-3xl bg-background p-5 shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div>
          <h2 id="pa-title" className="text-lg font-bold">{ACTION_TITLE[kind]}</h2>
          <p className="text-sm text-muted-foreground"><span data-no-translate>{p.partyName}</span>{` · ${p.receiptNo} · ${formatRs(p.amountPaise)}${p.chequeNo ? ` · cheque ${p.chequeNo}` : ''}`}</p>
        </div>
        {kind === 'deposit' ? (
          <>
            <label className="block text-xs font-medium text-muted-foreground">Deposit date
              <input type="date" autoFocus value={date} max={istToday()} onChange={(e) => setDate(e.target.value)} className={`${inputCls} mt-1 w-full`} />
            </label>
            <p className="text-xs text-muted-foreground">Counted from this date and set against the oldest unpaid bills.</p>
          </>
        ) : (
          <>
            <label className="block text-xs font-medium text-muted-foreground">Reason
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={`${inputCls} mt-1 w-full`}
                placeholder={kind === 'bounce' ? 'e.g. insufficient funds' : kind === 'return' ? 'e.g. party took it back' : 'e.g. wrong party'} />
            </label>
            {kind === 'bounce' && (
              <label className="block text-xs font-medium text-muted-foreground">Bounce charge to the party (₹, optional)
                <input inputMode="decimal" value={charge} onChange={(e) => setCharge(e.target.value)} className={`${inputCls} mt-1 w-full`} />
              </label>
            )}
            {kind !== 'return' && <p className="text-xs text-muted-foreground">The money comes off: the bills it paid are unpaid again.</p>}
          </>
        )}
        {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold hover:bg-muted">Cancel</button>
          <button type="submit" data-primary {...(kind !== 'deposit' ? { 'data-destructive': true } : {})} disabled={busy || (kind !== 'deposit' && !reason.trim())}
            className={`flex-1 rounded-xl py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${kind === 'deposit' ? 'bg-primary' : 'bg-red-600 hover:bg-red-700'}`}>
            {busy ? 'Saving…' : ACTION_TITLE[kind]}
          </button>
        </div>
      </form>
    </div>
  )
}

// ── Party statement ───────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  bill: 'Bill', payment: 'Payment', opening: 'Opening balance', discount: 'Early-payment discount', charge: 'Charge', adjustment: 'Adjustment', reversal: 'Reversal', credit_note: 'Credit note',
}

function StatementTab({ parties, party, onParty, version }: { parties: PartyChoice[]; party: PartyChoice | null; onParty: (p: PartyChoice | null) => void; version: number }) {
  const today = istToday()
  const [from, setFrom] = useState(fyStart(today))
  const [to, setTo] = useState(today)
  const [st, setSt] = useState<Statement | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!party) { setSt(null); return }
    let live = true
    setLoading(true); setErr('')
    getJson<Statement>(`/api/payments?view=statement&party=${encodeURIComponent(party.id)}&from=${from}&to=${to}`)
      .then((d) => { if (live) setSt(d) }).catch((e) => { if (live) { setSt(null); setErr(e instanceof Error ? e.message : 'Could not load.') } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [party, from, to, version])

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <PartyPicker parties={parties} value={party} onChange={onParty} autoFocus={!party} />
        <label className="block text-xs font-medium text-muted-foreground">From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} mt-1 h-11 w-full`} />
        </label>
        <label className="block text-xs font-medium text-muted-foreground">To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={`${inputCls} mt-1 h-11 w-full`} />
        </label>
      </div>
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      {loading && <p className="text-sm text-muted-foreground" aria-live="polite">Loading…</p>}
      {!party && <p className="py-8 text-center text-sm text-muted-foreground">Choose a party to see its statement.</p>}
      {st && !loading && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-sm">{'Balance now '}<b className="tabular-nums">{formatRs(st.balanceNowPaise)}</b>
              {st.pendingCheques.length > 0 && <span className="ml-3 text-amber-700 dark:text-amber-300">{`${st.pendingCheques.length} cheque(s) received, not deposited: ${formatRs(st.pendingCheques.reduce((s, c) => s + c.amountPaise, 0))}`}</span>}</p>
            <button type="button" onClick={() => void printStatement(st)} className="h-10 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">Print</button>
            {st.party.phone && <a href={whatsappLink(st.party.phone, statementText(st))} target="_blank" rel="noreferrer" className="flex h-10 items-center rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">WhatsApp</a>}
          </div>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-3 py-2 text-left font-semibold">Date</th><th className="px-2 py-2 text-left font-semibold">Particulars</th><th className="px-2 py-2 text-left font-semibold">Ref.</th>
                  <th className="px-2 py-2 text-right font-semibold">Debit</th><th className="px-2 py-2 text-right font-semibold">Credit</th><th className="px-3 py-2 text-right font-semibold">Balance</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr className="bg-muted/10"><td className="px-3 py-1.5 text-xs">{dayText(st.from)}</td><td className="px-2 py-1.5 font-medium" colSpan={4}>Opening balance</td><td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{formatRs(st.openingPaise)}</td></tr>
                {st.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-1.5 text-xs">{dayText(e.entryDate)}</td>
                    <td className="px-2 py-1.5">{KIND_LABEL[e.kind] ?? e.kind}{e.mode ? ` (${e.mode.toUpperCase()}${e.chequeNo ? ` ${e.chequeNo}` : ''})` : ''}
                      {e.reason && <span className="block text-[11px] text-muted-foreground">{e.reason}</span>}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{e.refNo}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{e.amountPaise > 0 ? formatRs(e.amountPaise) : ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{e.amountPaise < 0 ? formatRs(-e.amountPaise) : ''}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums whitespace-nowrap">{formatRs(e.runningPaise)}</td>
                  </tr>
                ))}
                <tr className="bg-muted/20"><td className="px-3 py-2" /><td className="px-2 py-2 font-bold" colSpan={4}>Closing balance</td><td className="px-3 py-2 text-right font-bold tabular-nums whitespace-nowrap">{formatRs(st.closingPaise)}</td></tr>
              </tbody>
            </table>
          </div>
          {st.truncated && <p className="text-xs text-amber-700 dark:text-amber-300">Only the first 1,000 entries are shown — choose a shorter period.</p>}
          {st.unpaid.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <p className="border-b border-border bg-muted/30 px-3 py-2 text-sm font-semibold">Unpaid now</p>
              <table className="w-full text-sm"><tbody className="divide-y divide-border">
                {st.unpaid.map((u, i) => (
                  <tr key={`${u.refNo}-${i}`}><td className="px-3 py-1.5 font-mono text-xs">{u.refNo || KIND_LABEL[u.kind]}</td><td className="px-2 py-1.5 text-xs">{dayText(u.entryDate)}</td>
                    <td className={`px-2 py-1.5 text-right text-xs ${u.days > 90 ? 'font-semibold text-red-600 dark:text-red-400' : ''}`}>{`${u.days} day${u.days === 1 ? "" : "s"}`}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">{formatRs(u.amountPaise)}</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">{formatRs(u.openPaise)}</td></tr>
                ))}
              </tbody></table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
