'use client'

// Payments → Credit notes (owner, 24 Nov 2026; migration 0018). A money note (discount / rate
// difference: amount before GST, GST added at the bill's rates) or goods returned (scan the boxes of
// the bill; they go back into stock). Against a bill, or (money only) none. Numbers CN1, CN2 …
// Keyboard: n on this tab opens New credit note; Ctrl+Enter saves; the Scan box takes a scanner.

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { DialogKeys } from '@/components/dialog-keys'
import { useShortcut } from '@/lib/shortcuts'
import { useListKeys } from '@/lib/shortcuts/list'
import { formatRs, TAX_TYPE_LABEL, TAX_TYPE_SHORT } from '@/lib/billing/bill-amounts'
import { DEFAULT_BILL_RATES, billRatesFor, computeBillTotals, ratesBp, toPaise, type TaxType } from '@/lib/billing/bill-totals'
import { cancelCreditNoteAction, checkReturnBoxAction, createCreditNoteAction, getCreditNotePrint, getPartyBills } from '@/app/actions/payments'
import { moneyNoteTotals } from '@/lib/payments/credit-note-math'
import type { CreditNoteRow, PartyBill, ReturnBox } from '@/lib/payments/credit-notes'
import type { PartyChoice } from '@/lib/payments/queries'
import { PartyPicker } from './party-picker'
import { dayText, istToday, printCreditNote } from './print'

