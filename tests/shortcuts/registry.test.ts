import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHORD_TIMEOUT_MS, createShortcutRegistry, type KeyEventLike } from '../../lib/shortcuts/registry'
import { eventCombo, formatShortcut, parseSequence } from '../../lib/shortcuts/keys'

/** A registry with a fake platform, scanner state, dialog state and clock. */
function setup(over: { mac?: boolean } = {}) {
  const state = { scanner: false, foreignModal: false, errors: [] as string[] }
  const timers = new Map<number, { fn: () => void; at: number }>()
  let now = 0, nextTimer = 1
  const r = createShortcutRegistry({
    isMac: () => !!over.mac,
    isScannerScreen: () => state.scanner,
    foreignModalOpen: () => state.foreignModal,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id },
    clearTimer: (h) => { timers.delete(h as number) },
    onError: (m) => state.errors.push(m),
  })
  const advance = (ms: number) => {
    now += ms
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn() }
  }
  return { r, state, advance }
}

/** A key press. `typing` = the cursor is in a text box. */
function key(k: string, o: Partial<KeyEventLike> & { code?: string } = {}): KeyEventLike & { prevented: boolean } {
  const ev = {
    key: k, code: o.code, ctrlKey: !!o.ctrlKey, metaKey: !!o.metaKey, altKey: !!o.altKey, shiftKey: !!o.shiftKey,
    typing: !!o.typing, repeat: !!o.repeat, defaultPrevented: !!o.defaultPrevented, isComposing: false,
    prevented: false,
    preventDefault() { ev.prevented = true },
  }
  return ev
}

test('mod means Ctrl on Windows and Cmd on a Mac', () => {
  const win = setup()
  let n = 0
  win.r.register('mod+k', () => { n++ }, { label: 'Jump' })
  assert.equal(win.r.handleKey(key('k', { ctrlKey: true })), true)
  assert.equal(win.r.handleKey(key('k', { metaKey: true })), false)
  const mac = setup({ mac: true })
  mac.r.register('mod+k', () => { n++ }, { label: 'Jump' })
  assert.equal(mac.r.handleKey(key('k', { metaKey: true })), true)
  assert.equal(mac.r.handleKey(key('k', { ctrlKey: true })), false)
  assert.equal(n, 2)
})

test('plain keys and chords never fire while typing; Ctrl/Cmd combinations and Esc do', () => {
  const { r, advance } = setup()
  const hits: string[] = []
  r.register('?', () => { hits.push('?') }, { label: 'Help' })
  r.register('n', () => { hits.push('n') }, { label: 'New' })
  r.register('alt+1', () => { hits.push('alt1') }, { label: 'Tab 1' })
  r.register('g h', () => { hits.push('gh') }, { label: 'Home' })
  r.register('mod+enter', () => { hits.push('save') }, { label: 'Save' })
  r.register('escape', () => { hits.push('esc') }, { label: 'Close' })

  assert.equal(r.handleKey(key('?', { shiftKey: true, typing: true })), false)
  assert.equal(r.handleKey(key('n', { typing: true })), false)
  assert.equal(r.handleKey(key('1', { altKey: true, code: 'Digit1', typing: true })), false)
  assert.equal(r.handleKey(key('g', { typing: true })), false)
  assert.equal(r.pendingChord(), null)
  assert.equal(r.handleKey(key('h', { typing: true })), false)
  assert.deepEqual(hits, [])

  const save = key('Enter', { ctrlKey: true, typing: true })
  assert.equal(r.handleKey(save), true)
  assert.equal(save.prevented, true)
  assert.equal(r.handleKey(key('Escape', { typing: true })), true)
  assert.deepEqual(hits, ['save', 'esc'])

  // Not typing: all of them work.
  r.handleKey(key('?', { shiftKey: true }))
  r.handleKey(key('n'))
  r.handleKey(key('1', { altKey: true, code: 'Digit1' }))
  r.handleKey(key('g')); advance(200); r.handleKey(key('h'))
  assert.deepEqual(hits, ['save', 'esc', '?', 'n', 'alt1', 'gh'])
})

test('a key a focused control already handled is left alone', () => {
  const { r } = setup()
  let n = 0
  r.register('mod+enter', () => { n++ }, { label: 'Save' })
  assert.equal(r.handleKey(key('Enter', { ctrlKey: true, defaultPrevented: true })), false)
  assert.equal(n, 0)
})

