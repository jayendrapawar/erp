'use client'

// Left sidebar on computers (redesign, owner 21 Nov 2026). Grouped menu, sub-items that open a tab
// of the page (/master#articles), "Jump to…" (Ctrl K), theme and language switches, profile and
// sign out. Collapses to icons; the choice is remembered per device. Phones keep the bottom bar.
// No database queries: the menu comes from the user's roles (components/app-nav.tsx).

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  BarChart2, BookOpen, Boxes, ChevronDown, Home, LogOut, Moon, Package, PanelLeftClose, PanelLeftOpen,
  ScanBarcode, Search, ShoppingCart, Sun, type LucideIcon,
} from 'lucide-react'
import { signOut } from '@/lib/auth-client'
import { useLanguage } from '@/lib/language-context'
import { applyTheme, currentTheme, type Theme } from '@/lib/theme'
import type { NavIcon, SideLink, SideSection } from '@/lib/nav'
import { useSessionUser } from './session-user'

const ICONS: Record<NavIcon, LucideIcon> = {
  home: Home, scanner: ScanBarcode, inventory: Boxes, orders: ShoppingCart, purchases: Package, master: BookOpen, reports: BarChart2,
}
const HIDDEN_ON = ['/', '/sign-in', '/sign-up']
const COLLAPSE_KEY = 'shayona.sidebar.collapsed'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/**
 * Open a menu link. A tab of the page already open (/master#articles while on /master) only changes
 * the hash and tells the page (it listens to "hashchange"); anything else is a normal navigation.
 */
export function useOpenLink() {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  return useCallback((href: string) => {
    const [path, hash] = href.split('#')
    if (hash && path === pathname) {
      window.history.pushState(null, '', href)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    } else {
      router.push(href)
    }
  }, [router, pathname])
}

/** The theme in use, kept in step with switches made elsewhere (profile menu). */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('dark')
  useEffect(() => {
    setTheme(currentTheme())
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail)
    window.addEventListener('shayona:theme', on)
    return () => window.removeEventListener('shayona:theme', on)
  }, [])
  return [theme, applyTheme]
}

