'use client'

// Arrow keys move between buttons, links and fields by where they are on screen; Enter presses /
// selects; Esc leaves the focused control (the next arrow carries on from it). Owner, 24 Nov 2026.
// docs/architecture/keyboard.md.
//
// Runs after the shortcut registry and after the page's own handlers: anything that already used
// the key (lists ↑↓, tab bars ←→, search lists, the size matrix, the colour chips, menus) keeps it.
// Controls whose arrows have a native job keep them too: text (← → move the caret until its end),
// text areas, number / date fields, dropdowns (↑↓ change the value; ← → leave), radio buttons.
// Inside an open dialog only the dialog's controls are reached. Barcode scanners never send arrows,
// so this also works on the scanner and billing screens. Touch screens never send these keys.

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { getShortcutRegistry, useShortcutHelp } from '@/lib/shortcuts'
import { DIRS, pickNext, type Box, type Dir } from '@/lib/shortcuts/spatial'

const TARGETS = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])', '[data-list-row]', '[role="button"]',
  '[contenteditable="true"]',
].join(',')
const NATIVE_ALL = '[contenteditable="true"], input[type="date"], input[type="time"], input[type="datetime-local"], input[type="month"], input[type="week"], input[type="range"], input[type="radio"], [role="radio"], [role="slider"], [role="menuitem"], [role="option"]'
const TEXT = 'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="tel"], input[type="url"], input[type="password"]'

const vis = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? el.getClientRects().length > 0

/** The open dialog on top, if any: arrows stay inside it. */
function scopeRoot(): ParentNode {
  const open = [...document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]')].filter(vis)
  return (open.pop() as HTMLElement | undefined) ?? document
}

/** True when the focused control should keep this arrow for itself. */
function keepsArrow(el: HTMLElement, dir: Dir): boolean {
  if (el.matches(NATIVE_ALL)) return true
  // Text area: ↑ leaves from the first line, ↓ from the last; ← → move the caret until its ends.
  if (el.matches('textarea')) {
    const t = el as HTMLTextAreaElement
    if (dir === 'up') return t.value.slice(0, t.selectionStart).includes('\n')
    if (dir === 'down') return t.value.slice(t.selectionEnd).includes('\n')
    return dir === 'left' ? t.selectionStart > 0 || t.selectionEnd > 0 : t.selectionEnd < t.value.length
  }
  // Number box: ↑ ↓ change the number; ← → leave when it is empty (no caret position to read).
  if (el.matches('input[type="number"]')) return dir === 'up' || dir === 'down' || (el as HTMLInputElement).value.length > 0
  if (el.matches('select')) return dir === 'up' || dir === 'down'
  // A search box with its list open moves in the list (only text boxes: a menu button's aria-expanded doesn't count).
  if (el.matches('[role="combobox"], input[aria-expanded="true"]') && (dir === 'up' || dir === 'down')) return true
  if (el.matches(TEXT)) {
    if (dir === 'up' || dir === 'down') return false
    const input = el as HTMLInputElement
    let start: number | null = null, end: number | null = null
    try { start = input.selectionStart; end = input.selectionEnd } catch { /* email etc.: no caret API */ }
    if (start === null || end === null) return input.value.length > 0
    if (start !== end) return true
    return dir === 'left' ? start > 0 : end < input.value.length
  }
  return false
}

function targets(root: ParentNode, except: Element | null): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TARGETS)].filter((el) => {
    if (el === except || el.closest('[inert], [aria-hidden="true"], .skip-link') || !vis(el)) return false
    // Containers that take focus (tab panels, dialogs, tab bars) are not buttons to land on; a tab bar
    // is one stop (its selected tab), ← → move along it.
    if (el.matches('[role="tabpanel"], [role="dialog"], [role="alertdialog"], [role="tablist"], [role="listbox"]')) return false
    if (el.matches('[role="tab"]') && el.getAttribute('aria-selected') === 'false') return false
    const r = el.getBoundingClientRect()
    return r.width >= 4 && r.height >= 4
  })
}