test('while a dialog is open only its own shortcuts work', () => {
  const { r } = setup()
  const hits: string[] = []
  r.register('mod+k', () => { hits.push('page') }, { label: 'Jump', global: true })
  r.register('n', () => { hits.push('page-n') }, { label: 'New' })
  const close = r.pushScope('dlg')
  r.register('mod+enter', () => { hits.push('dialog-save') }, { label: 'Save', scope: 'dlg' })
  r.register('escape', () => { hits.push('dialog-esc') }, { label: 'Close', scope: 'dlg' })

  assert.equal(r.handleKey(key('k', { ctrlKey: true })), false)
  assert.equal(r.handleKey(key('n')), false)
  assert.equal(r.handleKey(key('Enter', { ctrlKey: true })), true)
  assert.equal(r.handleKey(key('Escape')), true)
  assert.deepEqual(r.list().map((s) => s.label).sort(), ['Close', 'Save'])

  // A second dialog on top: the first one's shortcuts are off too.
  const closeInner = r.pushScope('inner')
  assert.equal(r.handleKey(key('Escape')), false)
  closeInner()
  close()
  assert.equal(r.handleKey(key('k', { ctrlKey: true })), true)
  assert.deepEqual(hits, ['dialog-save', 'dialog-esc', 'page'])
})

test('a dialog that does not use scopes switches every page shortcut off', () => {
  const { r, state } = setup()
  let n = 0
  r.register('mod+k', () => { n++ }, { label: 'Jump' })
  state.foreignModal = true
  assert.equal(r.handleKey(key('k', { ctrlKey: true })), false)
  state.foreignModal = false
  assert.equal(r.handleKey(key('k', { ctrlKey: true })), true)
  assert.equal(n, 1)
})

test('on scanner and billing screens only Ctrl/Cmd combinations and Esc work', () => {
  const { r, state } = setup()
  const hits: string[] = []
  r.register('?', () => { hits.push('?') }, { label: 'Help' })
  r.register('j', () => { hits.push('j') }, { label: 'Down' })
  r.register('arrowdown', () => { hits.push('down') }, { label: 'Down' })
  r.register('alt+1', () => { hits.push('alt1') }, { label: 'Tab 1' })
  r.register('g b', () => { hits.push('gb') }, { label: 'Billing' })
  r.register('mod+k', () => { hits.push('jump') }, { label: 'Jump' })
  r.register('escape', () => { hits.push('esc') }, { label: 'Close' })
  state.scanner = true

  // A scanner types a code and Enter, very fast: nothing may be taken.
  for (const ch of 'g?jbA1-2') {
    const ev = key(ch)
    assert.equal(r.handleKey(ev), false, `scanner key "${ch}" must not be used`)
    assert.equal(ev.prevented, false)
  }
  assert.equal(r.handleKey(key('Enter')), false)
  assert.equal(r.handleKey(key('ArrowDown')), false)
  assert.equal(r.handleKey(key('1', { altKey: true, code: 'Digit1' })), false)
  assert.equal(r.pendingChord(), null)

  assert.equal(r.handleKey(key('k', { ctrlKey: true })), true)
  assert.equal(r.handleKey(key('Escape')), true)
  assert.deepEqual(hits, ['jump', 'esc'])

  const listed = r.list()
  assert.equal(listed.find((s) => s.label === 'Help')?.offHere, true)
  assert.equal(listed.find((s) => s.label === 'Jump')?.offHere, false)
})

test('chord: g then a letter within 1.5 s; Esc or a timeout cancels', () => {
  const { r, advance } = setup()
  const hits: string[] = []
  r.register('g o', () => { hits.push('orders') }, { label: 'Orders' })
  r.register('j', () => { hits.push('j') }, { label: 'Down' })

  const g = key('g')
  assert.equal(r.handleKey(g), true)
  assert.equal(g.prevented, true)
  assert.equal(r.pendingChord(), 'g')
  advance(CHORD_TIMEOUT_MS - 1)
  assert.equal(r.handleKey(key('o')), true)
  assert.deepEqual(hits, ['orders'])

  // Timed out: the second key is a normal key again.
  r.handleKey(key('g'))
  advance(CHORD_TIMEOUT_MS)
  assert.equal(r.pendingChord(), null)
  assert.equal(r.handleKey(key('o')), false)

  // Esc cancels and is used up.
  r.handleKey(key('g'))
  assert.equal(r.handleKey(key('Escape')), true)
  assert.equal(r.pendingChord(), null)
  assert.equal(r.handleKey(key('o')), false)

  // An unknown second key cancels and goes on as itself.
  r.handleKey(key('g'))
  assert.equal(r.handleKey(key('j')), true)
  assert.deepEqual(hits, ['orders', 'j'])

  // Shift / Ctrl pressed alone do not cancel a waiting chord.
  r.handleKey(key('g'))
  assert.equal(r.handleKey(key('Shift', { shiftKey: true })), false)
  assert.equal(r.pendingChord(), 'g')
  r.cancelChord()
})

