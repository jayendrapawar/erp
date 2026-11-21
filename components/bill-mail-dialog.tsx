'use client'

// Biller → Receipts → Mail: send the selected bills (PDF each) to the retailer's email from the
// shop's Gmail (set in Master → Bill template). Owner, 21 Nov 2026.

import { useEffect, useState, useTransition } from 'react'
import { Mail, X } from 'lucide-react'
import { getBillMailDefaults, mailBills, type MailDefaults } from '@/app/actions/bill-email'

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Email not sent.')

export function BillMailDialog({ orderIds, onClose }: { orderIds: number[]; onClose: () => void }) {
  const [d, setD] = useState<MailDefaults | null>(null)
  const [to, setTo] = useState('')
  const [remember, setRemember] = useState(true)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()

  useEffect(() => {
    getBillMailDefaults(orderIds).then((x) => { setD(x); setTo(x.suggestedTo) }).catch((e) => setMsg({ ok: false, text: errText(e) }))
  }, [orderIds])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const oneRetailer = d?.retailers.length === 1
  const sent = msg?.ok === true

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={() => !busy && onClose()}>
      <section role="dialog" aria-modal="true" aria-labelledby="mail-h" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-t-2xl border border-border bg-card p-5 shadow-2xl sm:rounded-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary"><Mail className="h-4 w-4" aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <h2 id="mail-h" className="text-base font-bold">{`Email ${orderIds.length} bill${orderIds.length === 1 ? '' : 's'}`}</h2>
            <p className="truncate text-xs text-muted-foreground">{d ? (d.senderEmail ? `From ${d.senderEmail} · PDF attached` : 'Sender not set up') : 'Loading…'}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg border border-border hover:bg-muted disabled:opacity-50"><X className="h-4 w-4" aria-hidden /></button>
        </div>

        {d && !d.ready && <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">{d.problem}</p>}

        {d && (
          <div className="space-y-1 text-xs text-muted-foreground">
            {d.retailers.map((r) => <p key={r.name} data-no-translate><span className="font-semibold text-foreground">{r.name}</span>{r.email ? ` · ${r.email}` : ' · no email saved'}</p>)}
          </div>
        )}

        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault()
          start(async () => {
            setMsg(null)
            try {
              const r = await mailBills({ orderIds, to, remember: remember && oneRetailer })
              setMsg({ ok: true, text: `Sent ${r.bills} bill${r.bills === 1 ? '' : 's'} to ${r.sentTo.join(', ')}.` })
            } catch (err) { setMsg({ ok: false, text: errText(err) }) }
          })
        }}>
          <label className="block text-sm font-medium">Receiver&apos;s email
            <input value={to} onChange={(e) => setTo(e.target.value)} type="text" inputMode="email" autoComplete="email" autoFocus disabled={sent}
              placeholder="retailer@example.com (several: separate with commas)"
              className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </label>
          {oneRetailer && !sent && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-primary" />
              Save this email for <span className="font-semibold" data-no-translate>{d!.retailers[0].name}</span>
            </label>
          )}
          {msg && <p role="status" className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200' : 'bg-red-500/15 text-red-700 dark:text-red-300'}`}>{msg.text}</p>}
          {sent ? (
            <button type="button" onClick={onClose} className="h-12 w-full rounded-xl border border-border text-sm font-bold hover:bg-muted">Done</button>
          ) : (
            <button type="submit" disabled={busy || !d?.ready || !to.trim()}
              className="h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {busy ? 'Sending…' : 'Send'}
            </button>
          )}
        </form>
      </section>
    </div>
  )
}