const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }

function focusEl(el: HTMLElement) {
  if (el.matches('[data-list-row]') && !el.hasAttribute('tabindex')) el.tabIndex = -1
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

export function ArrowNav() {
  const pathname = usePathname() ?? ''
  const off = pathname === '/shop' || pathname.startsWith('/shop/')
  useShortcutHelp([
    { display: '↑ ↓ ← →', label: 'Move to the next button, link or box in that direction' },
    { keys: 'enter', label: 'Press / select the focused button (ticks a checkbox, opens a dropdown)' },
    { keys: 'escape', label: 'Leave the focused button or box (arrows carry on from there)' },
  ], { group: 'Global', global: true, enabled: !off })

  useEffect(() => {
    if (off) return
    getShortcutRegistry() // its listener first: shortcuts and lists get the keys before this
    let last: HTMLElement | null = null
    const onFocusIn = (e: FocusEvent) => { if (e.target instanceof HTMLElement && e.target !== document.body) last = e.target }

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
      const active = document.activeElement as HTMLElement | null
      const focused = active && active !== document.body ? active : null

      if (e.key === 'Escape') {
        // A dialog, a menu or a search list closes itself first (they use the key). Otherwise: leave.
        if (!focused || scopeRoot() !== document) return
        last = focused
        focused.blur()
        e.preventDefault()
        return
      }

      if (e.key === 'Enter') {
        if (!focused || e.shiftKey) return
        if (focused.matches('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"]')) {
          e.preventDefault(); focused.click(); return
        }
        if (focused.matches('select')) {
          try { (focused as HTMLSelectElement).showPicker(); e.preventDefault() } catch { /* older browser: arrows still change it */ }
        }
        return
      }

      const dir = DIRS[e.key]
      if (!dir || e.shiftKey) return
      if (focused && keepsArrow(focused, dir)) return
      const root = scopeRoot()
      const list = targets(root, focused)
      if (!list.length) return
      // Where to move from: the focused control, else the one left with Esc, else the screen's corner.
      const origin = focused && (root === document || (root as Element).contains(focused)) ? focused
        : last && last.isConnected && vis(last) && (root === document || (root as Element).contains(last)) ? last : null
      let next: HTMLElement | undefined
      // → on a list row (or any focused container): into its first button; its buttons sit inside it.
      if (focused && dir === 'right') {
        const inner = list.filter((el) => focused.contains(el) && el !== focused)
          .sort((a, c) => a.getBoundingClientRect().left - c.getBoundingClientRect().left)
        if (inner.length) { e.preventDefault(); focusEl(inner[0]); return }
      }
      if (origin) {
        // ↑ ↓ stay in the area they start in (the menu, or the page); ← → move between them.
        const area = (el: Element) => el.closest('aside') ?? el.closest('#main') ?? null
        const here = dir === 'up' || dir === 'down' ? area(origin) : null
        const pool = here ? list.filter((el) => area(el) === here) : list
        const i = pickNext(box(origin), pool.map(box), dir)
        next = i >= 0 ? pool[i] : undefined
        // Nothing further that way: back to the control left with Esc, else let the page scroll as usual.
        if (!next && !focused && origin === last && last) next = last
        if (!next) return
      } else {
        // Nothing focused yet: start in the page content (not the menu), on screen.
        const main = root === document ? document.getElementById('main') : null
        const pool = (main ? list.filter((el) => main.contains(el)) : list).filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })
        const from = pool.length ? pool : list
        next = dir === 'down' || dir === 'right' ? from[0] : from[from.length - 1]
      }
      e.preventDefault()
      focusEl(next)
    }
    document.addEventListener('focusin', onFocusIn)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('focusin', onFocusIn); window.removeEventListener('keydown', onKey) }
  }, [off])
  return null
}
