'use client'

// Payments → Bank statement (owner, 24–25 Nov 2026; migration 0020). Upload a bank's Excel / CSV
// statement (columns chosen once per bank), then review each money-in line: already typed (link), a
// known payer (pre-filled), or choose the party / split across parties. Exact matches are pre-ticked;
// "Confirm ticked" posts them in one go. Nothing reaches a ledger until confirmed.

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { DialogKeys } from '@/components/dialog-keys'
import { useListKeys } from '@/lib/shortcuts/list'
import { formatRs } from '@/lib/billing/bill-amounts'
import { toPaise } from '@/lib/billing/bill-totals'
import { confirmStatementAction, ignoreStatementAction, importStatementAction, previewStatementAction, type StatementPreview } from '@/app/actions/payments'
import type { BankAccount } from '@/lib/payments/slips'
import type { LineFilter, ReviewLine } from '@/lib/payments/statements'
import type { StatementColumns } from '@/lib/payments/statement-parse'
import type { PartyChoice } from '@/lib/payments/queries'
import { PartyPicker } from './party-picker'
import { dayText } from './print'

const FILTERS: Array<[LineFilter, string]> = [['review', 'To confirm'], ['confirmed', 'Confirmed'], ['ignored', 'Ignored'], ['out', 'Money out']]
const FIELDS: Array<[keyof StatementColumns, string, boolean]> = [
  ['date', 'Date', true], ['details', 'Details / narration', true], ['reference', 'Cheque no. / reference', false],
  ['credit', 'Credit (money in)', false], ['debit', 'Debit (money out)', false], ['amount', 'Amount (if one column)', false], ['drcr', 'Dr / Cr (if one column)', false], ['balance', 'Balance', false],
]

type Part = { party: PartyChoice | null; amount: string }
type Choice = { kind: 'link'; paymentId: number } | { kind: 'parts'; parts: Part[] }
const paise = (t: string) => { try { const p = toPaise(t.replace(/,/g, '').trim() || 'x'); return p > 0 ? p : null } catch { return null } }
const rupees = (p: number) => (p / 100).toFixed(2).replace(/\.00$/, '')

