'use client'

// Tabs by keyboard (docs/architecture/keyboard.md):
//  - Alt+1…9 switch to tab 1…9 (Alt+Shift+1…9 for a tab bar inside another tabbed page, e.g. the
//    biller's own tabs inside the Orders hub);
//  - ←/→ (Home/End) on a focused tab bar: role="tablist" with roving focus. The shadcn <Tabs>
//    (base-ui) already does this; tablistKeyDown does it for hand-made tab bars.

import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { useShortcut } from './react'

export interface TabKeysOptions {
  /** A tab bar inside another tabbed page: Alt+Shift+digit. */
  nested?: boolean
  /** Only while this element is on screen (hubs keep hidden tabs mounted). */
  within?: RefObject<HTMLElement | null>
  enabled?: boolean
  /** Cheat-sheet heading. Default "Tabs". */
  group?: string
}

/** Alt+1…9 → tab 1…9. Always calls the hook 9 times (rules of hooks); missing tabs are off. */
export function useTabKeys(tabs: readonly { value: string; label: string }[], setTab: (value: string) => void, opts: TabKeysOptions = {}) {
  const prefix = opts.nested ? 'alt+shift+' : 'alt+'
  const group = opts.group ?? 'Tabs'
  for (let i = 0; i < 9; i++) {
    const tab = tabs[i]
    // eslint-disable-next-line react-hooks/rules-of-hooks -- fixed count of 9
    useShortcut(`${prefix}${i + 1}`, () => { if (tab) setTab(tab.value); else return false }, {
      label: tab ? tab.label : `Tab ${i + 1}`, group, within: opts.within, enabled: (opts.enabled ?? true) && !!tab,
    })
  }
}

/** onKeyDown for a role="tablist": ←/→, Home/End move to a tab and open it. ↑/↓, and ←/→ past the
 *  ends, are left to the page's arrow navigation (components/arrow-nav.tsx): they leave the tab bar. */
export function tablistKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')]
  if (!tabs.length) return
  const at = tabs.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : Math.max(0, at) + (e.key === 'ArrowLeft' ? -1 : 1)
  // Past the first / last tab the arrow leaves the tab bar (components/arrow-nav.tsx), no wrapping.
  if (next < 0 || next >= tabs.length) return
  e.preventDefault()
  tabs[next].focus()
  tabs[next].click()
}

/** Props for one tab of a hand-made tablist (roving focus: only the selected tab is in the Tab order). */
export function tabProps(selected: boolean, panelId?: string) {
  return { role: 'tab' as const, 'aria-selected': selected, tabIndex: selected ? 0 : -1, ...(panelId ? { 'aria-controls': panelId } : {}) }
}
