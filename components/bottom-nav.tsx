'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { BarChart2, BookOpen, Boxes, Home, LogOut, Menu, Package, ScanBarcode, ShoppingCart, X, type LucideIcon } from 'lucide-react'
import { signOut } from '@/lib/auth-client'
import { useLanguage } from '@/lib/language-context'
import { BAR_SLOTS, type NavIcon, type NavItem } from '@/lib/nav'

const ICONS: Record<NavIcon, LucideIcon> = {
  home: Home, scanner: ScanBarcode, inventory: Boxes, orders: ShoppingCart, purchases: Package, master: BookOpen, reports: BarChart2,
}

const HIDDEN_ON = ['/sign-in', '/sign-up']

/** Phone-only bottom bar (hidden from md up): the role's main modules + "More" (all modules, language, sign out). */
export function BottomNav({ items, userName, roleLabel }: { items: NavItem[]; userName: string; roleLabel: string }) {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const { language, setLanguage, t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [signingOut, start] = useTransition()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (HIDDEN_ON.some((p) => pathname.startsWith(p))) return null
  const bar = items.slice(0, BAR_SLOTS)
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)
  const moreActive = !bar.some((i) => isActive(i.href))

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
                  className={`flex h-16 flex-col items-center justify-start gap-1 px-0.5 pt-2.5 text-center text-[11px] font-medium leading-tight transition-colors ${on ? 'text-foreground' : 'text-muted-foreground'}`}>
                  <Icon className={`h-5 w-5 ${on ? 'stroke-[2.4]' : ''}`} aria-hidden />
                  {t(i.label)}
                </Link>
              </li>
            )
          })}
          <li>
            <button onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}
              className={`flex h-16 w-full flex-col items-center justify-start gap-1 px-0.5 pt-2.5 text-center text-[11px] font-medium leading-tight ${moreActive || open ? 'text-foreground' : 'text-muted-foreground'}`}>
              <Menu className="h-5 w-5" aria-hidden />
              {t('navMore')}
            </button>
          </li>
        </ul>
      </nav>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{userName}</p>
                <p className="truncate text-xs text-muted-foreground">{roleLabel}</p>
              </div>
              <button onClick={() => setOpen(false)} aria-label={t('closeMenu')} className="rounded-lg border border-border p-1.5"><X className="h-4 w-4" /></button>
            </div>
            <ul className="grid grid-cols-3 gap-2">
              {items.map((i) => {
                const Icon = ICONS[i.icon]
                const on = isActive(i.href)
                return (
                  <li key={i.href}>
                    <Link href={i.href} onClick={() => setOpen(false)} className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium ${on ? 'border-foreground bg-muted text-foreground' : 'border-border text-foreground'}`}>
                      <Icon className="h-5 w-5" aria-hidden />
                      {t(i.label)}
                    </Link>
                  </li>
                )
              })}
            </ul>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')} className="rounded-xl border border-border px-3 py-3 text-sm font-medium">
                {language === 'en' ? 'हिंदी' : 'English'}
              </button>
              <button disabled={signingOut} onClick={() => start(async () => { await signOut(); router.push('/sign-in') })}
                className="flex items-center justify-center gap-2 rounded-xl border border-border px-3 py-3 text-sm font-medium text-red-600 disabled:opacity-50">
                <LogOut className="h-4 w-4" aria-hidden />{signingOut ? t('signingOut') : t('signOut')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