const inputCls = 'mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
const REASONS = ['Rate difference', 'Discount after bill', 'Damaged goods returned', 'Wrong goods returned', 'Goods not ordered']

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function CreditNotesTab({ parties, canRecord, onChanged }: { parties: PartyChoice[]; canRecord: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<CreditNoteRow[] | null>(null)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(false)
  const [cancelRow, setCancelRow] = useState<CreditNoteRow | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useListKeys(listRef, { label: 'Credit notes' })
  useShortcut('n', () => setOpen(true), { label: 'New credit note', group: 'Credit notes', enabled: canRecord && !open, within: listRef })
  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`/api/payments?view=creditnotes&q=${encodeURIComponent(q)}`, { cache: 'no-store' })
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not load.'); setRows(j); setErr('') })
        .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.'))
    }, rows ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, reload]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = (text: string) => { setMsg(text); setReload((n) => n + 1); onChanged() }
  const print = async (id: number) => { const p = await getCreditNotePrint(id); if (p) await printCreditNote(p) }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted-foreground">Money given back after a bill (discount, rate difference) or goods returned. It reduces what the party owes.</p>
        {canRecord && <button type="button" onClick={() => setOpen(true)} className="h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">+ New credit note</button>}
      </div>
      {msg && <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">{msg}</p>}
      <label className="sr-only" htmlFor="cn-q">Search credit notes</label>
      <input id="cn-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search party, note or bill no.…" className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      <div ref={listRef} className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-3 py-2 text-left font-semibold">Note</th><th className="px-2 py-2 text-left font-semibold">Date</th><th className="px-2 py-2 text-left font-semibold">Party</th>
              <th className="px-2 py-2 text-left font-semibold">Against</th><th className="px-2 py-2 text-left font-semibold">For</th><th className="px-2 py-2 text-right font-semibold">Credit</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows && rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No credit notes yet.</td></tr>}
            {rows?.map((r) => (
              <tr key={r.id} data-list-row className={r.status !== 'active' ? 'text-muted-foreground line-through decoration-1' : ''}>
                <td className="px-3 py-2 font-mono text-xs font-semibold">{r.noteNo}</td>
                <td className="px-2 py-2 text-xs whitespace-nowrap">{dayText(r.noteDate)}</td>
                <td className="px-2 py-2 font-medium" data-no-translate>{r.partyName}</td>
                <td className="px-2 py-2 font-mono text-xs">{r.billNo ? `Bill ${r.billNo}` : '—'}</td>
                <td className="px-2 py-2 text-xs">{r.kind === 'return' ? `Goods returned (${r.totalQty} pairs)` : 'Money'} · {r.reason}</td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums whitespace-nowrap">{formatRs(r.totalPaise)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button type="button" data-row-open onClick={() => void print(r.id)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted">Print</button>
                  {canRecord && r.status === 'active' && r.kind === 'money' && (
                    <button type="button" onClick={() => setCancelRow(r)} className="ml-1 rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30">Cancel</button>
                  )}
                  {r.status !== 'active' && <span className="ml-2 text-xs no-underline">Cancelled</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <NewCreditNote parties={parties} onClose={() => setOpen(false)} onSaved={(t) => done(t)} onPrint={print} />}
      {cancelRow && <CancelDialog row={cancelRow} onClose={() => setCancelRow(null)} onDone={(t) => { setCancelRow(null); done(t) }} />}
    </div>
  )
}

function NewCreditNote({ parties, onClose, onSaved, onPrint }: { parties: PartyChoice[]; onClose: () => void; onSaved: (t: string) => void; onPrint: (id: number) => Promise<void> }) {
  const [party, setParty] = useState<PartyChoice | null>(null)
  const [bills, setBills] = useState<PartyBill[] | null>(null)
  const [billId, setBillId] = useState<number | 'none' | ''>('')
  const [kind, setKind] = useState<'money' | 'return'>('money')
  const [date, setDate] = useState(istToday())
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')
  const [taxType, setTaxType] = useState<TaxType>('intra_state')
  const [boxes, setBoxes] = useState<ReturnBox[]>([])
  const [scan, setScan] = useState('')
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState<{ id: number; noteNo: string; total: number; balance: number } | null>(null)
  const [busy, start] = useTransition()
  const clientId = useRef(uuid())
  const scanRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setBills(null); setBillId(''); setBoxes([])
    if (!party) return
    let live = true
    getPartyBills(party.id).then((b) => { if (live) setBills(b) }).catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load the bills.') })
    return () => { live = false }
  }, [party])
  const bill = typeof billId === 'number' ? bills?.find((b) => b.saleBillId === billId) ?? null : null
  useEffect(() => { if (bill) setTaxType(bill.taxType); setBoxes([]) }, [billId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (kind === 'return' && billId === 'none') setBillId('') }, [kind, billId])

  const amountPaise = (() => { try { const p = toPaise(amount.replace(/,/g, '').trim() || 'x'); return p > 0 ? p : null } catch { return null } })()
  const preview = useMemo(() => {
    if (kind === 'money') {
      if (!amountPaise) return null
      return moneyNoteTotals(amountPaise, bill ? bill.taxType : taxType, bill ? bill.rates : billRatesFor(taxType, DEFAULT_BILL_RATES))
    }
    if (!bill || !boxes.length) return null
    const m = new Map<string, { mrp: number; qty: number }>()
    for (const b of boxes) { const k = `${b.articleCode}__${b.mrp}`; const c = m.get(k); if (c) c.qty++; else m.set(k, { mrp: b.mrp, qty: 1 }) }
    const t = computeBillTotals([...m.values()], bill.lineDiscPct, bill.taxType, ratesBp(bill.rates))
    return { taxablePaise: t.taxablePaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise, roundOffPaise: t.roundOffPaise, totalPaise: t.grandTotalPaise }
  }, [kind, amountPaise, bill, taxType, boxes])

  function addBox() {
    const raw = scan.trim()
    if (!raw || !bill) return
    setScan(''); setErr('')
    checkReturnBoxAction(bill.saleBillId, raw)
      .then((b) => setBoxes((prev) => (prev.some((x) => x.dedupeKey === b.dedupeKey) ? (setErr('This box is already on this note.'), prev) : [...prev, b])))
      .catch((e) => setErr(e instanceof Error ? e.message : 'Box not accepted.'))
      .finally(() => scanRef.current?.focus())
  }

  const problem = !party ? 'Choose the party.' : billId === '' ? 'Choose the bill (or "No bill").' : !reason.trim() ? 'Type the reason.'
    : kind === 'money' ? (!amountPaise ? 'Type the amount before GST.' : '') : (!boxes.length ? 'Scan the boxes that came back.' : '')
  function save() {
    if (problem || !party) { setErr(problem); return }
    setErr('')
    start(async () => {
      try {
        const r = await createCreditNoteAction({
          clientId: clientId.current, retailerId: party.id, noteDate: date, kind, reason,
          saleBillId: typeof billId === 'number' ? billId : null, taxablePaise: amountPaise ?? undefined, taxType, boxes: boxes.map((b) => b.raw),
        })
        setSaved({ id: r.creditNoteId, noteNo: r.noteNo, total: r.totals.totalPaise, balance: r.party.balancePaise })
        onSaved(`Credit note ${r.noteNo} saved for ${party.name}: ${formatRs(r.totals.totalPaise)}.`)
      } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved. Try again — it will not be saved twice.') }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <DialogKeys onClose={onClose} label="New credit note" />
      <section role="dialog" aria-modal="true" aria-label="New credit note" onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <h2 className="flex-1 text-lg font-bold">New credit note</h2>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">Ctrl+Enter saves · Esc closes</span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-muted">✕</button>
        </div>
        {saved ? (
          <div className="flex-1 space-y-4 p-4 sm:p-5">
            <div role="status" className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
              <p className="text-sm text-emerald-900 dark:text-emerald-200">Credit note saved</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{`${saved.noteNo} · ${formatRs(saved.total)}`}</p>
              <p className="mt-1 text-sm">{`Balance now ${formatRs(saved.balance)}`}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" data-primary onClick={() => void onPrint(saved.id)} className="h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">Print credit note</button>
              <button type="button" onClick={onClose} className="h-11 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">Close</button>
            </div>
          </div>
        ) : (
          <form className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5" onSubmit={(e) => { e.preventDefault(); save() }}>
            <PartyPicker parties={parties} value={party} onChange={setParty} autoFocus />
            <div role="radiogroup" aria-label="Credit for" className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-muted/40 p-1">
              {(['money', 'return'] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} tabIndex={kind === k ? 0 : -1} data-kind={k} onClick={() => setKind(k)}
                  onKeyDown={(e) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const n = k === 'money' ? 'return' : 'money'; setKind(n); (e.currentTarget.parentElement?.querySelector(`[data-kind="${n}"]`) as HTMLElement | null)?.focus() } }}
                  className={`h-9 rounded-lg text-sm font-semibold ${kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background'}`}>
                  {k === 'money' ? 'Money (discount / rate)' : 'Goods returned'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-3">
              <label className="block text-xs font-medium text-muted-foreground">Against bill
                <select value={billId} onChange={(e) => setBillId(e.target.value === 'none' ? 'none' : e.target.value === '' ? '' : Number(e.target.value))} disabled={!bills} className={inputCls}>
                  <option value="">{party ? (bills ? '— Choose the bill —' : 'Loading…') : 'Choose the party first'}</option>
                  {kind === 'money' && <option value="none">No bill (e.g. year-end discount)</option>}
                  {bills?.map((b) => <option key={b.saleBillId} value={b.saleBillId}>{`${b.billNo} · ${dayText(b.billDate)} · ${formatRs(b.grandTotalPaise)}${b.unpaidPaise > 0 ? ` · ${formatRs(b.unpaidPaise)} unpaid` : ' · paid'}`}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium text-muted-foreground">Date
                <input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value)} className={inputCls} />
              </label>
            </div>
            {bill && <p className="text-xs text-muted-foreground">{`Bill type ${TAX_TYPE_SHORT[bill.taxType]}: GST at the bill's rates.`}</p>}
            <label className="block text-xs font-medium text-muted-foreground">Reason
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} list="cn-reasons" className={inputCls} placeholder="e.g. Rate difference" />
              <datalist id="cn-reasons">{REASONS.map((r) => <option key={r} value={r} />)}</datalist>
            </label>

            {kind === 'money' ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-muted-foreground">Amount before GST (₹)
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputCls} text-base font-semibold tabular-nums`} />
                </label>
                {billId === 'none' && (
                  <label className="block text-xs font-medium text-muted-foreground">Bill type (GST)
                    <select value={taxType} onChange={(e) => setTaxType(e.target.value as TaxType)} className={inputCls}>
                      {(Object.keys(TAX_TYPE_LABEL) as TaxType[]).map((t) => <option key={t} value={t}>{TAX_TYPE_LABEL[t]}</option>)}
                    </select>
                  </label>
                )}
              </div>
            ) : bill ? (
              <div className="space-y-2">
                <label htmlFor="cn-scan" className="text-xs font-medium text-muted-foreground">Scan each box that came back (must be on bill {bill.billNo})</label>
                <input id="cn-scan" ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} autoFocus autoComplete="off" spellCheck={false}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBox() } }}
                  placeholder="Scan a box, or type its code + Enter" className={`${inputCls} font-mono`} />
                {boxes.length > 0 && (
                  <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                    {boxes.map((b) => (
                      <li key={b.dedupeKey} className="flex items-center gap-2 px-3 py-1.5">
                        <span className="flex-1 font-mono text-xs" data-no-translate>{b.articleCode}</span>
                        <span className="tabular-nums text-xs">{`MRP ₹${b.mrp.toFixed(2)}`}</span>
                        <button type="button" onClick={() => setBoxes((p) => p.filter((x) => x.dedupeKey !== b.dedupeKey))} className="text-xs font-semibold text-red-600 hover:underline">Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-[11px] text-muted-foreground">Each box goes back into stock when the note is saved.</p>
              </div>
            ) : <p className="text-sm text-muted-foreground">Choose the bill the goods were sold on, then scan the boxes.</p>}

            {preview && (
              <dl className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-muted/20 px-3 py-2 text-sm tabular-nums">
                <dt className="text-muted-foreground">Amount before GST</dt><dd className="text-right">{formatRs(preview.taxablePaise)}</dd>
                {preview.cgstPaise > 0 && <><dt className="text-muted-foreground">CGST + SGST</dt><dd className="text-right">{formatRs(preview.cgstPaise + preview.sgstPaise)}</dd></>}
                {preview.igstPaise > 0 && <><dt className="text-muted-foreground">IGST</dt><dd className="text-right">{formatRs(preview.igstPaise)}</dd></>}
                {preview.roundOffPaise !== 0 && <><dt className="text-muted-foreground">Round off</dt><dd className="text-right">{formatRs(preview.roundOffPaise)}</dd></>}
                <dt className="font-semibold">Total credit</dt><dd className="text-right font-bold">{formatRs(preview.totalPaise)}</dd>
              </dl>
            )}
            {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
            <div className="sticky bottom-0 -mx-4 border-t border-border bg-card px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:-mx-5 sm:px-5">
              <button type="submit" data-primary disabled={busy || !!problem} className="h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50">
                {busy ? 'Saving…' : `Save credit note${preview ? ` · ${formatRs(preview.totalPaise)}` : ''}`}
              </button>
              {problem && <p className="mt-1 text-center text-[11px] text-muted-foreground">{problem}</p>}
            </div>
          </form>
        )}
      </section>
    </div>
  )
}

function CancelDialog({ row, onClose, onDone }: { row: CreditNoteRow; onClose: () => void; onDone: (t: string) => void }) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, start] = useTransition()
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <DialogKeys onClose={onClose} label="Cancel credit note" />
      <form role="dialog" aria-modal="true" aria-labelledby="cn-cancel-h" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); start(async () => { try { const r = await cancelCreditNoteAction(row.id, reason); onDone(`${r.noteNo} cancelled. Balance now ${formatRs(r.party.balancePaise)}.`) } catch (x) { setErr(x instanceof Error ? x.message : 'Not saved.') } }) }}
        className="w-full space-y-4 rounded-t-3xl bg-background p-5 shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div>
          <h2 id="cn-cancel-h" className="text-lg font-bold">Cancel credit note</h2>
          <p className="text-sm text-muted-foreground">{`${row.noteNo} · `}<span data-no-translate>{row.partyName}</span>{` · ${formatRs(row.totalPaise)}`}</p>
        </div>
        <label className="block text-xs font-medium text-muted-foreground">Reason
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={inputCls} placeholder="e.g. typed the wrong amount" />
        </label>
        <p className="text-xs text-muted-foreground">The party owes this amount again. The number stays used (shown as cancelled).</p>
        {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold hover:bg-muted">Keep it</button>
          <button type="submit" data-primary data-destructive disabled={busy || !reason.trim()} className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Cancel note'}</button>
        </div>
      </form>
    </div>
  )
}
