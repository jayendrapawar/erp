// Key combinations for the shortcut registry (docs/architecture/keyboard.md). Pure: no DOM, no React.
//
// Written as "mod+k", "alt+1", "shift+enter", "?", "escape", or a two-key chord "g h" (press g,
// let go, then h). "mod" is Ctrl on Windows / Linux and Cmd on a Mac.

export interface Combo {
  /** Lower-case key: a letter, digit, symbol, or a named key ("enter", "arrowdown", "space"…). */
  key: string
  mod: boolean
  /** Ctrl on a Mac (where "mod" is Cmd). Always false on Windows, where Ctrl is "mod". */
  ctrl: boolean
  alt: boolean
  shift: boolean
}

/** One shortcut: a single combination, or a chord of two plain keys ("g h"). */
export type Sequence = [Combo] | [Combo, Combo]

/** The parts of a keyboard event the registry needs (a real KeyboardEvent fits). */
export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const ALIASES: Record<string, string> = {
  esc: 'escape', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
  del: 'delete', return: 'enter', spacebar: 'space', ' ': 'space', plus: '+',
}

/** Keys that type a character: "shift" is part of the character itself ("?" is Shift+/). */
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key)
}

export function parseCombo(text: string): Combo {
  const parts = text.trim().toLowerCase().split('+')
  // "mod++" / "+" : a trailing empty part means the plus key itself.
  let key = parts.pop() ?? ''
  if (key === '' && parts.length && parts[parts.length - 1] === '') { parts.pop(); key = '+' }
  key = ALIASES[key] ?? key
  const c: Combo = { key, mod: false, ctrl: false, alt: false, shift: false }
  for (const p of parts) {
    if (p === 'mod' || p === 'cmd' || p === 'meta') c.mod = true
    else if (p === 'ctrl' || p === 'control') c.ctrl = true
    else if (p === 'alt' || p === 'option' || p === 'opt') c.alt = true
    else if (p === 'shift') c.shift = true
    else throw new Error(`Unknown modifier "${p}" in shortcut "${text}"`)
  }
  if (!c.key) throw new Error(`Shortcut "${text}" has no key`)
  return c
}

/** "g h" → chord of g then h; anything else → one combination. */
export function parseSequence(text: string): Sequence {
  const t = text.trim()
  if (t === 'space') return [parseCombo('space')]
  const steps = t.split(/\s+/)
  if (steps.length === 1) return [parseCombo(steps[0])]
  if (steps.length === 2) {
    const a = parseCombo(steps[0]), b = parseCombo(steps[1])
    if (a.mod || a.ctrl || a.alt || b.mod || b.ctrl || b.alt) throw new Error(`Chord "${text}" must use plain keys`)
    return [a, b]
  }
  throw new Error(`Shortcut "${text}" has more than two steps`)
}

/**
 * The combination a key press stands for. Letters and digits come from the physical key when a
 * modifier is held or the layout types a non-Latin letter, so Ctrl+K still works with the Hindi
 * keyboard on and Alt+N works on a Mac (where Option+N types "˜").
 */
export function eventCombo(e: KeyLike, isMac: boolean): Combo {
  let key = e.key
  const physical = /^Key([A-Z])$/.exec(e.code ?? '') ?? /^Digit([0-9])$/.exec(e.code ?? '')
  const nonLatin = key.length === 1 && !/^[\x20-\x7e]$/.test(key)
  if (physical && (e.altKey || e.ctrlKey || e.metaKey || nonLatin)) key = physical[1]
  key = key.toLowerCase()
  key = ALIASES[key] ?? key
  return {
    key,
    mod: isMac ? e.metaKey : e.ctrlKey,
    ctrl: isMac ? e.ctrlKey : false,
    alt: e.altKey,
    shift: e.shiftKey,
  }
}

export function comboEquals(want: Combo, got: Combo): boolean {
  if (want.key !== got.key || want.mod !== got.mod || want.ctrl !== got.ctrl || want.alt !== got.alt) return false
  // "?" is Shift+/ on most keyboards: for typed symbols the shift key is not compared.
  return isSymbol(want.key) ? true : want.shift === got.shift
}

/** Ctrl/Cmd held: these work while typing and on scanner screens. */
export function isModCombo(c: Combo): boolean {
  return c.mod
}

export function isEscape(c: Combo): boolean {
  return c.key === 'escape' && !c.mod && !c.ctrl && !c.alt
}

/** Keys pressed with no modifier at all except shift (letters, digits, arrows, Enter, "?"…). */
export function isPlain(c: Combo): boolean {
  return !c.mod && !c.ctrl && !c.alt
}

/** Modifier keys pressed on their own never count as a shortcut (or cancel a chord). */
export function isModifierKey(key: string): boolean {
  return ['shift', 'control', 'alt', 'meta', 'os', 'altgraph', 'capslock', 'fn'].includes(key.toLowerCase())
}

// ── Browser keys staff rely on ───────────────────────────────────────────────
// Reload, new tab, close tab, address bar, find, new window, switch tab. Ctrl+P is allowed only on
// screens that print bills or pick lists (register with { allowPrint: true }).
const RESERVED = ['mod+r', 'mod+shift+r', 'mod+t', 'mod+shift+t', 'mod+w', 'mod+shift+w', 'mod+l', 'mod+f', 'mod+g',
  'mod+n', 'mod+shift+n', 'mod+tab', 'mod+shift+tab', 'mod+0', 'mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6',
  'mod+7', 'mod+8', 'mod+9', 'mod++', 'mod+-', 'mod+=', 'f5', 'alt+arrowleft', 'alt+arrowright', 'alt+d', 'alt+f', 'alt+home']
  .map(parseCombo)
const PRINT = parseCombo('mod+p')

/** Why this shortcut may not be registered, or null when it is fine. */
export function reservedReason(seq: Sequence, allowPrint: boolean): string | null {
  const c = seq[0]
  if (seq.length === 1 && RESERVED.some((r) => comboEquals(r, c) && r.shift === c.shift)) return 'browser key staff rely on'
  if (seq.length === 1 && comboEquals(PRINT, c) && !allowPrint) return 'Ctrl+P prints only on bill / pick-list screens'
  return null
}

// ── Showing a shortcut on screen ─────────────────────────────────────────────

const NAMES: Record<string, string> = {
  escape: 'Esc', enter: 'Enter', space: 'Space', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End', tab: 'Tab', pageup: 'PgUp', pagedown: 'PgDn',
}

function comboLabel(c: Combo, isMac: boolean): string {
  const out: string[] = []
  if (c.ctrl) out.push(isMac ? '⌃' : 'Ctrl')
  if (c.mod) out.push(isMac ? '⌘' : 'Ctrl')
  if (c.alt) out.push(isMac ? '⌥' : 'Alt')
  if (c.shift && !isSymbol(c.key)) out.push(isMac ? '⇧' : 'Shift')
  out.push(NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1)))
  return out.join(isMac ? '' : ' ')
}

/** "mod+k" → "Ctrl K" (Windows) / "⌘K" (Mac); "g h" → "g then h"; "?" → "?". */
export function formatShortcut(text: string, isMac: boolean): string {
  const seq = parseSequence(text)
  const label = (c: Combo) => (isPlain(c) && c.key.length === 1 && /[a-z]/.test(c.key) && !c.shift ? c.key : comboLabel(c, isMac))
  return seq.length === 2 ? `${label(seq[0])} then ${label(seq[1])}` : label(seq[0])
}