export function BankStatementTab({ banks, parties, canRecord, onChanged }: { banks: BankAccount[]; parties: PartyChoice[]; canRecord: boolean; onChanged: () => void }) {
  const [bankId, setBankId] = useState<number | null>(banks[0]?.id ?? null)
  const [filter, setFilter] = useState<LineFilter>('review')
  const [lines, setLines] = useState<ReviewLine[] | null>(null)
  const [reload, setReload] = useState(0)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [choice, setChoice] = useState<Record<number, Choice>>({})
  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const [ignoring, setIgnoring] = useState<ReviewLine | null>(null)
  const [upload, setUpload] = useState(false)
  const [busy, start] = useTransition()
  const listRef = useRef<HTMLDivElement>(null)
  useListKeys(listRef, { label: 'Statement lines', tickable: true })
  const byId = useMemo(() => new Map(parties.map((p) => [p.id, p])), [parties])

  useEffect(() => {
    if (!bankId) return
    let live = true
    setErr('')
    fetch(`/api/payments?view=bankstatement&bank=${bankId}&filter=${filter}`, { cache: 'no-store' })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not load.'); return j as ReviewLine[] })
      .then((ls) => {
        if (!live) return
        setLines(ls)
        // Suggestions: a strong typed payment → link; one known payer → that party; exact ones ticked.
        const c: Record<number, Choice> = {}, t = new Set<number>()
        for (const l of ls) {
          const strong = l.typed.filter((x) => x.strong)
          if (strong.length === 1) c[l.id] = { kind: 'link', paymentId: strong[0].paymentId }
          else if (l.typed.length === 1 && l.known.length === 0) c[l.id] = { kind: 'link', paymentId: l.typed[0].paymentId }
          else c[l.id] = { kind: 'parts', parts: [{ party: l.known.length === 1 ? byId.get(l.known[0].retailerId) ?? null : null, amount: rupees(l.creditPaise) }] }
          if (l.exact) t.add(l.id)
        }
        setChoice(c); setTicked(t)
      })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load.') })
    return () => { live = false }
  }, [bankId, filter, reload, byId])

  const problemOf = (l: ReviewLine): string => {
    const c = choice[l.id]
    if (!c) return 'Choose the party.'
    if (c.kind === 'link') return ''
    if (c.parts.some((p) => !p.party)) return 'Choose the party.'
    const sum = c.parts.reduce((s, p) => s + (paise(p.amount) ?? 0), 0)
    if (c.parts.some((p) => !paise(p.amount))) return 'Type each amount.'
    if (sum !== l.creditPaise) return `Parts add up to ${formatRs(sum)}, not ${formatRs(l.creditPaise)}.`
    return ''
  }
  const tickedOk = (lines ?? []).filter((l) => ticked.has(l.id) && !problemOf(l))
  function confirm() {
    if (!tickedOk.length) return
    const items = tickedOk.map((l) => {
      const c = choice[l.id]
      return c.kind === 'link' ? { lineId: l.id, link: [c.paymentId] } : { lineId: l.id, splits: c.parts.map((p) => ({ retailerId: p.party!.id, amountPaise: paise(p.amount)! })) }
    })
    setErr(''); setMsg('')
    start(async () => {
      try {
        const r = await confirmStatementAction(items)
        setMsg(`${r.confirmed} line(s) confirmed${r.payments ? `, ${r.payments} payment(s) added to the bank slips` : ''}.`)
        setReload((n) => n + 1); onChanged()
      } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved. Nothing was confirmed.') }
    })
  }
  const setParts = (id: number, parts: Part[]) => setChoice((c) => ({ ...c, [id]: { kind: 'parts', parts } }))

  if (!banks.length) return <p className="py-8 text-center text-sm text-muted-foreground">Add your banks in Master → Banks first.</p>
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Bank" className="flex flex-wrap gap-1 rounded-xl border border-border bg-muted/40 p-1">
          {banks.map((b) => (
            <button key={b.id} type="button" role="tab" aria-selected={b.id === bankId} onClick={() => { setBankId(b.id); setLines(null) }}
              className={`h-9 rounded-lg px-4 text-sm font-semibold ${b.id === bankId ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{b.name}</button>
          ))}
        </div>
        <span className="flex-1" />
        {canRecord && <button type="button" onClick={() => setUpload(true)} className="h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">Upload statement</button>}
      </div>
      <div className="flex flex-wrap gap-1">
        {FILTERS.map(([f, label]) => (
          <button key={f} type="button" aria-pressed={f === filter} onClick={() => setFilter(f)}
            className={`h-8 rounded-full border px-3 text-xs font-semibold ${f === filter ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}>{label}</button>
        ))}
      </div>
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      {msg && <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">{msg}</p>}

      <div ref={listRef} className="space-y-2">
        {lines && lines.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{filter === 'review' ? 'Nothing to confirm. Upload a statement.' : 'Nothing here.'}</p>}
        {lines?.map((l) => {
          const c = choice[l.id]
          const problem = filter === 'review' ? problemOf(l) : ''
          return (
            <div key={l.id} data-list-row className={`rounded-xl border bg-card p-3 ${ticked.has(l.id) ? 'border-primary/60' : 'border-border'}`}>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                {filter === 'review' && canRecord && (
                  <input type="checkbox" data-row-tick aria-label="Confirm this line" checked={ticked.has(l.id)} className="mt-1"
                    onChange={(e) => setTicked((t) => { const n = new Set(t); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n })} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm"><b className="tabular-nums">{l.creditPaise ? formatRs(l.creditPaise) : `− ${formatRs(l.debitPaise)}`}</b>
                    <span className="ml-2 text-xs text-muted-foreground">{`${dayText(l.txnDate)} · ${l.mode === 'cheque' ? `Cheque ${l.chequeNo}` : l.mode === 'upi' ? 'UPI' : 'Transfer'}${l.reference ? ` · ref ${l.reference}` : ''}`}</span>
                    {l.exact && filter === 'review' && <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">Exact match</span>}</p>
                  <p className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground" title={l.details}>{l.details}</p>
                </div>
                {filter === 'review' && canRecord && (
                  <button type="button" onClick={() => setIgnoring(l)} className="text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline">Not a party payment</button>
                )}
              </div>
              {filter === 'review' && canRecord && c && (
                <div className="mt-2 space-y-2 border-t border-border pt-2">
                  {l.typed.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      <span className="self-center text-muted-foreground">Typed on the slip:</span>
                      {l.typed.map((t) => {
                        const on = c.kind === 'link' && c.paymentId === t.paymentId
                        return (
                          <button key={t.paymentId} type="button" aria-pressed={on} onClick={() => setChoice((x) => ({ ...x, [l.id]: { kind: 'link', paymentId: t.paymentId } }))}
                            className={`rounded-lg border px-2 py-1 font-semibold ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>
                            {`${t.receiptNo} · ${t.partyName}${t.strong ? ' ✓' : ''}`}
                          </button>
                        )
                      })}
                      {c.kind === 'link' && <button type="button" onClick={() => setParts(l.id, [{ party: null, amount: rupees(l.creditPaise) }])} className="text-xs underline">Not these — choose party</button>}
                    </div>
                  )}
                  {c.kind === 'parts' && (
                    <>
                      {l.known.length > 1 && (
                        <div className="flex flex-wrap gap-1.5 text-xs">
                          <span className="self-center text-muted-foreground">This payer paid for:</span>
                          {l.known.map((k) => (
                            <button key={k.retailerId} type="button" onClick={() => setParts(l.id, [{ party: byId.get(k.retailerId) ?? null, amount: rupees(l.creditPaise) }])}
                              className="rounded-lg border border-border px-2 py-1 font-semibold hover:bg-muted">{k.partyName}{k.timesUsed === 0 ? ' (same name)' : ''}{k.exactBill ? ' (bill amount)' : ''}</button>
                          ))}
                        </div>
                      )}
                      {l.known.length === 1 && l.known[0].timesUsed === 0 && (
                        <p className="text-xs text-muted-foreground">{`Suggested because the party's name is the payer's name${l.known[0].exactBill ? ' and the amount is one of its unpaid bills' : ''} — check, then tick.`}</p>
                      )}
                      {c.parts.map((p, i) => (
                        <div key={i} className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-end gap-2">
                          <PartyPicker parties={parties} value={p.party} label={c.parts.length > 1 ? `Party ${i + 1}` : 'Party'}
                            onChange={(v) => setParts(l.id, c.parts.map((x, j) => (j === i ? { ...x, party: v } : x)))} />
                          <label className="block text-xs font-medium text-muted-foreground">Amount (₹)
                            <input inputMode="decimal" value={p.amount} onChange={(e) => setParts(l.id, c.parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                              className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-2 text-right text-sm tabular-nums" />
                          </label>
                          {c.parts.length > 1 ? (
                            <button type="button" aria-label="Remove this part" onClick={() => setParts(l.id, c.parts.filter((_, j) => j !== i))} className="h-11 rounded-xl border border-border px-3 text-sm hover:bg-muted">✕</button>
                          ) : <span />}
                        </div>
                      ))}
                      <button type="button" onClick={() => {
                        const left = l.creditPaise - c.parts.reduce((s, p) => s + (paise(p.amount) ?? 0), 0)
                        setParts(l.id, [...c.parts, { party: null, amount: left > 0 ? rupees(left) : '' }])
                      }} className="text-xs font-semibold text-primary underline">+ Split with another party</button>
                    </>
                  )}
                  {problem && ticked.has(l.id) && <p className="text-xs text-amber-700 dark:text-amber-300">{problem}</p>}
                </div>
              )}
              {filter === 'confirmed' && <p className="mt-1 text-xs">{l.payments.map((p) => `${p.receiptNo} · ${p.partyName} · ${formatRs(p.amountPaise)}${p.status !== 'active' ? ` (${p.status})` : ''}`).join('   ')}{l.doneByName ? ` — by ${l.doneByName}` : ''}</p>}
              {filter === 'ignored' && <p className="mt-1 text-xs text-muted-foreground">{`${l.ignoreReason ?? ''}${l.doneByName ? ` — by ${l.doneByName}` : ''}`}</p>}
            </div>
          )
        })}
      </div>

      {filter === 'review' && canRecord && (lines?.length ?? 0) > 0 && (
        <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 flex items-center gap-3 rounded-xl border border-border bg-card/95 p-3 backdrop-blur md:bottom-3">
          <p className="flex-1 text-sm">{`${ticked.size} ticked · ${tickedOk.length} ready · ${formatRs(tickedOk.reduce((s, l) => s + l.creditPaise, 0))}`}</p>
          <button type="button" data-primary onClick={confirm} disabled={busy || !tickedOk.length}
            className="h-11 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50">{busy ? 'Saving…' : `Confirm ${tickedOk.length} ticked`}</button>
        </div>
      )}
      {ignoring && <IgnoreDialog line={ignoring} onClose={() => setIgnoring(null)} onDone={() => { setIgnoring(null); setReload((n) => n + 1) }} />}
      {upload && bankId && <UploadDialog bank={banks.find((b) => b.id === bankId)!} onClose={() => setUpload(false)} onDone={(t) => { setUpload(false); setMsg(t); setFilter('review'); setReload((n) => n + 1) }} />}
    </div>
  )
}

function UploadDialog({ bank, onClose, onDone }: { bank: BankAccount; onClose: () => void; onDone: (t: string) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [p, setP] = useState<StatementPreview | null>(null)
  const [cols, setCols] = useState<Partial<StatementColumns>>({})
  const [err, setErr] = useState('')
  const [busy, start] = useTransition()
  const form = (f: File, c?: Partial<StatementColumns>) => { const fd = new FormData(); fd.set('file', f); fd.set('bankAccountId', String(bank.id)); if (c) fd.set('columns', JSON.stringify(c)); return fd }
  const preview = (f: File, c?: Partial<StatementColumns>) => start(async () => {
    setErr('')
    try { const r = await previewStatementAction(form(f, c)); setP(r); setCols(r.columns) } catch (e) { setP(null); setErr(e instanceof Error ? e.message : 'Could not read the file.') }
  })
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <DialogKeys onClose={onClose} label="Upload statement" />
      <section role="dialog" aria-modal="true" aria-label="Upload statement" onClick={(e) => e.stopPropagation()} className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <h2 className="flex-1 text-lg font-bold">{`Upload statement — ${bank.name}`}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-muted">✕</button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <p className="text-sm text-muted-foreground">Download the statement from net banking as <b>Excel (.xlsx)</b>, <b>CSV</b> or <b>PDF</b>. Lines already imported are skipped, so an overlapping period is fine. A PDF is imported only when every balance and total in it adds up.</p>
          <input type="file" accept=".xlsx,.csv,.pdf,.xls" aria-label="Statement file" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); preview(f) } }}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-semibold" />
          {busy && !p && <p className="text-sm text-muted-foreground">Reading…</p>}
          {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
          {p?.pdf && (
            <section className="space-y-1 rounded-xl border border-border p-3">
              <h3 className="text-sm font-semibold">Read from the PDF and checked</h3>
              <ul className="space-y-0.5 text-xs">{p.checks.map((x, i) => <li key={i}>{`✓ ${x}`}</li>)}</ul>
            </section>
          )}
          {p && (
            <>
              {!p.pdf && <section className="space-y-2 rounded-xl border border-border p-3">
                <h3 className="text-sm font-semibold">{p.saved ? `Columns (saved for ${p.bankName})` : 'Which column is which? (saved for this bank)'}</h3>
                <div className="grid grid-cols-2 gap-2">
                  {FIELDS.map(([k, label, required]) => (
                    <label key={k} className="block text-xs font-medium text-muted-foreground">{`${label}${required ? ' *' : ''}`}
                      <select value={cols[k] ?? ''} onChange={(e) => setCols((c) => ({ ...c, [k]: e.target.value || undefined }))}
                        className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground">
                        <option value="">—</option>
                        {p.headers.filter(Boolean).map((hd, i) => <option key={`${hd}-${i}`} value={hd}>{hd}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                {file && <button type="button" onClick={() => preview(file, cols)} disabled={busy} className="h-9 rounded-lg border border-border px-3 text-sm font-semibold hover:bg-muted">Check again with these columns</button>}
              </section>}
              {p.sample.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-[11px]"><thead className="bg-muted/30"><tr>{p.headers.map((hd, i) => <th key={i} className="whitespace-nowrap px-2 py-1 text-left">{hd}</th>)}</tr></thead>
                    <tbody>{p.sample.map((r, i) => <tr key={i} className="border-t border-border">{r.map((v, j) => <td key={j} className="max-w-[16rem] truncate px-2 py-1">{v}</td>)}</tr>)}</tbody></table>
                </div>
              )}
              {p.problems.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">{p.problems.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {p.lines > 0 && (
                <p className="text-sm">{`${p.lines} line(s) ${p.fromDate ? `from ${dayText(p.fromDate)} to ${dayText(p.toDate)}` : ''}: ${p.credits} money in (${formatRs(p.creditPaise)}), ${p.debits} money out. `}
                  <b>{`${p.lines - p.known} new`}</b>{p.known ? `, ${p.known} already imported (skipped).` : '.'}</p>
              )}
              {p.setAside > 0 && <p className="text-xs text-muted-foreground">{`${p.setAside} money-in line(s) are bounced cheques or reversals (the money went back out in this statement): they are kept aside under Ignored, never posted.`}</p>}
            </>
          )}
        </div>
        <div className="border-t border-border p-4">
          <button type="button" data-primary disabled={busy || !file || !p || p.lines === 0 || p.lines === p.known}
            onClick={() => file && start(async () => {
              try { const r = await importStatementAction(form(file, cols)); onDone(`Statement imported: ${r.rowsNew} new line(s) of ${r.rowsRead}${r.setAside ? ` (${r.setAside} bounced / reversed, set aside)` : ''}. Review them below.`) }
              catch (e) { setErr(e instanceof Error ? e.message : 'Not imported.') }
            })}
            className="h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50">
            {busy ? 'Working…' : p && p.lines > p.known ? `Import ${p.lines - p.known} new line(s)` : 'Import'}
          </button>
        </div>
      </section>
    </div>
  )
}

function IgnoreDialog({ line, onClose, onDone }: { line: ReviewLine; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, start] = useTransition()
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <DialogKeys onClose={onClose} label="Not a party payment" />
      <form role="dialog" aria-modal="true" aria-labelledby="ign-h" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); start(async () => { try { await ignoreStatementAction(line.id, reason); onDone() } catch (x) { setErr(x instanceof Error ? x.message : 'Not saved.') } }) }}
        className="w-full space-y-3 rounded-t-3xl bg-background p-5 shadow-2xl sm:max-w-md sm:rounded-3xl">
        <h2 id="ign-h" className="text-lg font-bold">Not a party payment</h2>
        <p className="text-sm text-muted-foreground">{`${dayText(line.txnDate)} · ${formatRs(line.creditPaise || line.debitPaise)}`}</p>
        <label className="block text-xs font-medium text-muted-foreground">Why
          <input autoFocus list="ign-reasons" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm" placeholder="e.g. own transfer between banks" />
          <datalist id="ign-reasons">{['Own transfer between banks', 'Bank interest', 'Refund from supplier', 'Cash deposited by the shop', 'Loan / capital'].map((r) => <option key={r} value={r} />)}</datalist>
        </label>
        {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold hover:bg-muted">Cancel</button>
          <button type="submit" data-primary disabled={busy || !reason.trim()} className="flex-1 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy ? 'Saving…' : 'Mark ignored'}</button>
        </div>
      </form>
    </div>
  )
}
