'use client'

// Browser binding of the shortcut registry (lib/shortcuts/registry.ts): one keydown listener on the
// window for the whole app, React hooks for pages, dialog scopes and Scan boxes.
// docs/architecture/keyboard.md has the rules and the full list.

import {
  createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type ReactNode, type RefObject,
} from 'react'
import { createShortcutRegistry, type ShortcutHandler, type ShortcutOptions, type ShortcutRegistry } from './registry'

// ── DOM helpers ──────────────────────────────────────────────────────────────

const NOT_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']

/** The key goes into a text box: input (not a checkbox / radio / button), textarea, select, contenteditable. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.matches !== 'function') return false
  if (el.isContentEditable) return true
  if (el.matches('textarea, select')) return true
  if (el.matches('input')) return !NOT_TEXT.includes((el as HTMLInputElement).type)
  return false
}

/** On screen: attached and not inside a hidden tab / display:none parent. */
export function isShown(el: Element | null | undefined): boolean {
  if (!el || !el.isConnected) return false
  const h = el as HTMLElement
  if (typeof h.checkVisibility === 'function') return h.checkVisibility()
  return h.getClientRects().length > 0
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(p)
}

/** Dialogs that use registry scopes carry this attribute; others count as "foreign" (nothing fires). */
export const SCOPE_ATTR = 'data-shortcut-scope'

// ── The one registry ─────────────────────────────────────────────────────────

const scanBoxes = new Set<RefObject<HTMLElement | null>>()
let scannerPages = 0
let registry: ShortcutRegistry | null = null

export function getShortcutRegistry(): ShortcutRegistry {
  if (registry) return registry
  let mac: boolean | null = null
  registry = createShortcutRegistry({
    isMac: () => (mac ??= isMacPlatform()),
    isScannerScreen: () => scannerPages > 0 || [...scanBoxes].some((r) => isShown(r.current)),
    foreignModalOpen: () => typeof document !== 'undefined' && !!document.querySelector(
      `[aria-modal="true"]:not([${SCOPE_ATTR}]), [role="alertdialog"]:not([${SCOPE_ATTR}]), dialog[open]:not([${SCOPE_ATTR}])`,
    ),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onError: (m) => { if (process.env.NODE_ENV !== 'production') console.error(`[shortcuts] ${m}`) },
  })
  if (typeof window !== 'undefined') {
    const r = registry
    window.addEventListener('keydown', (e) => {
      r.handleKey({
        key: e.key ?? '', code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey,
        repeat: e.repeat, isComposing: e.isComposing, defaultPrevented: e.defaultPrevented,
        typing: isTypingTarget(e.target),
        preventDefault: () => e.preventDefault(),
      })
    })
  }
  return registry
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const ScopeContext = createContext<string | null>(null)

export interface UseShortcutOptions extends Omit<ShortcutOptions, 'scope' | 'isShown'> {
  /** Dialog scope id; default: the nearest <ShortcutScopeProvider> (none = the page). */
  scope?: string | null
  /** Off while false (re-registers when it changes). */
  enabled?: boolean
  /** Works only while this element is on screen (tabs kept mounted while hidden). */
  within?: RefObject<HTMLElement | null>
}

/**
 * Register a shortcut for as long as the component is mounted.
 * useShortcut('mod+k', open, { label: 'Jump to…', group: 'Global', global: true })
 */
export function useShortcut(keys: string | string[], handler: ShortcutHandler, opts: UseShortcutOptions) {
  const contextScope = useContext(ScopeContext)
  const scope = opts.scope !== undefined ? opts.scope : contextScope
  const handlerRef = useRef(handler)
  const optsRef = useRef(opts)
  useLayoutEffect(() => { handlerRef.current = handler; optsRef.current = opts })
  const keyText = Array.isArray(keys) ? keys.join('|') : keys
  const { label, group, global, allowPrint, preventDefault, action, hidden, priority, enabled = true } = opts
  const hasWhen = !!opts.when
  const hasWithin = !!opts.within
  useEffect(() => {
    if (!enabled) return
    return getShortcutRegistry().register(keyText.split('|'), (e) => handlerRef.current(e), {
      label, group, global, allowPrint, preventDefault, action, hidden, priority, scope,
      when: hasWhen ? () => optsRef.current.when?.() ?? true : undefined,
      isShown: hasWithin ? () => isShown(optsRef.current.within?.current) : undefined,
    })
  }, [keyText, scope, label, group, global, allowPrint, preventDefault, action, hidden, priority, enabled, hasWhen, hasWithin])
}

export interface ShortcutHelp { keys: string | string[]; label: string }

/**
 * List keys that a focused control handles itself (the New Order flow's Enter, digits, arrows…) in
 * the "?" cheat sheet. They are not matched by the registry.
 */
export function useShortcutHelp(entries: ShortcutHelp[], opts: { group: string; when?: () => boolean; within?: RefObject<HTMLElement | null>; enabled?: boolean }) {
  const scope = useContext(ScopeContext)
  const optsRef = useRef(opts)
  useLayoutEffect(() => { optsRef.current = opts })
  const text = JSON.stringify(entries)
  const { group, enabled = true } = opts
  const hasWhen = !!opts.when, hasWithin = !!opts.within
  useEffect(() => {
    if (!enabled) return
    const r = getShortcutRegistry()
    const offs = (JSON.parse(text) as ShortcutHelp[]).map((h) => r.register(h.keys, null, {
      label: h.label, group, scope,
      when: hasWhen ? () => optsRef.current.when?.() ?? true : undefined,
      isShown: hasWithin ? () => isShown(optsRef.current.within?.current) : undefined,
    }))
    return () => offs.forEach((off) => off())
  }, [text, group, scope, enabled, hasWhen, hasWithin])
}

/**
 * A dialog: while `active`, only shortcuts registered inside <ShortcutScopeProvider id={id}> work
 * (rule 2). Spread `scopeProps` on the dialog element so it is not treated as a foreign dialog.
 */
export function useShortcutScope(active = true): { id: string; scopeProps: Record<string, string> } {
  const [id] = useState(() => `scope-${Math.random().toString(36).slice(2, 10)}`)
  useEffect(() => {
    if (!active) return
    return getShortcutRegistry().pushScope(id)
  }, [id, active])
  return { id, scopeProps: { [SCOPE_ATTR]: id } }
}

/** Shortcuts registered by children belong to this dialog scope. */
export function ShortcutScopeProvider({ id, children }: { id: string; children: ReactNode }) {
  return <ScopeContext.Provider value={id}>{children}</ScopeContext.Provider>
}

/**
 * This text box is a barcode Scan box. While it is on screen, plain-key shortcuts are off so a
 * scanner's fast keys always reach it (rule 3).
 */
export function useScanBox(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    scanBoxes.add(ref)
    return () => { scanBoxes.delete(ref) }
  }, [ref])
}

