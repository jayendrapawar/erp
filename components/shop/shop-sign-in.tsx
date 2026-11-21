'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { shopSignIn } from '@/app/actions/shop'

export function ShopSignIn() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, start] = useTransition()

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary font-display text-2xl font-bold text-primary-foreground">S</span>
          <h1 className="text-2xl font-bold">Shayona order app</h1>
          <p className="text-sm text-muted-foreground">See our articles and place your order. Sign in with the mobile number and PIN the shop gave you.</p>
        </div>
        <form className="space-y-4 rounded-2xl border border-border bg-card p-5" onSubmit={(e) => {
          e.preventDefault()
          start(async () => {
            setError(null)
            try {
              const r = await shopSignIn(phone, pin)
              if (r.ok) { router.replace('/shop'); router.refresh() } else setError(r.message)
            } catch { setError('Network problem. Try again.') }
          })
        }}>
          <label className="block text-sm font-medium">Mobile number
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="98250 00000" autoFocus
              className="mt-1 h-12 w-full rounded-xl border border-input bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="block text-sm font-medium">PIN
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" type="password" autoComplete="current-password" placeholder="••••"
              className="mt-1 h-12 w-full rounded-xl border border-input bg-background px-3 text-base tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-ring" />
          </label>
          {error && <p role="alert" className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
          <button type="submit" disabled={busy || !phone.trim() || pin.length < 4}
            className="h-12 w-full rounded-xl bg-primary text-base font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-center text-xs text-muted-foreground">No PIN yet, or forgot it? Ask Shayona to set one for you.</p>
      </div>
    </main>
  )
}
