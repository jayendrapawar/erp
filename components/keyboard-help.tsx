'use client'

// "?" cheat sheet on every staff page (computers). Built from the shortcut registry: the global
// shortcuts first, then the ones the current page registered, by group. No hand-written lists.
// The sidebar and New Order have a "?" button for it (openKeyboardHelp).

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  formatShortcut, getShortcutRegistry, isMacPlatform, isScannerScreenNow, useRegistryVersion, useShortcut,
  useShortcutHelp, type ListedShortcut,
} from '@/lib/shortcuts'
import { useDialogKeys } from '@/lib/shortcuts/dialog'

const OPEN_EVENT = 'shayona:keyboard-help'
const GLOBAL_ORDER = ['Global', 'Go to', 'Dialog']

/** Open the cheat sheet (the "?" buttons). */
export function openKeyboardHelp() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function KeyboardHelp() {
  const pathname = usePathname() ?? ''
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, on)
    return () => window.removeEventListener(OPEN_EVENT, on)
  }, [])
  useShortcut('?', () => setOpen((o) => !o), { label: 'Keyboard shortcuts (this list)', group: 'Global', global: true })
  // How every dialog and form behaves (lib/shortcuts/dialog.ts): listed once, here.
  useShortcutHelp([
    { keys: 'escape', label: 'Close the dialog; focus goes back where it was' },
    { keys: 'mod+enter', label: 'Save / confirm the dialog' },
    { keys: ['tab', 'shift+tab'], label: 'Next / previous field (stays inside a dialog)' },
  ], { group: 'Dialog', global: true })
  // Never in the retailer shop.
  if (!open || pathname === '/shop' || pathname.startsWith('/shop/')) return null
  return <Sheet onClose={() => setOpen(false)} />
}

function Sheet({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const { scope, dialogProps } = useDialogKeys(box, { onClose, initialFocus: closeBtn })
  useShortcut('?', onClose, { label: 'Close', scope, hidden: true })
  useRegistryVersion()
  const [mac] = useState(isMacPlatform)
  const scanner = isScannerScreenNow()

  // What the page has registered underneath this sheet.
  const all = getShortcutRegistry().list(scope)
  const groups = new Map<string, ListedShortcut[]>()
  for (const s of all) {
    if (!groups.has(s.group)) groups.set(s.group, [])
    groups.get(s.group)!.push(s)
  }
  // Global groups first (in a fixed order), then the page's groups in the order it registered them.
  const rank = (g: string) => { const i = GLOBAL_ORDER.indexOf(g); return i < 0 ? GLOBAL_ORDER.length : i }
  const isGlobal = (g: string) => groups.get(g)!.some((s) => s.global)
  const names = [
    ...[...groups.keys()].filter(isGlobal).sort((a, b) => rank(a) - rank(b)),
    ...[...groups.keys()].filter((g) => !isGlobal(g)),
  ]

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 p-4 pt-[8vh]" onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-help-title"
        {...dialogProps}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[84vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 id="kb-help-title" className="text-base font-semibold">⌨ Keyboard shortcuts</h2>
          <button ref={closeBtn} type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-lg hover:bg-muted">×</button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {scanner && (
            <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              A Scan box is on this screen: single-key shortcuts are off so the barcode scanner&apos;s keys always reach it. Ctrl combinations and Esc still work.
            </p>
          )}
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {names.map((g) => (
              <section key={g} aria-labelledby={`kb-${g}`}>
                <h3 id={`kb-${g}`} className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g}</h3>
                <dl className="space-y-1 text-[13px]">
                  {groups.get(g)!.map((s) => (
                    <div key={s.id} className={`flex items-start gap-3 ${s.offHere ? 'opacity-45' : ''}`}>
                      <dt className="flex w-32 shrink-0 flex-wrap gap-1" data-no-translate>
                        {s.display
                          ? <Kbd>{s.display}</Kbd>
                          : s.keys.map((k, i) => <span key={k} className="flex items-center gap-1">{i > 0 && <span className="text-muted-foreground">/</span>}<Kbd>{formatShortcut(k, mac)}</Kbd></span>)}
                      </dt>
                      <dd className="text-muted-foreground">{s.label}{s.offHere && <span className="sr-only"> (off on this screen)</span>}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
        <p className="border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground">
          Single-key shortcuts don&apos;t work while typing in a box; Ctrl combinations and Esc do. Press <Kbd>?</Kbd> or <Kbd>Esc</Kbd> to close.
        </p>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] font-semibold text-foreground">{children}</kbd>
}
