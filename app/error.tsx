'use client' // Error boundaries must be Client Components

// When a page cannot be loaded — most often the database waking up (Neon free plan sleeps after 5
// minutes) or a dropped connection — show this instead of the sign-in page (owner reported "logged
// out by itself", 22 Nov 2026). It tries once more by itself, then offers Try again / Home.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const tried = useRef(false)
  const [auto, setAuto] = useState(true)

  useEffect(() => {
    console.error('[page error]', error)
    if (tried.current) { setAuto(false); return }
    tried.current = true
    const t = setTimeout(() => retry(), 1500)
    return () => clearTimeout(t)
  }, [error, retry])

  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center" role="alert">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/15 text-2xl" aria-hidden>⟳</span>
      <h1 className="text-xl font-bold">{auto ? 'Connecting…' : 'Could not load this page'}</h1>
      <p className="text-sm text-muted-foreground">
        {auto
          ? 'The server is waking up. Trying again…'
          : 'The connection to the server dropped or is slow. You are still signed in — nothing you saved is lost.'}
      </p>
      {!auto && (
        <div className="flex gap-2">
          <button type="button" onClick={() => retry()} className="h-11 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground hover:bg-primary/90">Try again</button>
          <Link href="/home" className="flex h-11 items-center rounded-xl border border-border px-5 text-sm font-semibold hover:bg-muted">Home</Link>
        </div>
      )}
      {error.digest && <p className="text-[11px] text-muted-foreground">Ref: {error.digest}</p>}
    </div>
  )
}
