'use client'

// Forms on the page (not in a dialog: <DialogKeys> does those): mod+S or mod+Enter saves the form the
// cursor is in — its [data-primary] button, else the <form> is submitted (the browser then puts the
// cursor on the first required field that is empty). A screen's own mod+Enter (New Order: create the
// order) wins. Nothing happens, and the browser keeps Ctrl+S, when the cursor is not in a form.

import { useShortcut } from '@/lib/shortcuts'
import { submitIn } from '@/lib/shortcuts/dialog'

function saveFocusedForm(): false | void {
  const at = document.activeElement as HTMLElement | null
  const scope = at?.closest<HTMLElement>('[data-form]') ?? at?.closest('form') ?? null
  if (!scope) return false
  const primary = scope.querySelector<HTMLButtonElement>('[data-primary]')
  if (primary?.hasAttribute('data-destructive')) return false
  if (scope instanceof HTMLFormElement && !primary) { scope.requestSubmit(); return }
  if (!submitIn(scope)) return false
}

export function FormKeys() {
  useShortcut('mod+s', saveFocusedForm, { label: 'Save the form you are in', group: 'Global', global: true })
  useShortcut('mod+enter', saveFocusedForm, { label: 'Save the form you are in', group: 'Global', global: true, priority: -10, hidden: true })
  return null
}
