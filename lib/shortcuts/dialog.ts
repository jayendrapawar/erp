'use client'

// Keyboard behaviour shared by every dialog (docs/architecture/keyboard.md):
//  - focus goes to the first field when it opens (or the element asked for, e.g. Cancel on a
//    destructive confirm) and stays inside: Tab / Shift+Tab wrap around;
//  - Esc closes it and focus returns to the button that opened it;
//  - mod+Enter saves / confirms (the dialog's form, or its button marked data-primary);
//  - while it is open only its own shortcuts work (a registry scope).
// Touch use is unchanged: nothing here runs on a tap.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useShortcut, useShortcutScope } from './react'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]', 'summary',
].join(',')
const FIELDS = 'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([readonly]), select:not([disabled]), textarea:not([disabled]):not([readonly])'

function visible(el: HTMLElement): boolean {
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0
}

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => visible(el) && !el.closest('[inert]'))
}

/** First field of a dialog / form: [autofocus], else the first text box or select, else the first control. */
export function firstField(root: HTMLElement): HTMLElement | null {
  const auto = root.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
  if (auto && visible(auto)) return auto
  const field = [...root.querySelectorAll<HTMLElement>(FIELDS)].find(visible)
  return field ?? focusables(root)[0] ?? null
}

/** Submit the form or press the primary button inside `root`. False when there is nothing to save. */
export function submitIn(root: ParentNode): boolean {
  const primary = [...root.querySelectorAll<HTMLButtonElement>('[data-primary]')].find((b) => visible(b) && !b.disabled)
  if (primary) { primary.click(); return true }
  const form = [...root.querySelectorAll<HTMLFormElement>('form')].find((f) => visible(f))
  if (form) { form.requestSubmit(); return true }
  return false
}

export interface DialogKeysOptions {
  onClose: () => void
  /** mod+Enter. Default: submit the dialog's form / press its data-primary button. */
  onConfirm?: () => void
  /** Element to focus first (Cancel for anything destructive). Default: the first field. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Default true. False while saving, so Esc does not close half-way. */
  canClose?: boolean
  /** Default true (mounted = open). */
  open?: boolean
}

/**
 * Keyboard for one dialog. Spread `dialogProps` on the dialog element (the box with role="dialog")
 * and wrap its content in <ShortcutScopeProvider id={scope}> if children register shortcuts.
 */
export function useDialogKeys(ref: RefObject<HTMLElement | null>, opts: DialogKeysOptions) {
  const open = opts.open ?? true
  const { id: scope, scopeProps } = useShortcutScope(open)
  const optsRef = useRef(opts)
  useLayoutEffect(() => { optsRef.current = opts })

  // Focus in on open, back to the opener on close; Tab wraps around.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    const root = ref.current
    if (!root) return
    const t = setTimeout(() => {
      if (root.contains(document.activeElement)) return // an autoFocus field already has it
      const target = optsRef.current.initialFocus?.current ?? firstField(root)
      if (target) target.focus({ preventScroll: false })
      else { if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1'); root.focus() }
    }, 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return
      const items = focusables(root)
      if (!items.length) { e.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      const at = document.activeElement as HTMLElement | null
      if (e.shiftKey && (at === first || !root.contains(at))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (at === last || !root.contains(at))) { e.preventDefault(); first.focus() }
    }
    // Focus left the dialog (a click on the page behind, a removed button): bring it back.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null
      if (!target || root.contains(target)) return
      // Another dialog opened on top (it has its own trap), or the toast region: leave it.
      if ((target as HTMLElement).closest?.('[role="dialog"], [role="alertdialog"]')) return
      firstField(root)?.focus()
    }
    root.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      clearTimeout(t)
      root.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocusIn)
      // Back to the button that opened it, if it is still there.
      if (opener && opener.isConnected && opener !== document.body) setTimeout(() => {
        const now = document.activeElement
        if (!now || now === document.body || !now.isConnected) opener.focus({ preventScroll: true })
      }, 0)
    }
  }, [open, ref])

  useShortcut('escape', () => {
    if (optsRef.current.canClose === false) return
    optsRef.current.onClose()
  }, { label: 'Close', group: 'Dialog', scope, enabled: open })
  useShortcut('mod+enter', () => {
    const o = optsRef.current
    if (o.onConfirm) { o.onConfirm(); return }
    const root = ref.current
    if (!root || !submitIn(root)) return false
  }, { label: 'Save / confirm', group: 'Dialog', scope, enabled: open })

  return { scope, dialogProps: scopeProps }
}
