'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart2, BookOpen, Boxes, Home, Menu, Package, ScanBarcode, ShoppingCart, X, type LucideIcon } from 'lucide-react'
import { useLanguage } from '@/lib/language-context'
import { BAR_SLOTS, type NavIcon, type NavItem } from '@/lib/nav'

const ICONS: Record<NavIcon, LucideIcon> = {
  home: Home, scanner: ScanBarcode, inventory: Boxes, orders: ShoppingCart, purchases: Package, master: BookOpen, reports: BarChart2,
}

/** No bar on Home (its tiles are the menu) or on the sign-in pages. */
const HIDDEN_ON = ['/home', '/sign-in', '/sign-up', '/shop']

/**
 * Phone-only bottom bar (hidden from md up): the role's main modules + "More" (every module).
 * Language and Sign out are in the profile menu (top right).
 */
export function BottomNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? ''
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (pathname === '/' || HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null
  const bar = items.slice(0, BAR_SLOTS)
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)
  const moreActive = !bar.some((i) => isActive(i.href))
  const cell = 'flex h-16 flex-col items-center justify-start gap-1 px-0.5 pt-2.5 text-center text-[11px] font-medium leading-tight'

  return (
    <>
      {/* Keeps page content clear of the fixed bar. */}
      <div aria-hidden className="h-[calc(4rem+env(safe-area-inset-bottom))] md:hidden" />
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 pb-[env(safe-area-inset-bottom)] md:hidden">
        <ul className="mx-auto grid max-w-md" style={{ gridTemplateColumns: `repeat(${bar.length + 1}, minmax(0, 1fr))` }}>
          {bar.map((i) => {
            const Icon = ICONS[i.icon]
            const on = isActive(i.href)
            return (
              <li key={i.href}>
                <Link href={i.href} aria-current={on ? 'page' : undefined}
                  className={`${cell} transition-colors ${on ? 'text-foreground' : 'text-muted-foreground'}`}>
                  <Icon className={`h-5 w-5 ${on ? 'stroke-[2.4]' : ''}`} aria-hidden />
                  {t(i.label)}
                </Link>
              </li>
            )
          })}
          <li>
            <button onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}
              className={`${cell} w-full ${moreActive || open ? 'text-foreground' : 'text-muted-foreground'}`}>
              <Menu className="h-5 w-5" aria-hidden />
              {t('navMore')}
            </button>
          </li>
        </ul>
      </nav>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label={t('navMore')}>
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-foreground">{t('navMore')}</p>
              <button onClick={() => setOpen(false)} aria-label={t('closeMenu')} className="rounded-lg border border-border p-1.5"><X className="h-4 w-4" /></button>
            </div>
            <ul className="grid grid-cols-3 gap-2">
              {items.map((i) => {
                const Icon = ICONS[i.icon]
                const on = isActive(i.href)
                return (
                  <li key={i.href}>
                    <Link href={i.href} onClick={() => setOpen(false)} className={`flex h-full flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center text-xs font-medium ${on ? 'border-foreground bg-muted text-foreground' : 'border-border text-foreground'}`}>
                      <Icon className="h-5 w-5" aria-hidden />
                      {t(i.label)}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}
