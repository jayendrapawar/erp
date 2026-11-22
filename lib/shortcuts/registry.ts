// One shortcut system for the whole app (docs/architecture/keyboard.md). Pure: the browser binding
// (lib/shortcuts/react.tsx) supplies the environment, tests supply a fake one.
//
// Rules, the same on every screen:
//  1. Plain keys and chords never fire while typing in an input, textarea, select or contenteditable.
//     Ctrl/Cmd combinations and Esc do.
//  2. While a dialog is open only that dialog's own shortcuts work.
//  3. While a Scan box is on screen (scanner / billing), only Ctrl/Cmd combinations and Esc work, so a
//     barcode scanner's fast keys always reach the Scan box.
//  4. "mod" = Ctrl on Windows, Cmd on a Mac. Browser keys staff rely on can't be taken.
//  5. A key a focused control already handled (preventDefault) is left alone.

import {
  comboEquals, eventCombo, isEscape, isModCombo, isModifierKey, isPlain, parseSequence, reservedReason,
  type Combo, type KeyLike, type Sequence,
} from './keys'

export const CHORD_TIMEOUT_MS = 1500

export interface KeyEventLike extends KeyLike {
  /** The key went to a text box (input, textarea, select, contenteditable). */
  typing: boolean
  repeat?: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
  preventDefault(): void
}

/** Return false to say "not handled": the key then goes on as if no shortcut matched. */
export type ShortcutHandler = (e: KeyEventLike | null) => void | boolean

export interface ShortcutOptions {
  /** Shown in the "?" cheat sheet and Ctrl+K actions. */
  label: string
  /** Cheat-sheet heading. Default "This page". */
  group?: string
  /** App-wide (shell): listed before the page's shortcuts. */
  global?: boolean
  /** Extra condition checked on every key press. */
  when?: () => boolean
  /** Set by the React hook: the part of the page the shortcut belongs to is on screen. */
  isShown?: () => boolean
  /** Dialog scope id (set by the React hook from the nearest dialog). null = the page. */
  scope?: string | null
  /** Ctrl+P: only on screens that print bills or pick lists. */
  allowPrint?: boolean
  /** Default true. */
  preventDefault?: boolean
  /** Also offered in Ctrl+K as "> action" (needs a handler). */
  action?: boolean
  /** Not listed in the cheat sheet. */
  hidden?: boolean
  /** Higher wins when two shortcuts on screen use the same key. Default 0; later wins on a tie. */
  priority?: number
  /** Listed-only entries (no handler): text shown instead of the keys, e.g. "1–9". */
  display?: string
}

export interface RegistryEnv {
  isMac(): boolean
  /** A Scan box (barcode scanner input) is on screen, or this is the Scanner page. */
  isScannerScreen(): boolean
  /** A modal dialog is open that does not use registry scopes (fallback: nothing fires). */
  foreignModalOpen(): boolean
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  onError?(message: string): void
}

interface Entry {
  id: number
  keys: string[]
  seqs: Sequence[]
  handler: ShortcutHandler | null
  opts: ShortcutOptions
}

export interface ListedShortcut {
  id: number
  keys: string[]
  label: string
  group: string
  global: boolean
  /** Plain-key shortcut that is switched off right now (a Scan box is on screen). */
  offHere: boolean
  display?: string
}

export interface ListedAction extends ListedShortcut { run: () => void }

export type ShortcutRegistry = ReturnType<typeof createShortcutRegistry>

