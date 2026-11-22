// Salesman draft orders, kept on this phone only (owner, 22 Nov 2026): an order that is started but
// not sent yet. No database work at all — saved in the browser's localStorage, so it also works with
// no internet. Not shared between phones; clearing the browser's data removes drafts.
//
// The New Order screen saves its form here on every change, so leaving the screen (or the app)
// never loses a half-made order. Creating the order removes its draft.

/** A size of a colour. `key` is "CODE:size" when one colour spans several article codes (SS-101). */
export type SizeEntry = { id: number; sizeLabel: string; sortOrder: number; articleId?: number; artCode?: string; key?: string }

/** One line in an order being made: article + colour + per-size quantities. */
export interface OrderLine {
  id: string
  articleId: number
  artNumber: string
  colorId: number
  colorName: string
  colorHex: string | null
  sizes: SizeEntry[]
  quantities: Record<string, number>
}

export interface DraftVendor { id: string; name: string; code: string | null; phone: string | null; address: string | null }

export interface OrderDraft {
  id: string
  savedAt: number
  vendor: DraftVendor | null
  lines: OrderLine[]
  notes: string
}

/** Newest drafts kept; older ones drop off. */
export const MAX_DRAFTS = 30

export const draftStorageKey = (user: string) => `shayona:order-drafts:v1:${user || 'me'}`

export const draftPairs = (d: Pick<OrderDraft, 'lines'>) =>
  d.lines.reduce((s, l) => s + Object.values(l.quantities).reduce((a, n) => a + (n > 0 ? n : 0), 0), 0)

export const draftArticles = (d: Pick<OrderDraft, 'lines'>) => new Set(d.lines.map(l => l.artNumber)).size

/** Worth keeping: a vendor or at least one line. */
export const draftHasContent = (d: Pick<OrderDraft, 'vendor' | 'lines'>) => !!d.vendor || d.lines.length > 0

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function validLine(v: unknown): v is OrderLine {
  return isObj(v) && typeof v.id === 'string' && typeof v.artNumber === 'string' && typeof v.colorName === 'string'
    && typeof v.articleId === 'number' && typeof v.colorId === 'number'
    && Array.isArray(v.sizes) && isObj(v.quantities)
    && Object.values(v.quantities).every(n => typeof n === 'number' && Number.isFinite(n))
}

function validDraft(v: unknown): v is OrderDraft {
  return isObj(v) && typeof v.id === 'string' && typeof v.savedAt === 'number' && typeof v.notes === 'string'
    && (v.vendor === null || (isObj(v.vendor) && typeof v.vendor.name === 'string'))
    && Array.isArray(v.lines) && v.lines.every(validLine)
}

/** Stored text → drafts, newest first. Anything damaged or from another version is skipped. */
export function parseDrafts(raw: string | null): OrderDraft[] {
  if (!raw) return []
  try {
    const data: unknown = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.filter(validDraft).sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

/** Put a draft in the list (replacing the one with its id), newest first, at most `max`. */
export function upsertDraft(list: OrderDraft[], draft: OrderDraft, max = MAX_DRAFTS): OrderDraft[] {
  return [draft, ...list.filter(d => d.id !== draft.id)].sort((a, b) => b.savedAt - a.savedAt).slice(0, max)
}

// ── Browser storage (every call guarded: private windows and full storage must not break the screen)

export function readDrafts(key: string): OrderDraft[] {
  try { return parseDrafts(window.localStorage.getItem(key)) } catch { return [] }
}

function write(key: string, list: OrderDraft[]): boolean {
  try {
    if (list.length) window.localStorage.setItem(key, JSON.stringify(list))
    else window.localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/** Save one draft. Returns the new list, or null if the phone would not store it. */
export function saveDraft(key: string, draft: OrderDraft): OrderDraft[] | null {
  const next = upsertDraft(readDrafts(key), draft)
  return write(key, next) ? next : null
}

export function deleteDraft(key: string, id: string): OrderDraft[] {
  const next = readDrafts(key).filter(d => d.id !== id)
  write(key, next)
  return next
}