export function Sidebar({ sections }: { sections: SideSection[] }) {
  const pathname = usePathname() ?? ''
  const openLink = useOpenLink()
  const user = useSessionUser()
  const { language, setLanguage } = useLanguage()
  const [theme, setTheme] = useTheme()
  const [hash, setHash] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [jumpOpen, setJumpOpen] = useState(false)
  const [signingOut, startSignOut] = useTransition()
  const router = useRouter()

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1') } catch { /* default open */ }
  }, [])
  useEffect(() => {
    const read = () => setHash(window.location.hash.replace('#', ''))
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [pathname])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setJumpOpen((o) => !o) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Not on sign-in pages, and never in the retailer shop (/shop), even if staff are signed in.
  if (HIDDEN_ON.includes(pathname) || pathname === '/shop' || pathname.startsWith('/shop/')) return null

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1') } catch { /* this visit only */ }
      return !c
    })
  }
  const onPath = (href: string) => { const p = href.split('#')[0]; return pathname === p || pathname.startsWith(`${p}/`) }
  const childActive = (l: SideLink) => l.children?.find((c) => c.href.split('#')[1] === hash && onPath(c.href))
  const letters = user ? initials(user.name) : ''

  return (
    <>
      {/* Keeps the page clear of the pinned menu (same width). The menu itself is fixed to the screen:
          "sticky" does not work here because <html>/<body> hide sideways overflow. */}
      <div aria-hidden className={`hidden shrink-0 md:block ${collapsed ? 'w-[72px]' : 'w-64'}`} />
      <aside
        aria-label="Main menu"
        className={`fixed inset-y-0 left-0 z-30 hidden h-dvh flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex ${collapsed ? 'w-[72px]' : 'w-64'}`}
      >
        <div className={`flex items-center gap-2.5 px-4 pb-3 pt-4 ${collapsed ? 'justify-center px-2' : ''}`}>
          <Link href="/home" className="flex min-w-0 items-center gap-2.5" aria-label="Shayona home">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary font-display text-lg font-bold text-primary-foreground">S</span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block font-display text-base font-bold leading-tight text-foreground" data-no-translate>Shayona</span>
                <span className="block text-[11px] text-muted-foreground">Footwear · Udhna</span>
              </span>
            )}
          </Link>
        </div>

        <div className={collapsed ? 'px-3 pb-2' : 'px-3.5 pb-2'}>
          <button
            type="button"
            onClick={() => setJumpOpen(true)}
            aria-label="Jump to a page (Ctrl K)"
            className={`flex h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background/60 text-sm text-muted-foreground transition-colors hover:text-foreground ${collapsed ? 'justify-center' : 'px-2.5'}`}
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden />
            {!collapsed && <><span className="flex-1 text-left">Jump to…</span><kbd className="rounded border border-sidebar-border px-1.5 text-[10px]" data-no-translate>Ctrl K</kbd></>}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-3 no-scrollbar">
          {sections.map((s) => (
            <div key={s.title ?? 'top'} className="mt-3 first:mt-1">
              {s.title && !collapsed && <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{s.title}</p>}
              {s.title && collapsed && <div className="mx-3 mb-2 border-t border-sidebar-border" aria-hidden />}
              <ul className="space-y-0.5">
                {s.links.map((l) => {
                  const Icon = l.icon ? ICONS[l.icon] : null
                  const active = onPath(l.href)
                  const kids = l.children ?? []
                  const open = kids.length > 0 && !collapsed && (expanded[l.href] ?? active)
                  return (
                    <li key={l.href}>
                      <div className="flex items-center">
                        <Link
                          href={l.href}
                          aria-current={active && !childActive(l) ? 'page' : undefined}
                          title={collapsed ? l.label : undefined}
                          className={`flex min-h-10 flex-1 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors ${collapsed ? 'justify-center' : ''} ${active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent/60 hover:text-foreground'}`}
                        >
                          {Icon && <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />}
                          {!collapsed && <span className="truncate">{l.label}</span>}
                        </Link>
                        {kids.length > 0 && !collapsed && (
                          <button
                            type="button"
                            onClick={() => setExpanded((e) => ({ ...e, [l.href]: !open }))}
                            aria-label={open ? `Hide ${l.label} sections` : `Show ${l.label} sections`}
                            aria-expanded={open}
                            className="ml-0.5 flex h-10 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
                          >
                            <ChevronDown className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden />
                          </button>
                        )}
                      </div>
                      {open && (
                        <ul className="mb-1 ml-[21px] mt-0.5 space-y-0.5 border-l border-sidebar-border pl-3">
                          {kids.map((c) => {
                            const on = onPath(c.href) && c.href.split('#')[1] === hash
                            return (
                              <li key={c.href}>
                                <a
                                  href={c.href}
                                  onClick={(e) => { e.preventDefault(); openLink(c.href) }}
                                  aria-current={on ? 'page' : undefined}
                                  className={`flex min-h-8 items-center rounded-md px-2 text-[13px] transition-colors ${on ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground' : 'text-sidebar-foreground hover:text-foreground'}`}
                                >
                                  {c.label}
                                </a>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className={`border-t border-sidebar-border p-3 ${collapsed ? 'space-y-2' : 'space-y-2.5'}`}>
          <div className={`flex gap-1.5 ${collapsed ? 'flex-col items-center' : ''}`}>
            <button
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              className={`flex h-9 items-center justify-center gap-2 rounded-lg border border-sidebar-border text-xs font-medium hover:bg-sidebar-accent/60 hover:text-foreground ${collapsed ? 'w-9' : 'flex-1'}`}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
              {!collapsed && (theme === 'dark' ? 'Light' : 'Dark')}
            </button>
            <button
              type="button"
              onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')}
              aria-label={language === 'en' ? 'हिंदी में देखें' : 'View in English'}
              className={`flex h-9 items-center justify-center rounded-lg border border-sidebar-border text-xs font-semibold hover:bg-sidebar-accent/60 hover:text-foreground ${collapsed ? 'w-9' : 'flex-1'}`}
              data-no-translate
            >
              {collapsed ? (language === 'en' ? 'हि' : 'EN') : (language === 'en' ? 'हिंदी' : 'English')}
            </button>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Open the menu' : 'Make the menu narrow'}
              title={collapsed ? 'Open the menu' : 'Make the menu narrow'}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-sidebar-border hover:bg-sidebar-accent/60 hover:text-foreground"
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden /> : <PanelLeftClose className="h-4 w-4" aria-hidden />}
            </button>
          </div>
          {user && (
            <div className={`flex items-center gap-2.5 ${collapsed ? 'flex-col' : ''}`}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-sm font-semibold text-sidebar-accent-foreground" data-no-translate title={collapsed ? user.name : undefined}>{letters}</span>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground" data-no-translate>{user.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.roleLabel}</p>
                </div>
              )}
              <button
                type="button"
                disabled={signingOut}
                onClick={() => startSignOut(async () => { await signOut(); router.push('/sign-in') })}
                aria-label="Sign out"
                title="Sign out"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent/60 hover:text-red-500 disabled:opacity-50"
              >
                <LogOut className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}
        </div>
      </aside>

      {jumpOpen && <JumpTo sections={sections} onClose={() => setJumpOpen(false)} onOpen={(href) => { setJumpOpen(false); openLink(href) }} />}
    </>
  )
}

/** "Jump to…" (Ctrl K): type part of a page or tab name, arrows to move, Enter to open. */
function JumpTo({ sections, onClose, onOpen }: { sections: SideSection[]; onClose: () => void; onOpen: (href: string) => void }) {
  const [q, setQ] = useState('')
  const [pos, setPos] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const all = useMemo(() => sections.flatMap((s) => s.links.flatMap((l) => [
    { href: l.href, label: l.label, where: s.title ?? '' },
    ...(l.children ?? []).map((c) => ({ href: c.href, label: c.label, where: l.label })),
  ])), [sections])
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
  const shown = all.filter((x) => !q || norm(`${x.label} ${x.where}`).includes(norm(q)))

  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { setPos(0) }, [q])

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Jump to a page" className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') { e.preventDefault(); setPos((p) => Math.min(p + 1, shown.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setPos((p) => Math.max(p - 1, 0)) }
              else if (e.key === 'Enter' && shown[pos]) onOpen(shown[pos].href)
            }}
            placeholder="Type a page or tab, e.g. articles, biller"
            aria-label="Page or tab"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-2">
          {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No page or tab matches.</li>}
          {shown.map((x, i) => (
            <li key={x.href}>
              <button
                type="button"
                onMouseEnter={() => setPos(i)}
                onClick={() => onOpen(x.href)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${i === pos ? 'bg-accent text-accent-foreground' : 'text-foreground'}`}
              >
                <span className="font-medium">{x.label}</span>
                <span className="text-xs text-muted-foreground">{x.where}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
