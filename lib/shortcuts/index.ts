// Keyboard shortcuts for the whole app. Rules and the full list: docs/architecture/keyboard.md.
export { formatShortcut, parseSequence } from './keys'
export { CHORD_TIMEOUT_MS, createShortcutRegistry } from './registry'
export type { KeyEventLike, ListedAction, ListedShortcut, ShortcutHandler, ShortcutOptions, ShortcutRegistry } from './registry'
export {
  getShortcutRegistry, isMacPlatform, isScannerScreenNow, isShown, isTypingTarget, SCOPE_ATTR, ShortcutScopeProvider,
  usePendingChord, useRegistryVersion, useScanBox, useScanForwarder, useScannerScreen, useShortcut, useShortcutHelp,
  useShortcutScope,
} from './react'
export type { ShortcutHelp, UseShortcutOptions } from './react'
export { firstField, focusables, submitIn, useDialogKeys } from './dialog'
export type { DialogKeysOptions } from './dialog'
