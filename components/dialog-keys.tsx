'use client'

// Drop-in keyboard for the app's hand-made dialogs (docs/architecture/keyboard.md):
//   <div className="fixed inset-0 …" onClick={close}>
//     <DialogKeys onClose={close} label="Edit retailer" />
//     <div className="…panel…">…</div>
//   </div>
// It finds the panel (the next element, or the overlay itself when that has role="dialog"), marks it
// role="dialog" aria-modal="true", and gives it the shared behaviour of lib/shortcuts/dialog.ts:
// focus on the first field (or [data-autofocus], e.g. Cancel on a destructive confirm), Tab stays
// inside, Esc does what a tap outside does and focus returns to the opener, mod+Enter presses the
// [data-primary] button (or submits the form), mod+S does the same unless it is destructive.
// When an error appears after saving, focus moves to the first wrong field.
// Renders a hidden <span>; nothing changes for touch use.

import { useLayoutEffect, useRef } from 'react'
import { SCOPE_ATTR, useShortcut } from '@/lib/shortcuts'
import { firstField, useDialogKeys } from '@/lib/shortcuts/dialog'

const ERROR = '[role="alert"], [aria-invalid="true"]'

/** The first wrong field after a failed save: aria-invalid, else an empty required field, else the message. */
export function focusFirstError(root: HTMLElement): boolean {
  const invalid = root.querySelector<HTMLElement>('[aria-invalid="true"]')
  const emptyRequired = [...root.querySelectorAll<HTMLInputElement>('input[required], select[required], textarea[required]')].find((f) => !f.value)
  const message = root.querySelector<HTMLElement>('[role="alert"]')
  // "Party name is required." on a form without required markers: the first empty field.
  const emptyField = message && /required|missing|enter |empty|choose|select/i.test(message.textContent ?? '')
    ? [...root.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled])')]
        .find((f) => !f.value && f.getClientRects().length > 0)
    : undefined
  const target = invalid ?? emptyRequired ?? emptyField ?? message
  if (!target) return false
  if (target === message && !target.hasAttribute('tabindex')) target.tabIndex = -1
  target.focus()
  return true
}

/** The panel after the marker, skipping a full-screen backdrop sibling (absolute inset-0). */
function nextPanel(m: HTMLElement): HTMLElement | null {
  for (let el = m.nextElementSibling as HTMLElement | null; el; el = el.nextElementSibling as HTMLElement | null) {
    if (!/(^|\s)inset-0(\s|$)/.test(el.className)) return el
  }
  return null
}

export function DialogKeys({ onClose, label, canClose = true }: { onClose: () => void; label?: string; canClose?: boolean }) {
  const marker = useRef<HTMLSpanElement>(null)
  const root = useRef<HTMLElement | null>(null)
  const savedAt = useRef(0)
  const { scope } = useDialogKeys(root, { onClose, canClose, onConfirm: () => press(false) })

  function press(save: boolean): boolean {
    const r = root.current
    if (!r) return false
    const btn = [...r.querySelectorAll<HTMLButtonElement>('[data-primary]')].find((b) => !b.disabled && b.getClientRects().length > 0)
    if (btn) {
      if (save && btn.hasAttribute('data-destructive')) return false
      savedAt.current = Date.now(); btn.click(); return true
    }
    const form = r.querySelector('form')
    if (form) { savedAt.current = Date.now(); form.requestSubmit(); return true }
    return false
  }
  useShortcut('mod+s', () => { if (!press(true)) return false }, { label: 'Save', group: 'Dialog', scope, hidden: true })

  useLayoutEffect(() => {
    const m = marker.current
    const parent = m?.parentElement
    if (!m || !parent) return
    const el = (parent.matches('[role="dialog"], [role="alertdialog"]') ? parent : null)
      ?? parent.querySelector<HTMLElement>(':scope > [role="dialog"], :scope > [role="alertdialog"]')
      ?? nextPanel(m)
      ?? parent
    root.current = el
    if (!el.getAttribute('role')) el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    if (label && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) el.setAttribute('aria-label', label)
    el.setAttribute(SCOPE_ATTR, scope)
    // A click on the primary button also counts as "saving" (errors then take the focus).
    const onClick = (e: MouseEvent) => { if ((e.target as HTMLElement).closest?.('[data-primary], [type="submit"]')) savedAt.current = Date.now() }
    const onSubmit = () => { savedAt.current = Date.now() }
    el.addEventListener('click', onClick)
    el.addEventListener('submit', onSubmit)
    // An error shown within 5 s of saving: focus the first wrong field.
    const mo = new MutationObserver(() => {
      if (Date.now() - savedAt.current > 5000) return
      if (!el.querySelector(ERROR)) return
      savedAt.current = 0
      if (!focusFirstError(el)) firstField(el)?.focus()
    })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => { el.removeEventListener('click', onClick); el.removeEventListener('submit', onSubmit); mo.disconnect() }
  }, [label, scope])

  return <span ref={marker} hidden />
}
