'use client'

// Record payment (payments step 5). Keyboard: party (type, Enter) → amount → mode (←→) → Ctrl+Enter.
// The money goes to the oldest unpaid bills first, shown as you type; any bill's amount can be
// changed ("Set against"). Parties with an early-payment discount get it pre-filled on bills still
// within their days (editable, untickable — the accountant decides). A cheque is only "received":
// it is set against bills when it is deposited (Payments & cheques tab).

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { DialogKeys } from '@/components/dialog-keys'
import { PartyPicker } from './party-picker'
import { getPartyForPayment, recordPaymentAction } from '@/app/actions/payments'
import { suggestEarlyDiscount } from '@/lib/payments/early-discount'
import { formatRs } from '@/lib/billing/bill-amounts'
import { toPaise } from '@/lib/billing/bill-totals'
import type { PartyForPayment, PayMode, RecordedPayment } from '@/lib/payments/payments'
import type { PartyChoice } from '@/lib/payments/queries'
import { printReceipt, whatsappLink, istToday, dayText } from './print'

const MODES: Array<{ id: PayMode; label: string }> = [
  { id: 'cash', label: 'Cash' }, { id: 'upi', label: 'UPI' }, { id: 'cheque', label: 'Cheque' }, { id: 'bank', label: 'Bank' },
]
const inputCls = 'mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
const smallCls = 'h-8 w-24 rounded-lg border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring'

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
/** Rupees typed → paise; null when not a valid amount. */
function paiseOf(text: string): number | null {
  const t = text.replace(/,/g, '').trim()
  if (!t) return null
  try { const p = toPaise(t); return p >= 0 ? p : null } catch { return null }
}
const rupeesText = (p: number) => (p / 100).toFixed(2).replace(/\.00$/, '')

export interface SavedReceipt extends RecordedPayment {
  partyName: string; phone: string; mode: PayMode; receivedOn: string
  chequeNo?: string; chequeBank?: string; chequeDate?: string; reference?: string
  setAgainst: Array<{ refNo: string; amountPaise: number }>
  discounts: Array<{ refNo: string; amountPaise: number }>
}

