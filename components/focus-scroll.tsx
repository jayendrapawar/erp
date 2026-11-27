'use client'

// The page scrolls with the keyboard cursor (owner, 24 Nov 2026): whenever focus moves, the focused
// control is kept fully in view with a little room around it — also clear of fixed bars at the
// bottom (New Order's pairs / Save draft / Create Order bar, the biller's Mail bar) and sticky
// headers at the top, which the browser alone ignores (it treats a control under a fixed bar as
// visible). The bars are found from what is on screen at that moment (elementsFromPoint), so every
// page works without a list. Computers only (pointer: fine); phones and touch are unchanged.

import { useEffect } from 'react'

const ROOM = 24 // px kept between the cursor and the edge / a bar

function pinned(el: Element | null): HTMLElement | null {
  for (let e = el as HTMLElement | null; e && e !== document.body; e = e.parentElement) {
    const pos = getComputedStyle(e).position
    if (pos === 'fixed' || pos === 'sticky') return e
  }
  return null
}

/** The visible band of the window not covered by fixed / sticky bars, at the column x. */
function safeBand(x: number, target: HTMLElement): { top: number; bottom: number } {
  let top = 0, bottom = innerHeight
  // A bar along the bottom: the topmost pinned element at the bottom edge (not the target's own dialog).
  for (const el of document.elementsFromPoint(x, innerHeight - 2)) {
    const bar = pinned(el)
    if (bar && !bar.contains(target)) { bottom = Math.min(bottom, bar.getBoundingClientRect().top); break }
    if (el === document.documentElement) break
  }
  for (const el of document.elementsFromPoint(x, 2)) {
    const bar = pinned(el)
    if (bar && !bar.contains(target)) { top = Math.max(top, bar.getBoundingClientRect().bottom); break }
    if (el === document.documentElement) break
  }
  return { top, bottom }
}

export function FocusScroll() {
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return
    let frame = 0
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null
      if (!el || el === document.body || !el.matches(':focus-visible')) return
      cancelAnimationFrame(frame)
      // After the control's own scrolling (scrollIntoView in lists, arrow keys…) has happened.
      frame = requestAnimationFrame(() => {
        if (document.activeElement !== el) return
        // A control inside a dialog or another scroll box: let that box scroll it into view first.
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        // The dialog's own fixed overlay is not a page bar; the window does not scroll under a dialog.
        if (el.closest('[aria-modal="true"], [role="dialog"], [role="alertdialog"]')) return
        const r = el.getBoundingClientRect()
        // The sidebar is pinned itself: its own list scrolls (done above).
        if (pinned(el)) return
        const band = safeBand(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), el)
        let dy = 0
        if (r.bottom > band.bottom - ROOM) dy = r.bottom - (band.bottom - ROOM)
        if (r.top - dy < band.top + ROOM) dy = r.top - (band.top + ROOM) // taller than the band: show its top
        if (Math.abs(dy) >= 1) window.scrollBy({ top: dy, behavior: 'auto' })
      })
    }
    document.addEventListener('focusin', onFocusIn)
    return () => { document.removeEventListener('focusin', onFocusIn); cancelAnimationFrame(frame) }
  }, [])
  return null
}
