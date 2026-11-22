'use client'

// Go-to chords on every staff page: press g, let go, then a letter (g h Home, g o Orders…).
// Only the user's own pages (lib/nav.ts goToTargets). A small "g…" hint shows while the second key
// is awaited; it cancels after 1.5 s or on Esc (lib/shortcuts/registry.ts). Off while typing and on
// scanner / billing screens (use Ctrl K there).

import { usePathname } from 'next/navigation'
import type { GoToTarget } from '@/lib/nav'
import { usePendingChord, useShortcut } from '@/lib/shortcuts'
import { useOpenLink } from './sidebar'

function GoTo({ t, open }: { t: GoToTarget; open: (href: string) => void }) {
  useShortcut(`g ${t.letter}`, () => open(t.href), { label: t.label, group: 'Go to', global: true })
  return null
}

export function GoToKeys({ targets }: { targets: GoToTarget[] }) {
  const open = useOpenLink()
  const pending = usePendingChord()
  const pathname = usePathname() ?? ''
  // Not on sign-in pages, never in the retailer shop (same as the sidebar).
  if (['/', '/sign-in', '/sign-up'].includes(pathname) || pathname === '/shop' || pathname.startsWith('/shop/')) return null
  return (
    <>
      {targets.map((t) => <GoTo key={t.letter} t={t} open={open} />)}
      {pending === 'g' && (
        <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-20 left-1/2 z-[80] -translate-x-1/2 rounded-xl border border-border bg-popover px-3.5 py-2 text-xs shadow-xl md:bottom-6">
          <span className="font-mono text-sm font-bold">g…</span>
          <span className="ml-2 text-muted-foreground" data-no-translate>
            {targets.map((t) => `${t.letter} ${t.label}`).join(' · ')}
          </span>
        </div>
      )}
    </>
  )
}
