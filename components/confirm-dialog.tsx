'use client'

// "Are you sure?" for computers (docs/architecture/keyboard.md), replacing window.confirm:
//   const ok = await askConfirm({ message: 'Discard this draft?', confirmLabel: 'Discard', destructive: true })
// Enter presses the focused button and Esc cancels. For anything destructive Cancel has the focus
// first, so a stray Enter is safe (Tab to the red button, or Ctrl+Enter, confirms). Focus returns
// to the button that asked. Phones and tablets keep the browser's own confirm box, as before.

import { useEffect, useState } from 'react'
import { DialogKeys } from './dialog-keys'

export interface ConfirmOptions {
  message: string
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

const EVENT = 'shayona:confirm'
type Ask = ConfirmOptions & { resolve: (ok: boolean) => void }

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  const host = (window as Window & { __shayonaConfirmHost?: boolean }).__shayonaConfirmHost
  if (!host || window.matchMedia('(pointer: coarse)').matches) return Promise.resolve(window.confirm(opts.message))
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent<Ask>(EVENT, { detail: { ...opts, resolve } })))
}

/** Mounted once in the app shell. */
export function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(null)
  useEffect(() => {
    const w = window as Window & { __shayonaConfirmHost?: boolean }
    w.__shayonaConfirmHost = true
    const on = (e: Event) => setAsk((e as CustomEvent<Ask>).detail)
    window.addEventListener(EVENT, on)
    return () => { w.__shayonaConfirmHost = false; window.removeEventListener(EVENT, on) }
  }, [])
  if (!ask) return null
  const done = (ok: boolean) => { setAsk(null); ask.resolve(ok) }
  const red = !!ask.destructive
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 px-4" onClick={() => done(false)}>
      <DialogKeys onClose={() => done(false)} label={ask.title ?? 'Please confirm'} />
      <div role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-msg" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-xl">
        <h2 id="confirm-title" className="text-base font-semibold">{ask.title ?? 'Please confirm'}</h2>
        <p id="confirm-msg" className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{ask.message}</p>
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={() => done(false)} {...(red ? { 'data-autofocus': '' } : {})}
            className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
            {ask.cancelLabel ?? 'Cancel'}
          </button>
          <button type="button" onClick={() => done(true)} data-primary {...(red ? { 'data-destructive': '' } : { 'data-autofocus': '' })}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold ${red ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-primary text-primary-foreground hover:opacity-90'}`}>
            {ask.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
