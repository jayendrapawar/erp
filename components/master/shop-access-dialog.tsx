'use client'

// Master → Retailers → Shop: switch a retailer's ordering shop on/off, set the sign-in mobile number
// and a PIN, then share the details with the retailer (owner, 21 Nov 2026).

import { useState, useTransition } from 'react'
import { X } from 'lucide-react'
import { setShopAccess } from '@/app/actions/shop-access'
import type { Vendor } from '@/app/actions/vendors'
import { DialogKeys } from '@/components/dialog-keys'

const inputCls = 'mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Not saved.')

function randomPin(): string {
  for (;;) {
    const p = String(Math.floor(100000 + Math.random() * 900000)).slice(0, 6)
    if (!/^(\d)\1+$/.test(p) && !'0123456789'.includes(p) && !'9876543210'.includes(p)) return p
  }
}

export function ShopAccessDialog({ retailer, onClose, onSaved }: { retailer: Vendor; onClose: () => void; onSaved: (v: Vendor) => void }) {
  const [phone, setPhone] = useState(retailer.shopPhone || retailer.phone.replace(/\D/g, '').slice(-10))
  const [pin, setPin] = useState('')
  const [enabled, setEnabled] = useState(retailer.shopEnabled || !retailer.shopPinSetAt)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [shared, setShared] = useState<{ phone: string; pin: string } | null>(null)
  const [busy, start] = useTransition()
  const hasPin = Boolean(retailer.shopPinSetAt)
  const locked = retailer.shopLockedUntil && new Date(retailer.shopLockedUntil).getTime() > Date.now()

  // Esc: <DialogKeys> (focus returns to the opener).

  const link = typeof window !== 'undefined' ? `${window.location.origin}/shop` : '/shop'
  const shareText = shared ? `Shayona order app: ${link}\nMobile: ${shared.phone}\nPIN: ${shared.pin}` : ''

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={() => !busy && onClose()}>
      <DialogKeys onClose={() => !busy && onClose()} />
      <section role="dialog" aria-modal="true" aria-labelledby="shop-h" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-t-2xl border border-border bg-card p-5 shadow-2xl sm:rounded-2xl">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="shop-h" className="text-base font-bold">Shop access</h2>
            <p className="truncate text-sm text-muted-foreground" data-no-translate>{retailer.partyName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg border border-border hover:bg-muted"><X className="h-4 w-4" aria-hidden /></button>
        </div>

        {shared ? (
          <div className="space-y-3">
            <p className="rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">Saved. Give these to the retailer — the PIN is not shown again.</p>
            <pre className="whitespace-pre-wrap rounded-xl border border-border bg-muted/40 p-3 text-sm" data-no-translate>{shareText}</pre>
            <div className="flex gap-2">
              <a href={`https://wa.me/91${shared.phone}?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer"
                className="flex h-11 flex-1 items-center justify-center rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700">Send on WhatsApp</a>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(shareText) }} className="h-11 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">Copy</button>
            </div>
            <button type="button" onClick={onClose} className="h-11 w-full rounded-xl border border-border text-sm font-semibold hover:bg-muted">Done</button>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault()
            start(async () => {
              setMsg(null)
              try {
                const v = await setShopAccess({ retailerId: retailer.id, phone, pin, enabled })
                onSaved(v)
                if (pin) setShared({ phone: v.shopPhone, pin })
                else setMsg({ ok: true, text: enabled ? 'Saved. The shop is on for this retailer.' : 'Saved. The shop is off for this retailer.' })
                setPin('')
              } catch (err) { setMsg({ ok: false, text: errText(err) }) }
            })
          }}>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5 text-sm font-medium">
              <span>Shop on for this retailer<span className="block text-xs font-normal text-muted-foreground">Off = cannot sign in or order.</span></span>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-5 w-5 accent-primary" />
            </label>
            <label className="block text-sm font-medium">Mobile number (signs in with)
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" placeholder="10-digit mobile" className={inputCls} />
            </label>
            <div>
              <label htmlFor="shop-pin" className="block text-sm font-medium">{hasPin ? 'New PIN (leave empty to keep the current one)' : 'PIN (4–6 digits)'}</label>
              <div className="mt-1 flex gap-2">
                <input id="shop-pin" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="off" placeholder={hasPin ? 'Unchanged' : 'e.g. 482915'}
                  className="h-11 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 font-mono text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-ring" />
                <button type="button" onClick={() => setPin(randomPin())} className="h-11 shrink-0 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-muted">Make one</button>
              </div>
              {hasPin && <p className="mt-1 text-xs text-muted-foreground">A new PIN signs the retailer out on every phone.</p>}
              {locked && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Locked after wrong PINs — setting a new PIN unlocks it.</p>}
            </div>
            {msg && <p role="status" className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200' : 'bg-red-500/15 text-red-700 dark:text-red-300'}`}>{msg.text}</p>}
            <button data-primary type="submit" disabled={busy} className="h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </form>
        )}
      </section>
    </div>
  )
}