export function createShortcutRegistry(env: RegistryEnv) {
  const entries = new Map<number, Entry>()
  const scopes: string[] = []
  const listeners = new Set<() => void>()
  let nextId = 1
  let version = 0
  let pending: { combo: Combo; timer: unknown } | null = null

  const notify = () => { version++; for (const l of [...listeners]) l() }

  /** The dialog whose shortcuts work now (null = the page), ignoring the given scope. */
  const activeScope = (ignore?: string): string | null => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i] !== ignore) return scopes[i]
    return null
  }

  const live = (e: Entry, ignoreScope?: string): boolean => {
    const top = activeScope(ignoreScope)
    const scope = e.opts.scope ?? null
    if (top !== null ? scope !== top : scope !== null || env.foreignModalOpen()) return false
    if (e.opts.when && !e.opts.when()) return false
    if (e.opts.isShown && !e.opts.isShown()) return false
    return true
  }

  /** Which keys may fire now, whatever is registered. */
  const allowed = (c: Combo, typing: boolean, scanner: boolean): boolean => {
    if (isModCombo(c) || isEscape(c)) return true
    return !typing && !scanner
  }

  const byPriority = (a: Entry, b: Entry) => (b.opts.priority ?? 0) - (a.opts.priority ?? 0) || b.id - a.id

  const fire = (e: KeyEventLike, candidates: Entry[]): boolean => {
    for (const entry of candidates.sort(byPriority)) {
      if (!entry.handler) continue
      if (entry.handler(e) === false) continue
      if (entry.opts.preventDefault !== false) e.preventDefault()
      return true
    }
    return false
  }

  const cancelChord = () => {
    if (!pending) return
    env.clearTimer(pending.timer)
    pending = null
    notify()
  }

  return {
    /** Add a shortcut. Returns the function that removes it. handler null = listed only (a focused control handles it). */
    register(keys: string | string[], handler: ShortcutHandler | null, opts: ShortcutOptions): () => void {
      const list = Array.isArray(keys) ? keys : [keys]
      let seqs: Sequence[]
      try {
        seqs = !handler && opts.display ? [] : list.map(parseSequence)
      } catch (err) {
        env.onError?.(String(err instanceof Error ? err.message : err))
        return () => {}
      }
      for (let i = 0; i < seqs.length; i++) {
        const why = handler ? reservedReason(seqs[i], !!opts.allowPrint) : null
        if (why) { env.onError?.(`Shortcut "${list[i]}" not registered: ${why}`); return () => {} }
      }
      const id = nextId++
      entries.set(id, { id, keys: list, seqs, handler, opts })
      notify()
      return () => { if (entries.delete(id)) notify() }
    },

    /** A dialog opened: from now on only shortcuts registered with this scope work, until it closes. */
    pushScope(id: string): () => void {
      scopes.push(id)
      cancelChord()
      notify()
      return () => {
        const i = scopes.lastIndexOf(id)
        if (i >= 0) { scopes.splice(i, 1); notify() }
      }
    },

    activeScope: () => activeScope(),

    /** Handle one key press. True when a shortcut used it. */
    handleKey(e: KeyEventLike): boolean {
      if (e.defaultPrevented || e.isComposing || isModifierKey(e.key)) return false
      const c = eventCombo(e, env.isMac())
      const scanner = env.isScannerScreen()

      if (pending) {
        const first = pending.combo
        cancelChord()
        if (isEscape(c)) { e.preventDefault(); return true }
        if (!e.typing && !scanner && isPlain(c)) {
          const hits = [...entries.values()].filter((x) => live(x) && x.seqs.some((s) => s.length === 2 && comboEquals(s[0], first) && comboEquals(s[1], c)))
          if (fire(e, hits)) return true
        }
        // Not a chord: the key goes on as a normal key press.
      }

      if (!allowed(c, e.typing, scanner)) return false

      const hits = [...entries.values()].filter((x) => live(x) && x.seqs.some((s) => s.length === 1 && comboEquals(s[0], c)))
      if (fire(e, hits)) return true

      // First key of a chord ("g" of "g h"): wait up to 1.5 s for the second.
      if (isPlain(c) && !e.repeat) {
        const starts = [...entries.values()].some((x) => x.handler && live(x) && x.seqs.some((s) => s.length === 2 && comboEquals(s[0], c)))
        if (starts) {
          pending = { combo: c, timer: env.setTimer(cancelChord, CHORD_TIMEOUT_MS) }
          notify()
          e.preventDefault()
          return true
        }
      }
      return false
    },

    /** First key of a chord being waited for ("g"), or null. */
    pendingChord: (): string | null => pending?.combo.key ?? null,
    cancelChord,

    /** What the "?" cheat sheet shows: shortcuts that work on this screen, global ones first. */
    list(ignoreScope?: string): ListedShortcut[] {
      const scanner = env.isScannerScreen()
      const seen = new Set<string>()
      const out: ListedShortcut[] = []
      for (const e of entries.values()) {
        if (e.opts.hidden || !live(e, ignoreScope)) continue
        const group = e.opts.group ?? 'This page'
        const key = `${group}\u0000${e.opts.label}\u0000${e.keys.join(',')}`
        if (seen.has(key)) continue
        seen.add(key)
        // Keys a focused control handles itself (no handler) are not switched off by the registry.
        const offHere = !!e.handler && scanner && e.seqs.every((s) => s.length === 2 || !(isModCombo(s[0]) || isEscape(s[0])))
        out.push({ id: e.id, keys: e.keys, label: e.opts.label, group, global: !!e.opts.global, offHere, display: e.opts.display })
      }
      return out.sort((a, b) => Number(b.global) - Number(a.global))
    },

    /** Ctrl+K "> " actions on this screen. */
    actions(ignoreScope?: string): ListedAction[] {
      const out: ListedAction[] = []
      for (const e of entries.values()) {
        if (!e.opts.action || !e.handler || !live(e, ignoreScope)) continue
        const run = e.handler
        out.push({ id: e.id, keys: e.keys, label: e.opts.label, group: e.opts.group ?? 'This page', global: !!e.opts.global, offHere: false, run: () => { run(null) } })
      }
      return out
    },

    subscribe(fn: () => void): () => void {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    version: () => version,
  }
}
