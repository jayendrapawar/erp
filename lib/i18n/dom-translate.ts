// Shows the page in Hindi by swapping English text on screen for its phrase-book entry.
// Runs only in the browser and only while Hindi is chosen; stop() puts the English back.
//
// Safe with React: only the text of existing text nodes (and a few attributes) is changed —
// no nodes are added, moved or wrapped. When React later writes new English into a node,
// the observer sees it and translates it again.
// Mark anything that must never be translated with data-no-translate.

import type { Translator } from './translator'

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT'])

interface Swap { en: string; hi: string }

export function startDomTranslation(tr: Translator): () => void {
  const texts = new Map<Text, Swap>()
  const attrs = new Map<Element, Map<string, Swap>>()

  const skipped = (el: Element | null): boolean => {
    for (let e = el; e; e = e.parentElement) {
      if (SKIP_TAGS.has(e.tagName) || e.hasAttribute('data-no-translate') || (e as HTMLElement).isContentEditable) return true
    }
    return false
  }

  function doText(node: Text) {
    const cur = node.nodeValue ?? ''
    const done = texts.get(node)
    if (done && cur === done.hi) return
    if (skipped(node.parentElement)) return
    const hi = tr.translate(cur)
    if (hi && hi !== cur) { texts.set(node, { en: cur, hi }); node.nodeValue = hi }
    else if (done) texts.delete(node)
  }

  function doAttrs(el: Element) {
    for (const a of ATTRS) {
      const cur = el.getAttribute(a)
      if (cur == null) continue
      const done = attrs.get(el)?.get(a)
      if (done && cur === done.hi) continue
      // A text box's typed content is never touched, but its hint (placeholder) is translated.
      if (el.hasAttribute('data-no-translate') || skipped(el.parentElement)) return
      const hi = tr.translate(cur)
      if (hi && hi !== cur) {
        if (!attrs.has(el)) attrs.set(el, new Map())
        attrs.get(el)!.set(a, { en: cur, hi })
        el.setAttribute(a, hi)
      }
    }
  }

  function walk(root: Node) {
    if (root.nodeType === Node.TEXT_NODE) { doText(root as Text); return }
    if (root.nodeType !== Node.ELEMENT_NODE) return
    const el = root as Element
    if (SKIP_TAGS.has(el.tagName)) return
    doAttrs(el)
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) doText(n as Text)
      else doAttrs(n as Element)
    }
  }

  function prune() {
    for (const n of texts.keys()) if (!n.isConnected) texts.delete(n)
    for (const e of attrs.keys()) if (!e.isConnected) attrs.delete(e)
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') doText(r.target as Text)
      else if (r.type === 'attributes') doAttrs(r.target as Element)
      else r.addedNodes.forEach(walk)
    }
    if (texts.size > 4000) prune()
  })

  // Pop-ups from window.confirm / alert / prompt.
  const original = { confirm: window.confirm, alert: window.alert, prompt: window.prompt }
  const say = (m?: unknown) => (typeof m === 'string' ? tr.translate(m) ?? m : m)
  window.confirm = (m?: string) => original.confirm.call(window, say(m) as string)
  window.alert = (m?: unknown) => original.alert.call(window, say(m))
  window.prompt = (m?: string, d?: string) => original.prompt.call(window, say(m) as string, d)

  walk(document.body)
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] })

  return () => {
    observer.disconnect()
    window.confirm = original.confirm
    window.alert = original.alert
    window.prompt = original.prompt
    for (const [n, s] of texts) if (n.isConnected && n.nodeValue === s.hi) n.nodeValue = s.en
    for (const [el, m] of attrs) for (const [a, s] of m) if (el.getAttribute(a) === s.hi) el.setAttribute(a, s.en)
    texts.clear()
    attrs.clear()
  }
}
