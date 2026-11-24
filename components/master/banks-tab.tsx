'use client'

// Master → Banks (owner, 24 Nov 2026): the shop's banks, each with its own slip numbers (SBI/1, SBI/2 …),
// and the cash slip numbers (C1, C2 …). Add, edit or retire a bank; a bank with slips is never deleted.
// At go-live set the next numbers to the old software's next numbers so both match.

import { useEffect, useRef, useState, useTransition } from 'react'
import { DialogKeys } from '@/components/dialog-keys'
import { useListKeys } from '@/lib/shortcuts/list'
import { getBanks, getCashSlipNumbering, saveBankAction, saveCashSlipNumberingAction } from '@/app/actions/payments'
import type { BankAccount, SlipNumbering } from '@/lib/payments/slips'

const inputCls = 'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
type Form = { id?: number; name: string; slipPrefix: string; nextSlip: string; accountNo: string; ifsc: string; branch: string; note: string; active: boolean }
const EMPTY: Form = { name: '', slipPrefix: '', nextSlip: '1', accountNo: '', ifsc: '', branch: '', note: '', active: true }

export function BanksTab() {
  const [banks, setBanks] = useState<BankAccount[] | null>(null)
  const [cash, setCash] = useState<SlipNumbering | null>(null)
  const [err, setErr] = useState('')
  const [form, setForm] = useState<Form | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useListKeys(listRef, { label: 'Banks', onNew: () => setForm(EMPTY), newLabel: 'Add a bank' })
  useEffect(() => {
    Promise.all([getBanks(false), getCashSlipNumbering()]).then(([b, c]) => { setBanks(b); setCash(c) })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load the banks.'))
  }, [])

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Banks money comes into. Each has its own slip numbers; Payments → Slips shows a day&apos;s slip for cash or for a bank.
      </p>
      {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      {cash && <CashNumbers value={cash} onSaved={setCash} />}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{`Banks (${banks?.length ?? 0})`}</h3>
        <button type="button" onClick={() => setForm(EMPTY)} className="h-9 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">+ Add bank <kbd className="ml-1 hidden text-[10px] opacity-70 sm:inline">n</kbd></button>
      </div>
      <div ref={listRef} className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-3 py-2 text-left font-semibold">Bank</th><th className="px-2 py-2 text-left font-semibold">Account</th><th className="px-2 py-2 text-left font-semibold">IFSC / branch</th>
              <th className="px-2 py-2 text-left font-semibold">Slip numbers</th><th className="px-2 py-2 text-left font-semibold">Status</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {banks && banks.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No banks yet. Add the banks money comes into.</td></tr>}
            {banks?.map((b) => (
              <tr key={b.id} data-list-row className={b.active ? '' : 'text-muted-foreground'}>
                <td className="px-3 py-2 font-semibold">{b.name}{b.note && <span className="block text-[11px] font-normal text-muted-foreground">{b.note}</span>}</td>
                <td className="px-2 py-2 font-mono text-xs">{b.accountNo || '—'}</td>
                <td className="px-2 py-2 text-xs">{[b.ifsc, b.branch].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-2 py-2 font-mono text-xs">{`next ${b.slipPrefix}${b.nextSlip}`}</td>
                <td className="px-2 py-2 text-xs">{b.active ? 'In use' : 'Retired'}</td>
                <td className="px-3 py-2 text-right">
                  <button type="button" data-row-open onClick={() => setForm({ ...b, nextSlip: String(b.nextSlip) })} className="rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted">Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {form && <BankDialog form={form} onClose={() => setForm(null)} onSaved={(list) => { setBanks(list); setForm(null) }} />}
    </div>
  )
}

function CashNumbers({ value, onSaved }: { value: SlipNumbering; onSaved: (v: SlipNumbering) => void }) {
  const [prefix, setPrefix] = useState(value.prefix)
  const [next, setNext] = useState(String(value.next))
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()
  return (
    <section data-form className="rounded-xl border border-border bg-card p-4" aria-labelledby="cash-no-h">
      <h3 id="cash-no-h" className="text-sm font-semibold">Cash slip numbers</h3>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="block text-xs font-medium text-muted-foreground">Prefix
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={12} className={`${inputCls} w-28`} />
        </label>
        <label className="block text-xs font-medium text-muted-foreground">Next slip number
          <input value={next} onChange={(e) => setNext(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${inputCls} w-32`} />
        </label>
        <p className="pb-2 text-sm">Next slip: <b className="font-mono">{`${prefix.trim().toUpperCase()}${next || '?'}`}</b></p>
        <button type="button" data-primary disabled={busy} onClick={() => start(async () => {
          setMsg(null)
          try { onSaved(await saveCashSlipNumberingAction({ prefix, next: Number(next) })); setMsg({ ok: true, text: 'Saved.' }) }
          catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Not saved.' }) }
        })} className="h-9 rounded-lg border border-border px-3 text-sm font-semibold hover:bg-muted disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
      </div>
      {msg && <p role="status" className={`mt-2 text-xs ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}>{msg.text}</p>}
    </section>
  )
}

function BankDialog({ form: initial, onClose, onSaved }: { form: Form; onClose: () => void; onSaved: (list: BankAccount[]) => void }) {
  const [f, setF] = useState(initial)
  const [err, setErr] = useState('')
  const [busy, start] = useTransition()
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const text = (k: 'name' | 'slipPrefix' | 'accountNo' | 'ifsc' | 'branch' | 'note', label: string, ph = '', max = 80) => (
    <label className="block text-xs font-medium text-muted-foreground">{label}
      <input value={f[k]} onChange={(e) => set(k, e.target.value)} maxLength={max} placeholder={ph} className={inputCls} />
    </label>
  )
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <DialogKeys onClose={onClose} label={f.id ? 'Edit bank' : 'Add bank'} />
      <form role="dialog" aria-modal="true" aria-labelledby="bank-h" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); setErr(''); start(async () => { try { onSaved(await saveBankAction({ ...f, nextSlip: Number(f.nextSlip) })) } catch (x) { setErr(x instanceof Error ? x.message : 'Not saved.') } }) }}
        className="w-full space-y-3 rounded-t-3xl bg-background p-5 shadow-2xl sm:max-w-lg sm:rounded-3xl">
        <h2 id="bank-h" className="text-lg font-bold">{f.id ? 'Edit bank' : 'Add bank'}</h2>
        {text('name', 'Bank name (as you call it)', 'e.g. SBI Current')}
        <div className="grid grid-cols-2 gap-3">
          {text('slipPrefix', 'Slip prefix', 'e.g. SBI/', 12)}
          <label className="block text-xs font-medium text-muted-foreground">Next slip number
            <input value={f.nextSlip} onChange={(e) => set('nextSlip', e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputCls} />
          </label>
          {text('accountNo', 'Account no.', '', 30)}
          {text('ifsc', 'IFSC', 'e.g. SBIN0001234', 20)}
          {text('branch', 'Branch', '', 60)}
          {text('note', 'Note (e.g. UPI comes here)', '', 200)}
        </div>
        <p className="text-sm">Next slip: <b className="font-mono">{`${f.slipPrefix.trim().toUpperCase() || '?'}${f.nextSlip || '?'}`}</b></p>
        {f.id && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!f.active} onChange={(e) => set('active', !e.target.checked)} /> Retired (no new slips)</label>
        )}
        {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold hover:bg-muted">Cancel</button>
          <button type="submit" data-primary disabled={busy} className="flex-1 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy ? 'Saving…' : 'Save bank'}</button>
        </div>
      </form>
    </div>
  )
}
