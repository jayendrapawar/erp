'use client'

// Master → Bill template → Bill email (admin): the Gmail that sends bills to retailers.
// The app password is written once and never shown again (stored encrypted).

import { useEffect, useState, useTransition } from 'react'
import { getBillEmailSetup, saveBillEmailSender, sendBillEmailTest } from '@/app/actions/bill-email'
import type { SenderInfo } from '@/lib/bill-email'

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring'
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')

export function BillEmailSettings() {
  const [info, setInfo] = useState<SenderInfo | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [testTo, setTestTo] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()

  useEffect(() => {
    getBillEmailSetup().then((i) => { setInfo(i); setEmail(i.email) }).catch((e) => setMsg({ ok: false, text: errText(e) }))
  }, [])

  const ready = Boolean(info?.email && info.hasPassword)
  const changed = info ? email.trim().toLowerCase() !== info.email || password.trim() !== '' : false

  return (
    <section data-form className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="bill-email-h">
      <div className="flex items-center gap-2">
        <h3 id="bill-email-h" className="flex-1 text-sm font-semibold">Bill email</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ready ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>
          {ready ? 'Ready' : 'Not set up'}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Bills are emailed (PDF) from this Gmail in Biller → Receipts → Mail. Use a Gmail <b>App Password</b>, not the normal password:
        Google account → Security → 2-Step Verification (turn on) → App passwords → create one for “Shayona”, copy the 16 letters here.
      </p>
      <label className="block text-xs font-medium text-muted-foreground">Sender Gmail
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoComplete="off" placeholder="shayonafootwear11@gmail.com" className={`${inputCls} mt-1`} />
      </label>
      <label className="block text-xs font-medium text-muted-foreground">App password
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password"
          placeholder={info?.hasPassword ? 'Saved — type a new one only to change it' : '16 letters from Google'} className={`${inputCls} mt-1`} />
      </label>
      {info?.updatedByName && <p className="text-[11px] text-muted-foreground">Last changed by {info.updatedByName}{info.updatedAt ? `, ${new Date(info.updatedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</p>}
      <button data-primary type="button" disabled={busy || !changed}
        onClick={() => start(async () => {
          setMsg(null)
          try { const i = await saveBillEmailSender(email, password); setInfo(i); setEmail(i.email); setPassword(''); setMsg({ ok: true, text: 'Saved. Send a test to check it works.' }) }
          catch (e) { setMsg({ ok: false, text: errText(e) }) }
        })}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {busy ? 'Saving…' : 'Save sender'}
      </button>
      <div className="flex gap-2">
        <input value={testTo} onChange={(e) => setTestTo(e.target.value)} type="email" inputMode="email" placeholder="Send a test to…" aria-label="Test email address" className={inputCls} />
        <button type="button" disabled={busy || !ready || !testTo.trim()}
          onClick={() => start(async () => {
            setMsg(null)
            try { const r = await sendBillEmailTest(testTo); setMsg({ ok: true, text: `Test sent to ${r.sentTo.join(', ')}. Check the inbox (and spam).` }) }
            catch (e) { setMsg({ ok: false, text: errText(e) }) }
          })}
          className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-50">
          Send test
        </button>
      </div>
      {msg && <p role="status" className={`rounded-lg px-3 py-2 text-xs ${msg.ok ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200' : 'bg-red-500/15 text-red-700 dark:text-red-300'}`}>{msg.text}</p>}
    </section>
  )
}
