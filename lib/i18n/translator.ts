// Phrase-book translator: English UI text → Hindi. Pure (no DOM), so it is unit-tested.
//
// The phrase book (lib/i18n/hi.json) maps the English text exactly as it appears on screen to Hindi.
// Keys may contain {0}, {1}… for parts that change (numbers, names): "Show more ({0} left)".
// Text that is not in the book (names, article codes, numbers) is left as it is.

export type PhraseBook = Record<string, string>

export interface Translator {
  /** Hindi for this text, or null when the book has no entry. Keeps leading/trailing spaces. */
  translate: (text: string) => string | null
}

const PLACEHOLDER = /\{(\d+)\}/g
const HAS_LETTERS = /[A-Za-z]/

export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Template { re: RegExp; order: number[]; hi: string }

export function createTranslator(book: PhraseBook): Translator {
  const exact = new Map<string, string>()
  const templates: Template[] = []

  for (const [rawKey, hi] of Object.entries(book)) {
    const key = normalize(rawKey)
    if (!key || !hi) continue
    if (!/\{\d+\}/.test(key)) { exact.set(key, hi); continue }
    // Needs real words around the placeholders, or it would match almost anything.
    if (key.replace(PLACEHOLDER, '').replace(/[^A-Za-z]/g, '').length < 3) continue
    const order: number[] = []
    const pattern = key.split(PLACEHOLDER).map((part, i) => {
      if (i % 2 === 1) { order.push(Number(part)); return '(.*?)' }
      return escapeRegExp(part)
    }).join('')
    templates.push({ re: new RegExp(`^${pattern}$`), order, hi })
  }
  // Longest (most specific) templates first.
  templates.sort((a, b) => b.re.source.length - a.re.source.length)

  const cache = new Map<string, string | null>()

  function lookup(key: string, depth: number): string | null {
    const hit = exact.get(key)
    if (hit !== undefined) return hit
    // "pending" shown as-is from the database → "Pending" in the book.
    if (/^[a-z]/.test(key)) {
      const cap = exact.get(key[0].toUpperCase() + key.slice(1))
      if (cap !== undefined) return cap
    }
    // A list such as "Admin, Picker": translated when every item is in the book.
    if (key.includes(', ')) {
      const parts = key.split(', ').map((p) => lookup(p, depth + 1))
      if (parts.every((p) => p !== null)) return parts.join(', ')
    }
    if (depth > 0 || key.length > 300) return null
    for (const t of templates) {
      const m = t.re.exec(key)
      if (!m) continue
      const values: Record<number, string> = {}
      t.order.forEach((n, i) => {
        const v = m[i + 1]
        values[n] = HAS_LETTERS.test(v) ? lookup(v.trim(), depth + 1) ?? v : v
      })
      return t.hi.replace(PLACEHOLDER, (_, n: string) => values[Number(n)] ?? '')
    }
    return null
  }

  return {
    translate(text: string): string | null {
      if (!HAS_LETTERS.test(text)) return null
      const key = normalize(text)
      let hi = cache.get(key)
      if (hi === undefined) {
        hi = lookup(key, 0)
        if (cache.size > 5000) cache.clear()
        cache.set(key, hi)
      }
      if (hi === null) return null
      const lead = text.match(/^\s*/)![0]
      const trail = text.match(/\s*$/)![0]
      return lead + hi + trail
    },
  }
}
