'use client'

// Master → Bill template → Bill numbers (admin). Each bill gets the next number when billed.

import { useEffect, useState, useTransition } from 'react'
import { getBillNumberingSetup, saveBillNumbering } from '@/app/actions/bill-numbering'

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring'
const fmt = (prefix: string, n: number, padding: number) => `${prefix}${String(n).padStart(padding, '0')}`

export function BillNumberSettings() {
  const [prefix, setPrefix] = useState('')
  const [next, setNext] = useState('')
  const [padding, setPadding] = useState('0')
  const [info, setInfo] = useState<{ highestUsed: number; updatedByName: string; updatedAt: string } | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()

  const load = (v: Awaited<ReturnType<typeof getBillNumberingSetup>>) => {
    setPrefix(v.prefix); setNext(String(v.next)); setPadding(String(v.padding))
    setInfo({ highestUsed: v.highestUsed, updatedByName: v.updatedByName, updatedAt: v.updatedAt })
  }
  useEffect(() => { getBillNumberingSetup().then(load).catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not load.' })) }, [])

  const n = Number(next)
  const preview = Number.isFinite(n) && n > 0 ? fmt(prefix.trim(), Math.floor(n), Number(padding) || 0) : '—'

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="bill-no-h">
      <h3 id="bill-no-h" className="text-sm font-semibold">Bill numbers</h3>
      <p className="text-xs text-muted-foreground">
        Every bill gets the next number when it is billed (Invoices and Direct Billing). No two bills share a number.
        On the day you stop the old software, set <b>Next bill number</b> to its next number so both match.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <label className="col-span-1 block text-xs font-medium text-muted-foreground">Prefix
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="none" className={`${inputCls} mt-1`} />
        </label>
        <label className="col-span-1 block text-xs font-medium text-muted-foreground">Next bill number
          <input value={next} onChange={(e) => setNext(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${inputCls} mt-1`} />
        </label>
        <label className="col-span-1 block text-xs font-medium text-muted-foreground">Digits
          <select value={padding} onChange={(e) => setPadding(e.target.value)} className={`${inputCls} mt-1`}>
            {[0, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{d === 0 ? 'As is' : `${d} (zero-filled)`}</option>)}
          </select>
        </label>
      </div>
      <p className="text-sm">Next bill: <span className="font-mono font-bold">{preview}</span></p>
      {info && (
        <p className="text-[11px] text-muted-foreground">
          {info.highestUsed > 0 ? `Highest number used so far: ${fmt(prefix.trim(), info.highestUsed, Number(padding) || 0)}.` : 'No bill numbered yet.'}
          {info.updatedByName ? ` Last changed by ${info.updatedByName}.` : ''}
        </p>
      )}
      <button type="button" disabled={busy || !(n > 0)}
        onClick={() => start(async () => {
          setMsg(null)
          try { load(await saveBillNumbering({ prefix, next: n, padding: Number(padding) || 0 })); setMsg({ ok: true, text: 'Saved.' }) }
          catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Not saved.' }) }
        })}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {busy ? 'Saving…' : 'Save bill numbers'}
      </button>
      {msg && <p role="status" className={`rounded-lg px-3 py-2 text-xs ${msg.ok ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200' : 'bg-red-500/15 text-red-700 dark:text-red-300'}`}>{msg.text}</p>}
    </section>
  )
}