test('a chord does not start while typing or with no chord registered', () => {
  const { r } = setup()
  assert.equal(r.handleKey(key('g')), false)
  r.register('g h', () => {}, { label: 'Home' })
  assert.equal(r.handleKey(key('g', { typing: true })), false)
  assert.equal(r.pendingChord(), null)
})

test('browser keys staff rely on cannot be taken; Ctrl+P only on print screens', () => {
  const { r, state } = setup()
  for (const k of ['mod+r', 'mod+t', 'mod+w', 'mod+l', 'mod+f']) {
    r.register(k, () => {}, { label: k })
  }
  r.register('mod+p', () => {}, { label: 'print' })
  assert.equal(state.errors.length, 6)
  assert.equal(r.handleKey(key('r', { ctrlKey: true })), false)
  let printed = 0
  r.register('mod+p', () => { printed++ }, { label: 'Print bill', allowPrint: true })
  assert.equal(r.handleKey(key('p', { ctrlKey: true })), true)
  assert.equal(printed, 1)
})

test('when / isShown / handler returning false', () => {
  const { r } = setup()
  let open = false, shown = true
  const hits: string[] = []
  r.register('escape', () => { hits.push('close') }, { label: 'Close', when: () => open })
  r.register('n', () => { hits.push('n') }, { label: 'New', isShown: () => shown })
  r.register('mod+s', () => false, { label: 'Save (nothing to save)' })
  assert.equal(r.handleKey(key('Escape')), false)
  open = true
  assert.equal(r.handleKey(key('Escape')), true)
  shown = false
  assert.equal(r.handleKey(key('n')), false)
  const s = key('s', { ctrlKey: true })
  assert.equal(r.handleKey(s), false)
  assert.equal(s.prevented, false)
  assert.deepEqual(hits, ['close'])
})

test('two shortcuts on the same key: higher priority, then the latest, wins', () => {
  const { r } = setup()
  const hits: string[] = []
  r.register('alt+1', () => { hits.push('a') }, { label: 'a' })
  const offB = r.register('alt+1', () => { hits.push('b') }, { label: 'b' })
  r.handleKey(key('1', { altKey: true, code: 'Digit1' }))
  r.register('alt+1', () => { hits.push('c') }, { label: 'c', priority: -1 })
  r.handleKey(key('1', { altKey: true, code: 'Digit1' }))
  offB()
  r.handleKey(key('1', { altKey: true, code: 'Digit1' }))
  assert.deepEqual(hits, ['b', 'b', 'a'])
})

test('help-only entries are listed but never fire; global ones are listed first', () => {
  const { r } = setup()
  r.register('enter', null, { label: 'Next step', group: 'New order' })
  r.register('mod+k', () => {}, { label: 'Jump to…', group: 'Global', global: true })
  assert.equal(r.handleKey(key('Enter')), false)
  assert.deepEqual(r.list().map((s) => s.label), ['Jump to…', 'Next step'])
})

test('actions for Ctrl+K: only those marked, on this screen, under the dialog that asks', () => {
  const { r } = setup()
  const hits: string[] = []
  r.register('n', () => { hits.push('new') }, { label: 'New order', action: true })
  r.register('j', () => {}, { label: 'Down' })
  const close = r.pushScope('palette')
  const acts = r.actions('palette')
  assert.deepEqual(acts.map((a) => a.label), ['New order'])
  acts[0].run()
  assert.deepEqual(hits, ['new'])
  close()
})

test('key matching: Shift for symbols, physical keys with modifiers and non-Latin layouts', () => {
  // "?" is Shift+/ ; matching ignores shift for symbols.
  assert.equal(eventCombo({ key: '?', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true }, false).key, '?')
  // Hindi (InScript) layout: Ctrl + the K key types a Devanagari letter.
  assert.equal(eventCombo({ key: 'क', code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, false).key, 'k')
  // Mac Option+N types "˜".
  assert.equal(eventCombo({ key: '˜', code: 'KeyN', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }, true).key, 'n')
  const { r } = setup()
  let n = 0
  r.register('shift+enter', () => { n++ }, { label: 'Add and stay' })
  assert.equal(r.handleKey(key('Enter')), false)
  assert.equal(r.handleKey(key('Enter', { shiftKey: true })), true)
  assert.equal(n, 1)
})

test('labels: Ctrl on Windows, symbols on a Mac, chords read "then"', () => {
  assert.equal(formatShortcut('mod+k', false), 'Ctrl K')
  assert.equal(formatShortcut('mod+k', true), '⌘K')
  assert.equal(formatShortcut('g h', false), 'g then h')
  assert.equal(formatShortcut('alt+shift+1', false), 'Alt Shift 1')
  assert.equal(formatShortcut('?', false), '?')
  assert.equal(formatShortcut('arrowdown', false), '↓')
  assert.throws(() => parseSequence('g mod+h'))
})
