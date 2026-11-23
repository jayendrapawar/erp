'use client'

// One keyboard model for every list and table (docs/architecture/keyboard.md):
//   ↑ ↓ / j k   move the highlighted row (real focus, so the focus ring shows it)
//   Home / End  first / last row drawn; ↓ on the last row goes to "Show more"
//   Enter       open the row (its [data-row-open] control, else the row itself is clicked)
//   Space / x   tick the row where rows can be ticked (its [data-row-tick] control or checkbox)
//   /           focus the list's search or filter box; ↓ from that box goes to the first row
//   n / Alt+N   "New …" where the screen has one
// A list marks its container (ref) and each row (data-list-row; both the phone cards and the
// computer table rows can carry it: only the ones on screen count). Nothing is re-rendered when
// the highlight moves. Phones and mouse use are unchanged.

import { useEffect, type RefObject } from 'react'
import { isShown, useShortcut } from './react'

const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="option"], [role="menuitem"], [role="slider"], [contenteditable="true"]'

const ARROW_OWNERS = 'input[type="radio"], input[type="range"], [role="tab"], [role="radio"], [role="slider"], [role="menuitem"], [role="option"]'

export interface ListKeysOptions {
  /** Cheat-sheet heading, e.g. "Orders list". */
  label: string
  /** "n" / Alt+N: start a new one. */
  onNew?: () => void
  /** "New order", "New retailer"… (cheat sheet and Ctrl K "> "). */
  newLabel?: string
  /** Rows can be ticked (print selection, mail bills): Space / x clicks the row's checkbox. */
  tickable?: boolean
  /** Off while false (e.g. a detail view replaces the list). */
  enabled?: boolean
}

function rowsOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-list-row]')].filter((r) => isShown(r))
}

function currentRow(root: HTMLElement): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null
  const row = a?.closest<HTMLElement>('[data-list-row]')
  return row && root.contains(row) ? row : null
}

function focusRow(row: HTMLElement | undefined) {
  if (!row) return
  if (!row.hasAttribute('tabindex')) row.tabIndex = -1
  row.focus({ preventScroll: true })
  row.scrollIntoView({ block: 'nearest' })
}

/** Another list on screen has the focus: leave the keys to it. */
function otherListHasFocus(root: HTMLElement): boolean {
  const owner = (document.activeElement as HTMLElement | null)?.closest('[data-list]')
  return !!owner && owner !== root
}

export function useListKeys(ref: RefObject<HTMLElement | null>, opts: ListKeysOptions) {
  const { label, enabled = true } = opts
  const group = label

  useEffect(() => {
    const root = ref.current
    if (!root || !enabled) return
    root.setAttribute('data-list', '')
    // ↓ in the list's search / filter box: to the first row.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== 'ArrowDown' || e.defaultPrevented || !t.matches('input[type="search"], input[data-list-search]')) return
      const first = rowsOf(root)[0]
      if (!first) return
      e.preventDefault()
      focusRow(first)
    }
    root.addEventListener('keydown', onKey)
    return () => { root.removeEventListener('keydown', onKey); root.removeAttribute('data-list') }
  }, [ref, enabled])

  const move = (step: number | 'first' | 'last'): false | void => {
    const root = ref.current
    if (!root || otherListHasFocus(root)) return false
    // Arrow keys of a focused radio group, tab bar, slider or menu stay theirs.
    if ((document.activeElement as HTMLElement | null)?.matches(ARROW_OWNERS) && !currentRow(root)) return false
    const rows = rowsOf(root)
    if (!rows.length) return false
    const at = rows.indexOf(currentRow(root) as HTMLElement)
    if (step === 'first') return focusRow(rows[0])
    if (step === 'last') return focusRow(rows[rows.length - 1])
    if (at < 0) return focusRow(step > 0 ? rows[0] : rows[rows.length - 1])
    const next = at + step
    if (next >= rows.length) {
      // Past the last row drawn: "Show more" (Enter presses it); none: the arrow moves on (components/arrow-nav.tsx).
      const more = [...root.querySelectorAll<HTMLElement>('[data-show-more]')].find((b) => isShown(b))
        ?? [...document.querySelectorAll<HTMLElement>('[data-show-more]')].find((b) => isShown(b) && root.parentElement?.contains(b))
      if (!more) return false
      more.focus(); more.scrollIntoView({ block: 'nearest' })
      return
    }
    // Above the first row: the arrow moves on to the filter / buttons above.
    if (next < 0) return false
    focusRow(rows[next])
  }
  /** ↑ ↓ belong to the list only while a row of it has the focus (elsewhere they move between buttons). */
  const arrow = (step: number) => (ref.current && currentRow(ref.current) ? move(step) : false)

  /** Keys that belong to a focused control inside the row (a button, a checkbox…) are left to it. */
  const onRowItself = () => {
    const root = ref.current
    const a = document.activeElement as HTMLElement | null
    if (!root || !a) return null
    const row = currentRow(root)
    return row && (a === row || !a.matches(INTERACTIVE)) ? row : null
  }

  const common = { group, within: ref, enabled }
  useShortcut('j', () => move(1), { ...common, label: 'Next row' })
  useShortcut('k', () => move(-1), { ...common, label: 'Previous row' })
  useShortcut('arrowdown', () => arrow(1), { ...common, label: 'Next row (on a row)' })
  useShortcut('arrowup', () => arrow(-1), { ...common, label: 'Previous row (on a row)' })
  useShortcut('home', () => move('first'), { ...common, label: 'First row' })
  useShortcut('end', () => move('last'), { ...common, label: 'Last row shown (then ↓ for Show more)' })
  useShortcut('enter', () => {
    const row = onRowItself()
    if (!row) return false
    const target = [...row.querySelectorAll<HTMLElement>('[data-row-open]')].find((x) => isShown(x)) ?? row
    target.click()
  }, { ...common, label: 'Open the row' })
  useShortcut(['space', 'x'], () => {
    const row = onRowItself()
    const box = row ? [...row.querySelectorAll<HTMLInputElement>('[data-row-tick], input[type="checkbox"]')].find((x) => isShown(x) && !x.disabled) : null
    if (!box) return false
    box.click()
  }, { ...common, label: 'Tick / untick the row', enabled: enabled && !!opts.tickable })
  useShortcut('/', () => {
    const root = ref.current
    if (!root) return false
    const box = [...root.querySelectorAll<HTMLInputElement>('input[type="search"], input[data-list-search]')].find((x) => isShown(x))
      ?? [...document.querySelectorAll<HTMLInputElement>('input[data-list-search]')].find((x) => isShown(x))
    if (!box) return false
    box.focus()
    box.select()
  }, { ...common, label: 'Search / filter the list' })
  useShortcut(['n', 'alt+n'], () => { if (!opts.onNew) return false; opts.onNew() }, {
    ...common, label: opts.newLabel ?? 'New', action: true, enabled: enabled && !!opts.onNew,
  })
}