/** The whole page is a scanner screen (camera Scanner page): plain-key shortcuts are off. */
export function useScannerScreen(active = true) {
  useEffect(() => {
    if (!active) return
    scannerPages++
    return () => { scannerPages-- }
  }, [active])
}

/** True while a Scan box is on screen or this is a scanner page (read at key time, not reactive). */
export function isScannerScreenNow(): boolean {
  return scannerPages > 0 || [...scanBoxes].some((r) => isShown(r.current))
}

/**
 * Keys typed while no text box has the cursor go to the Scan box, so a scan is never lost
 * (docs/architecture/billing-stock.md). Only while the Scan box is on screen and no dialog is open.
 * Also registers the box (useScanBox).
 */
export function useScanForwarder(ref: RefObject<HTMLInputElement | null>, append: (ch: string) => void, blocked?: () => boolean) {
  useScanBox(ref)
  const appendRef = useRef(append)
  const blockedRef = useRef(blocked)
  useLayoutEffect(() => { appendRef.current = append; blockedRef.current = blocked })
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Radio buttons and checkboxes do not take typing: a scan then still reaches the Scan box.
      if (isTypingTarget(event.target)) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return
      if (blockedRef.current?.() || document.querySelector('[role="dialog"]')) return
      const input = ref.current
      if (!input || !isShown(input)) return
      event.preventDefault()
      input.focus({ preventScroll: true })
      appendRef.current(event.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ref])
}

/** Re-render when the registry changes (cheat sheet, Ctrl+K actions, chord hint). */
export function useRegistryVersion(): number {
  const r = getShortcutRegistry()
  return useSyncExternalStore(r.subscribe, r.version, () => 0)
}

/** "g" while waiting for the second key of a chord, else null. */
export function usePendingChord(): string | null {
  useRegistryVersion()
  return getShortcutRegistry().pendingChord()
}