export function RecordPayment({ parties, initialPartyId, onClose, onSaved }: {
  parties: PartyChoice[]
  initialPartyId?: string | null
  onClose: () => void
  onSaved: (r: SavedReceipt) => void
}) {
  const [party, setParty] = useState<PartyChoice | null>(() => parties.find((p) => p.id === initialPartyId) ?? null)
  const [data, setData] = useState<PartyForPayment | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<PayMode>('cash')
  const [receivedOn, setReceivedOn] = useState(istToday())
  const [chequeNo, setChequeNo] = useState('')
  const [chequeBank, setChequeBank] = useState('')
  const [chequeDate, setChequeDate] = useState(istToday())
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  /** Typed "set against" amounts per entry; null = oldest first. */
  const [manual, setManual] = useState<Record<number, string> | null>(null)
  /** Early-payment discount per bill (saleBillId): ticked + amount text. */
  const [disc, setDisc] = useState<Record<number, { on: boolean; text: string }>>({})
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<SavedReceipt | null>(null)
  const [saving, startSave] = useTransition()
  const clientId = useRef(uuid())
  const amountRef = useRef<HTMLInputElement>(null)

  // Load the party's unpaid bills (1 query) when a party is chosen.
  useEffect(() => {
    setData(null); setManual(null); setDisc({}); setLoadErr('')
    if (!party) return
    let live = true
    getPartyForPayment(party.id)
      .then((d) => { if (live) { setData(d); setTimeout(() => amountRef.current?.focus(), 0) } })
      .catch((e) => { if (live) setLoadErr(e instanceof Error ? e.message : 'Could not load the party.') })
    return () => { live = false }
  }, [party])

  // Pre-fill the early-payment discount on bills still within the party's days.
  useEffect(() => {
    if (!data?.earlyPayDiscountBp) return
    const next: Record<number, { on: boolean; text: string }> = {}
    for (const o of data.open) {
      if (!o.saleBillId || o.taxablePaise == null) continue
      const s = suggestEarlyDiscount({ discountBp: data.earlyPayDiscountBp, days: data.earlyPayDays }, { taxablePaise: o.taxablePaise, billDate: o.entryDate, openPaise: o.openPaise }, receivedOn)
      next[o.saleBillId] = { on: s > 0, text: s > 0 ? rupeesText(s) : '' }
    }
    setDisc(next)
  }, [data, receivedOn])

  const cheque = mode === 'cheque'
  const amountPaise = paiseOf(amount)
  const plan = useMemo(() => {
    const rows = (data?.open ?? []).map((o) => {
      const t = !cheque && o.saleBillId && disc[o.saleBillId]?.on ? disc[o.saleBillId].text.trim() : ''
      const d = t ? paiseOf(t) : 0
      return { ...o, discountPaise: d ?? -1, left: o.openPaise - Math.max(0, d ?? 0) }
    })
    let rest = cheque ? 0 : amountPaise ?? 0
    const set = rows.map((r) => {
      if (manual) return paiseOf(manual[r.entryId] ?? '') ?? (manual[r.entryId]?.trim() ? -1 : 0)
      const take = Math.max(0, Math.min(r.left, rest)); rest -= take; return take
    })
    return { rows, set }
  }, [data, disc, manual, amountPaise, cheque])

  const discountTotal = plan.rows.reduce((s, r) => s + Math.max(0, r.discountPaise), 0)
  const setTotal = plan.set.reduce((s, v) => s + Math.max(0, v), 0)
  const advance = (amountPaise ?? 0) - setTotal
  const problem = !party ? 'Choose the party.'
    : !data ? (loadErr || 'Loading the party…')
    : amountPaise == null || amountPaise <= 0 ? 'Type the amount received.'
    : cheque && (!chequeNo.trim() || !chequeBank.trim() || !chequeDate) ? 'Type the cheque number, bank and date.'
    : plan.rows.some((r) => r.discountPaise < 0) ? 'A discount amount is not a number.'
    : plan.rows.some((r) => r.discountPaise > r.openPaise) ? 'A discount is more than is unpaid on its bill.'
    : plan.set.some((v) => v < 0) ? 'A "set against" amount is not a number.'
    : plan.set.some((v, i) => v > plan.rows[i].left) ? 'More is set against a bill than is unpaid on it.'
    : setTotal > amountPaise ? 'More is set against bills than the amount received.'
    : ''

  function save() {
    if (problem || !party || !data || amountPaise == null) { setError(problem); return }
    setError('')
    const discounts = cheque ? [] : plan.rows.filter((r) => r.saleBillId && r.discountPaise > 0).map((r) => ({ saleBillId: r.saleBillId!, amountPaise: r.discountPaise }))
    const allocations = cheque || !manual ? [] : plan.rows.map((r, i) => ({ entryId: r.entryId, amountPaise: plan.set[i] })).filter((a) => a.amountPaise > 0)
    const input = {
      clientId: clientId.current, retailerId: party.id, receivedOn, mode, amountPaise,
      chequeNo, chequeBank, chequeDate: cheque ? chequeDate : undefined, reference, note, allocations, discounts,
    }
    startSave(async () => {
      try {
        const r = await recordPaymentAction(input)
        const receipt: SavedReceipt = {
          ...r, partyName: data.partyName, phone: party.phone, mode, receivedOn,
          chequeNo, chequeBank, chequeDate, reference,
          setAgainst: cheque ? [] : plan.rows.map((x, i) => ({ refNo: x.refNo, amountPaise: plan.set[i] })).filter((x) => x.amountPaise > 0),
          discounts: plan.rows.filter((x) => x.discountPaise > 0).map((x) => ({ refNo: x.refNo, amountPaise: x.discountPaise })),
        }
        setSaved(receipt)
        onSaved(receipt)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Not saved. Check the connection and try again — it will not be recorded twice.')
      }
    })
  }

  function another() {
    clientId.current = uuid()
    setSaved(null); setAmount(''); setReference(''); setNote(''); setChequeNo(''); setManual(null); setError('')
    setParty(null)
  }

  const hasDiscount = !!data?.earlyPayDiscountBp && !cheque
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <DialogKeys onClose={onClose} label="Record payment" />
      <section role="dialog" aria-modal="true" aria-label="Record payment" onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <h2 className="flex-1 text-lg font-bold">Record payment</h2>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">Ctrl+Enter saves · Esc closes</span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-muted">✕</button>
        </div>

        {saved ? (
          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
            <div role="status" className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
              <p className="text-sm text-emerald-900 dark:text-emerald-200">{saved.repeated ? 'Already recorded (nothing new saved)' : saved.status === 'pending' ? 'Cheque received — counted when deposited' : 'Payment recorded'}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{`${saved.receiptNo} · ${formatRs(saved.amountPaise)}`}</p>
              <p className="mt-1 text-sm" data-no-translate>{saved.partyName}</p>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Set against bills</dt><dd className="text-right tabular-nums">{formatRs(saved.allocatedPaise)}</dd>
              {saved.discountPaise > 0 && <><dt className="text-muted-foreground">Early-payment discount</dt><dd className="text-right tabular-nums">{formatRs(saved.discountPaise)}</dd></>}
              <dt className="text-muted-foreground">Advance held</dt><dd className="text-right tabular-nums">{formatRs(saved.party.advancePaise)}</dd>
              <dt className="font-semibold">Balance now</dt><dd className="text-right font-bold tabular-nums">{formatRs(saved.party.balancePaise)}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <button type="button" data-primary onClick={() => void printReceipt(saved)} className="h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">Print receipt</button>
              {saved.phone && <a href={whatsappLink(saved.phone, receiptText(saved))} target="_blank" rel="noreferrer" className="flex h-11 items-center rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">WhatsApp</a>}
              <button type="button" onClick={another} className="h-11 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">Record another</button>
            </div>
          </div>
        ) : (
          <form className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5" onSubmit={(e) => { e.preventDefault(); save() }}>
            <PartyPicker parties={parties} value={party} onChange={setParty} autoFocus={!party} />
            {loadErr && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadErr}</p>}
            {data && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span>Balance <b className="tabular-nums">{formatRs(data.balancePaise)}</b></span>
                <span className="text-muted-foreground">Unpaid {formatRs(data.unpaidPaise)}</span>
                {data.advancePaise > 0 && <span className="text-muted-foreground">Advance {formatRs(data.advancePaise)}</span>}
                {data.earlyPayDiscountBp && <span className="text-emerald-700 dark:text-emerald-300">{`Early-payment discount ${data.earlyPayDiscountBp / 100}% within ${data.earlyPayDays} days`}</span>}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-muted-foreground">Amount received (₹)
                <input ref={amountRef} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className={`${inputCls} text-base font-semibold tabular-nums`} />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">Received on
                <input type="date" value={receivedOn} max={istToday()} onChange={(e) => setReceivedOn(e.target.value)} className={inputCls} />
              </label>
            </div>

            <div>
              <span className="text-xs font-medium text-muted-foreground" id="pay-mode">How paid</span>
              <div role="radiogroup" aria-labelledby="pay-mode" className="mt-1 grid grid-cols-4 gap-1 rounded-xl border border-border bg-muted/40 p-1">
                {MODES.map((m, i) => (
                  <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} tabIndex={mode === m.id ? 0 : -1} data-mode={m.id}
                    onClick={() => setMode(m.id)}
                    onKeyDown={(e) => {
                      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                      if (!step) return
                      e.preventDefault()
                      const next = MODES[(i + step + MODES.length) % MODES.length].id
                      setMode(next)
                      ;(e.currentTarget.parentElement?.querySelector(`[data-mode="${next}"]`) as HTMLElement | null)?.focus()
                    }}
                    className={`h-9 rounded-lg text-sm font-semibold ${mode === m.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background'}`}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {cheque ? (
              <div className="grid grid-cols-3 gap-3">
                <label className="block text-xs font-medium text-muted-foreground">Cheque no.
                  <input value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} maxLength={20} inputMode="numeric" className={inputCls} />
                </label>
                <label className="block text-xs font-medium text-muted-foreground">Bank
                  <input value={chequeBank} onChange={(e) => setChequeBank(e.target.value)} maxLength={60} className={inputCls} />
                </label>
                <label className="block text-xs font-medium text-muted-foreground">Cheque date
                  <input type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} className={inputCls} />
                </label>
                <p className="col-span-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  Saved as <b>cheque received</b>. It is not counted until it is deposited (Payments &amp; cheques tab); it is set against bills then.
                </p>
              </div>
            ) : (mode === 'upi' || mode === 'bank') && (
              <label className="block text-xs font-medium text-muted-foreground">{mode === 'upi' ? 'UPI reference (optional)' : 'UTR / reference (optional)'}
                <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} className={inputCls} />
              </label>
            )}

            {data && !cheque && (
              <div className="overflow-hidden rounded-xl border border-border">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                  <p className="text-sm font-semibold">Unpaid bills</p>
                  {manual
                    ? <button type="button" onClick={() => setManual(null)} className="text-xs font-semibold text-primary underline">Oldest first</button>
                    : <span className="text-[11px] text-muted-foreground">Oldest first — type in a box to change</span>}
                </div>
                {data.open.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-muted-foreground">Nothing unpaid — the whole amount is kept as advance.</p>
                ) : (
                  <div className="max-h-80 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-card text-[11px] uppercase tracking-wide text-muted-foreground">
                        <tr><th className="px-3 py-1.5 text-left font-semibold">Bill</th><th className="px-2 py-1.5 text-right font-semibold">Unpaid</th>
                          {hasDiscount && <th className="px-2 py-1.5 text-right font-semibold">Discount</th>}
                          <th className="px-3 py-1.5 text-right font-semibold">Set against</th></tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {plan.rows.map((r, i) => {
                          const d = r.saleBillId ? disc[r.saleBillId] : undefined
                          return (
                            <tr key={r.entryId}>
                              <td className="px-3 py-1.5"><span className="font-medium" data-no-translate>{r.refNo || r.kind}</span>
                                <span className="block text-[11px] text-muted-foreground">{`${dayText(r.entryDate)}${r.kind !== 'bill' ? ` · ${r.kind}` : ''}`}</span></td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{formatRs(r.openPaise)}</td>
                              {hasDiscount && (
                                <td className="px-2 py-1.5 text-right">
                                  {d ? (
                                    <span className="inline-flex items-center gap-1">
                                      <input type="checkbox" aria-label={`Discount on ${r.refNo}`} checked={d.on} onChange={(e) => setDisc({ ...disc, [r.saleBillId!]: { ...d, on: e.target.checked } })} />
                                      <input aria-label={`Discount amount on ${r.refNo}`} inputMode="decimal" value={d.text} disabled={!d.on}
                                        onChange={(e) => setDisc({ ...disc, [r.saleBillId!]: { on: true, text: e.target.value } })}
                                        className={`${smallCls} w-20 ${r.discountPaise < 0 || r.discountPaise > r.openPaise ? 'border-red-500' : 'border-input'}`} />
                                    </span>
                                  ) : <span className="text-xs text-muted-foreground">—</span>}
                                </td>
                              )}
                              <td className="px-3 py-1.5 text-right">
                                <input aria-label={`Set against ${r.refNo}`} inputMode="decimal"
                                  value={manual ? manual[r.entryId] ?? '' : plan.set[i] ? rupeesText(plan.set[i]) : ''}
                                  placeholder="0"
                                  onChange={(e) => {
                                    const base = manual ?? Object.fromEntries(plan.rows.map((x, j) => [x.entryId, plan.set[j] ? rupeesText(plan.set[j]) : '']))
                                    setManual({ ...base, [r.entryId]: e.target.value })
                                  }}
                                  className={`${smallCls} ${plan.set[i] < 0 || plan.set[i] > r.left ? 'border-red-500' : manual ? 'border-amber-500' : 'border-input'}`} />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 border-t border-border bg-muted/20 px-3 py-2 text-sm tabular-nums">
                  {discountTotal > 0 && <span>Discount <b>{formatRs(discountTotal)}</b></span>}
                  <span>Set against <b>{formatRs(setTotal)}</b></span>
                  <span className={advance < 0 ? 'text-red-600' : ''}>Advance <b>{formatRs(Math.max(0, advance))}</b></span>
                </div>
              </div>
            )}

            <label className="block text-xs font-medium text-muted-foreground">Note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={inputCls} />
            </label>

            {(error || (problem && amount)) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error || problem}</p>}
            <div className="sticky bottom-0 -mx-4 border-t border-border bg-card px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:-mx-5 sm:px-5">
              <button type="submit" data-primary disabled={saving || !!problem}
                className="h-12 w-full rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">
                {saving ? 'Saving…' : cheque ? `Save cheque received${amountPaise ? ` · ${formatRs(amountPaise)}` : ''}` : `Record payment${amountPaise ? ` · ${formatRs(amountPaise)}` : ''}`}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  )
}

function receiptText(r: SavedReceipt): string {
  const lines = [
    `Shayona — payment receipt ${r.receiptNo}`,
    `${r.partyName}`,
    `${r.status === 'pending' ? 'Cheque received' : 'Received'} ${formatRs(r.amountPaise)} on ${dayText(r.receivedOn)} (${r.mode.toUpperCase()}${r.chequeNo ? ` no. ${r.chequeNo}` : ''})`,
    ...r.setAgainst.map((s) => `  ${s.refNo}: ${formatRs(s.amountPaise)}`),
    ...(r.discountPaise > 0 ? [`Early-payment discount: ${formatRs(r.discountPaise)}`] : []),
    `Balance now: ${formatRs(r.party.balancePaise)}`,
  ]
  return lines.join('\n')
}
