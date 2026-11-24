'use client'

// Payments → Opening balances (payments step 6): what parties owed (or had paid in advance) before the
// app, entered as of go-live. One at a time, or an Excel / CSV upload with a preview (nothing is saved
// until "Save"). Uploading the same file again adds nothing twice. A wrong row is reversed with a reason.

import { useEffect, useRef, useState, useTransition } from 'react'
import { DialogKeys } from '@/components/dialog-keys'
import { useListKeys } from '@/lib/shortcuts/list'
import { formatRs } from '@/lib/billing/bill-amounts'
import { toPaise } from '@/lib/billing/bill-totals'
import { addOpeningBalance, previewOpeningUpload, reverseOpeningAction, saveOpeningUpload } from '@/app/actions/payments'
import type { OpeningListRow, OpeningPlan } from '@/lib/payments/opening'
import type { PartyChoice } from '@/lib/payments/queries'
import { PartyPicker } from './party-picker'
import { dayText, istToday } from './print'

const inputCls = 'mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
const TEMPLATE = 'Party,Date,Amount,Dr/Cr,Old bill no,Note\nOm Shoes,01/04/2026,12000,Dr,A-101,\nDelhi Traders,01/04/2026,500,Cr,,advance paid\n'

export function OpeningTab({ parties, canRecord, onChanged }: { parties: PartyChoice[]; canRecord: boolean; onChanged: () => void }) {
  const [list, setList] = useState<{ rows: OpeningListRow[]; owedPaise: number; advancePaise: number; count: number } | null>(null)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [reload, setReload] = useState(0)
  const [rev, setRev] = useState<OpeningListRow | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useListKeys(listRef, { label: 'Opening balances' })

  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`/api/payments?view=openings&q=${encodeURIComponent(q)}`, { cache: 'no-store' })
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not load.'); setList(j); setErr('') })
        .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.'))
    }, list ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, reload]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = (text: string) => { setMsg(text); setReload((n) => n + 1); onChanged() }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        What each party owed — or had paid in advance — <b>before</b> this app, as of the day you start using it. One row per party
        (a lump sum), or one row per old bill with its bill number. Advance is set against what the party owes, oldest first.
      </p>
      {msg && <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">{msg}</p>}
      {canRecord && (
        <div className="grid gap-4 lg:grid-cols-2">
          <AddOne parties={parties} onDone={done} />
          <Upload onDone={done} />
        </div>
      )}
      <section aria-labelledby="ob-list-h" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="ob-list-h" className="flex-1 text-sm font-semibold">
            {list ? `Entered: ${list.count} row(s) · owed ${formatRs(list.owedPaise)} · advance ${formatRs(list.advancePaise)}` : 'Entered'}
          </h2>
          <label className="sr-only" htmlFor="ob-q">Search opening balances</label>
          <input id="ob-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search party or bill no.…" className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm sm:w-72" />
        </div>
        {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div ref={listRef} className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-3 py-2 text-left font-semibold">Party</th><th className="px-2 py-2 text-left font-semibold">Date</th><th className="px-2 py-2 text-left font-semibold">Old bill no.</th>
                <th className="px-2 py-2 text-right font-semibold">Owes</th><th className="px-2 py-2 text-right font-semibold">Advance</th><th className="px-2 py-2 text-left font-semibold">Entered by</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list && list.rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No opening balances yet.</td></tr>}
              {list?.rows.map((r) => (
                <tr key={r.entryId} data-list-row className={r.reversed ? 'text-muted-foreground line-through decoration-1' : ''}>
                  <td className="px-3 py-2 font-medium" data-no-translate>{r.partyName}{r.note && r.note !== 'Opening balance' && <span className="block text-[11px] font-normal text-muted-foreground no-underline">{r.note}</span>}</td>
                  <td className="px-2 py-2 text-xs">{dayText(r.entryDate)}</td>
                  <td className="px-2 py-2 font-mono text-xs">{r.refNo || '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{r.amountPaise > 0 ? formatRs(r.amountPaise) : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{r.amountPaise < 0 ? formatRs(-r.amountPaise) : ''}</td>
                  <td className="px-2 py-2 text-xs">{r.createdByName}</td>
                  <td className="px-3 py-2 text-right">
                    {r.reversed ? <span className="text-xs no-underline">Reversed</span>
                      : canRecord && <button type="button" data-row-open onClick={() => setRev(r)} className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30">Reverse</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {rev && <ReverseDialog row={rev} onClose={() => setRev(null)} onDone={(t) => { setRev(null); done(t) }} />}
    </div>
  )
}

function AddOne({ parties, onDone }: { parties: PartyChoice[]; onDone: (t: string) => void }) {
  const [party, setParty] = useState<PartyChoice | null>(null)
  const [date, setDate] = useState(istToday())
  const [amount, setAmount] = useState('')
  const [side, setSide] = useState<'owes' | 'advance'>('owes')
  const [billNo, setBillNo] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, start] = useTransition()
  function save() {
    setErr('')
    let paise = 0
    try { paise = toPaise(amount.replace(/,/g, '').trim()) } catch { setErr('Type the amount.'); return }
    if (!party) { setErr('Choose the party.'); return }
    if (paise <= 0) { setErr('Type the amount.'); return }
    start(async () => {
      try {
        const r = await addOpeningBalance({ retailerId: party.id, date, amountPaise: side === 'owes' ? paise : -paise, billNo, note })
        onDone(`${party.name}: opening ${side === 'owes' ? 'balance' : 'advance'} ${formatRs(paise)} saved${r.matchedPaise ? ` (${formatRs(r.matchedPaise)} matched with advance / dues)` : ''}.`)
        setParty(null); setAmount(''); setBillNo(''); setNote('')
      } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') }
    })
  }
  return (
    <form data-form onSubmit={(e) => { e.preventDefault(); save() }} className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="ob-one-h">
      <h3 id="ob-one-h" className="text-sm font-semibold">Add one</h3>
      <PartyPicker parties={parties} value={party} onChange={setParty} />
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs font-medium text-muted-foreground">As on date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
        </label>
        <label className="block text-xs font-medium text-muted-foreground">Amount (₹)
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputCls} tabular-nums`} />
        </label>
      </div>
      <div role="radiogroup" aria-label="Owes or advance" className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {(['owes', 'advance'] as const).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={side === s} tabIndex={side === s ? 0 : -1} onClick={() => setSide(s)}
            onKeyDown={(e) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const n = s === 'owes' ? 'advance' : 'owes'; setSide(n); (e.currentTarget.parentElement?.querySelector(`[data-side="${n}"]`) as HTMLElement | null)?.focus() } }}
            data-side={s}
            className={`h-9 rounded-lg text-sm font-semibold ${side === s ? (s === 'owes' ? 'bg-primary text-primary-foreground' : 'bg-emerald-600 text-white') : 'text-muted-foreground hover:bg-background'}`}>
            {s === 'owes' ? 'Party owes us' : 'Advance (we hold)'}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs font-medium text-muted-foreground">Old bill no. (optional)
          <input value={billNo} onChange={(e) => setBillNo(e.target.value)} maxLength={40} className={inputCls} />
        </label>
        <label className="block text-xs font-medium text-muted-foreground">Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={inputCls} />
        </label>
      </div>
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      <button type="submit" data-primary disabled={busy} className="h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {busy ? 'Saving…' : 'Save opening balance'}
      </button>
    </form>
  )
}

function Upload({ onDone }: { onDone: (t: string) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [plan, setPlan] = useState<OpeningPlan | null>(null)
  const [err, setErr] = useState('')
  const [busy, start] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)
  const form = () => { const f = new FormData(); f.set('file', file!); return f }
  function preview(f: File) {
    setFile(f); setPlan(null); setErr('')
    const fd = new FormData(); fd.set('file', f)
    start(async () => {
      try {
        const p = await previewOpeningUpload(fd)
        if (p.missingColumns.length) setErr(`Missing column(s): ${p.missingColumns.join(', ')}. The first row must hold the column names (see the template).`)
        else if (!p.rows.length) setErr('No rows found below the header row.')
        setPlan(p)
      } catch (e) { setErr(e instanceof Error ? e.message : 'The file could not be read.') }
    })
  }
  function save() {
    if (!file || !plan?.ok) return
    start(async () => {
      try {
        const r = await saveOpeningUpload(form())
        onDone(`Upload saved: ${r.added} row(s) — owed ${formatRs(r.owedPaise)}, advance ${formatRs(r.advancePaise)}${r.matchedPaise ? `, ${formatRs(r.matchedPaise)} matched` : ''}.`)
        setFile(null); setPlan(null); if (fileRef.current) fileRef.current.value = ''
      } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') }
    })
  }
  function template() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'opening-balances.csv'; a.click(); URL.revokeObjectURL(url)
  }
  const STATUS: Record<string, string> = { ok: 'text-emerald-700 dark:text-emerald-300', duplicate: 'text-muted-foreground', error: 'text-red-600 dark:text-red-400' }
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="ob-up-h">
      <div className="flex items-center gap-2">
        <h3 id="ob-up-h" className="flex-1 text-sm font-semibold">Upload Excel / CSV</h3>
        <button type="button" onClick={template} className="text-xs font-semibold text-primary underline">Download template</button>
      </div>
      <p className="text-xs text-muted-foreground">
        Columns: <b>Party</b> (name as in Master → Retailers, or <b>Party code</b>), <b>Date</b> (DD/MM/YYYY), <b>Amount</b>; optional
        <b> Dr/Cr</b> (Cr = advance; or a minus amount), <b>Old bill no</b>, <b>Note</b>. Nothing is saved until you press Save.
      </p>
      <input ref={fileRef} type="file" accept=".xlsx,.csv" aria-label="Opening balances file"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) preview(f) }}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-semibold" />
      {busy && !plan && <p className="text-sm text-muted-foreground" aria-live="polite">Reading the file…</p>}
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      {plan && plan.rows.length > 0 && (
        <>
          <p className="text-sm" aria-live="polite">
            <b className="text-emerald-700 dark:text-emerald-300">{`${plan.ok} to add`}</b>{` (owed ${formatRs(plan.owedPaise)}, advance ${formatRs(plan.advancePaise)})`}
            {plan.duplicates > 0 && <span className="text-muted-foreground">{` · ${plan.duplicates} already entered`}</span>}
            {plan.errors > 0 && <span className="text-red-600 dark:text-red-400">{` · ${plan.errors} with problems (not saved)`}</span>}
          </p>
          <div className="max-h-72 overflow-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 whitespace-nowrap bg-card text-muted-foreground"><tr><th className="px-2 py-1 text-left">Row</th><th className="px-2 py-1 text-left">Party</th><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1 text-left">Bill</th><th className="px-2 py-1 text-left">Status</th></tr></thead>
              <tbody className="divide-y divide-border">
                {plan.rows.map((r) => (
                  <tr key={r.rowNumber}>
                    <td className="px-2 py-1 tabular-nums">{r.rowNumber}</td>
                    <td className="px-2 py-1" data-no-translate>{r.partyName ?? r.party ?? r.partyId}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.date ? dayText(r.date) : "—"}</td>
                    <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{r.amountPaise < 0 ? `${formatRs(-r.amountPaise)} adv.` : formatRs(r.amountPaise)}</td>
                    <td className="px-2 py-1 font-mono whitespace-nowrap">{r.billNo}</td>
                    <td className={`px-2 py-1 ${STATUS[r.status]}`}>{r.status === 'ok' ? 'Add' : r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" data-primary onClick={save} disabled={busy || !plan.ok}
            className="h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {busy ? 'Saving…' : `Save ${plan.ok} row(s)`}
          </button>
        </>
      )}
    </section>
  )
}

function ReverseDialog({ row, onClose, onDone }: { row: OpeningListRow; onClose: () => void; onDone: (t: string) => void }) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, start] = useTransition()
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <DialogKeys onClose={onClose} label="Reverse opening balance" />
      <form role="dialog" aria-modal="true" aria-labelledby="ob-rev-h" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); start(async () => { try { await reverseOpeningAction(row.entryId, reason); onDone(`${row.partyName}: opening balance ${row.refNo || ''} reversed.`) } catch (x) { setErr(x instanceof Error ? x.message : 'Not saved.') } }) }}
        className="w-full space-y-4 rounded-t-3xl bg-background p-5 shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div>
          <h2 id="ob-rev-h" className="text-lg font-bold">Reverse opening balance</h2>
          <p className="text-sm text-muted-foreground"><span data-no-translate>{row.partyName}</span>{` · ${dayText(row.entryDate)} · ${row.amountPaise < 0 ? `advance ${formatRs(-row.amountPaise)}` : formatRs(row.amountPaise)}${row.refNo ? ` · ${row.refNo}` : ''}`}</p>
        </div>
        <label className="block text-xs font-medium text-muted-foreground">Reason
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. typed twice, wrong party" className={inputCls} />
        </label>
        {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold hover:bg-muted">Cancel</button>
          <button type="submit" data-primary data-destructive disabled={busy || !reason.trim()} className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Reverse'}
          </button>
        </div>
      </form>
    </div>
  )
}
