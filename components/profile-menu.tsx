'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut, Moon, Sun, User } from 'lucide-react'
import { signOut } from '@/lib/auth-client'
import { useLanguage } from '@/lib/language-context'
import { useSessionUser } from './session-user'
import { useTheme } from './sidebar'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Round profile button (top right of every screen): name, role, English/हिंदी and Sign out. */
export function ProfileMenu() {
  const user = useSessionUser()
  const router = useRouter()
  const { language, setLanguage } = useLanguage()
  const [open, setOpen] = useState(false)
  const [signingOut, start] = useTransition()
  const [theme, setTheme] = useTheme()
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const letters = user ? initials(user.name) : ''
  const langBtn = (lang: 'en' | 'hi', label: string) => (
    <button type="button" onClick={() => setLanguage(lang)} aria-pressed={language === lang}
      className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${language === lang ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}>
      {label}
    </button>
  )

  return (
    <div ref={box} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Profile"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground ring-offset-background transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-95">
        {letters ? <span data-no-translate>{letters}</span> : <User className="h-4 w-4" aria-hidden />}
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-11 z-50 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl">
          {user && (
            <div className="mb-3 flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground" data-no-translate>{letters}</span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold" data-no-translate>{user.name}</p>
                <p className="truncate text-xs text-muted-foreground">{user.roleLabel}</p>
              </div>
            </div>
          )}
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Language</p>
          <div className="flex gap-1 rounded-lg bg-muted p-1" data-no-translate>
            {langBtn('en', 'English')}
            {langBtn('hi', 'हिंदी')}
          </div>
          <p className="mb-1.5 mt-3 text-xs font-medium text-muted-foreground">Theme</p>
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {([['dark', 'Dark', Moon], ['light', 'Light', Sun]] as const).map(([v, label, Icon]) => (
              <button key={v} type="button" onClick={() => setTheme(v)} aria-pressed={theme === v}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${theme === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}>
                <Icon className="h-4 w-4" aria-hidden />{label}
              </button>
            ))}
          </div>
          <button type="button" role="menuitem" disabled={signingOut}
            onClick={() => start(async () => { await signOut(); setOpen(false); router.push('/sign-in') })}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-muted disabled:opacity-50 dark:text-red-400">
            <LogOut className="h-4 w-4" aria-hidden />{signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  )
}
