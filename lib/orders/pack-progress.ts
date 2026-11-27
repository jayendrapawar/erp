// Picker packing progress, kept on this phone only (owner, 22 Nov 2026). The packing screen keeps the
// quantities a picker has confirmed in memory until "Pack Order"; leaving the order (back button, a
// call) used to lose them. Now they are saved in localStorage per picker and order, and come back
// when the order is opened again. No database work; "Pack Order" still saves everything in one call.
//
// Consistency: progress is tied to the order's last-change time. If the order changed since (the
// salesman edited it, it was released and claimed again), the saved progress is dropped, never
// applied to different items.

export interface PackProgress {
  /** order.updatedAt when the progress was saved (ISO). */
  orderUpdatedAt: string
  /** item id → confirmed packed quantity */
  touched: Record<string, number>
  packedPairs: number
  /** ordered pairs of the sizes already done (packed or out of stock): what is no longer to pack */
  doneOrderedPairs: number
  doneItems: number
  totalItems: number
  savedAt: number
}

type Store = Record<string, PackProgress>

export const MAX_ORDERS = 50

export const packStorageKey = (pickerId: string) => `shayona:pack-progress:v1:${pickerId || 'me'}`

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function valid(v: unknown): v is PackProgress {
  return isObj(v) && typeof v.orderUpdatedAt === 'string' && typeof v.savedAt === 'number' && isObj(v.touched)
    && Object.values(v.touched).every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    && typeof v.packedPairs === 'number' && typeof v.doneOrderedPairs === 'number' && typeof v.doneItems === 'number' && typeof v.totalItems === 'number'
}

export function parseStore(raw: string | null): Store {
  if (!raw) return {}
  try {
    const data: unknown = JSON.parse(raw)
    if (!isObj(data)) return {}
    const out: Store = {}
    for (const [id, p] of Object.entries(data)) if (valid(p)) out[id] = p
    return out
  } catch {
    return {}
  }
}

const iso = (d: Date | string) => new Date(d).toISOString()

/**
 * The saved quantities that still fit this order: same last-change time, items that still exist and
 * are not already packed / out of stock in the database. Empty when nothing applies.
 */
export function restorableTouched(
  saved: PackProgress | undefined,
  order: { updatedAt: Date | string },
  items: { id: number; status: string }[],
): Record<number, number> {
  if (!saved || saved.orderUpdatedAt !== iso(order.updatedAt)) return {}
  const out: Record<number, number> = {}
  for (const item of items) {
    if (item.status === 'packed' || item.status === 'out_of_stock') continue
    const q = saved.touched[String(item.id)]
    if (q !== undefined) out[item.id] = q
  }
  return out
}

export function buildProgress(
  order: { updatedAt: Date | string },
  items: { id: number; status: string; quantityOrdered: number }[],
  touched: Record<number, number>,
): PackProgress {
  const done = items.filter(i => i.status === 'out_of_stock' || i.id in touched)
  const t: Record<string, number> = {}
  for (const [id, q] of Object.entries(touched)) t[id] = q
  return {
    orderUpdatedAt: iso(order.updatedAt),
    touched: t,
    packedPairs: Object.values(touched).reduce((s, n) => s + n, 0),
    doneOrderedPairs: done.reduce((s, i) => s + i.quantityOrdered, 0),
    doneItems: done.length,
    totalItems: items.length,
    savedAt: Date.now(),
  }
}

/** Keep only the newest `max` orders. */
export function trimStore(store: Store, max = MAX_ORDERS): Store {
  const entries = Object.entries(store).sort(([, a], [, b]) => b.savedAt - a.savedAt).slice(0, max)
  return Object.fromEntries(entries)
}

// ── Browser storage, every call guarded

export function readPackStore(key: string): Store {
  try { return parseStore(window.localStorage.getItem(key)) } catch { return {} }
}

function write(key: string, store: Store) {
  try {
    if (Object.keys(store).length) window.localStorage.setItem(key, JSON.stringify(store))
    else window.localStorage.removeItem(key)
  } catch { /* storage full or blocked: progress just is not kept */ }
}

export function savePackProgress(key: string, orderId: number, p: PackProgress): Store {
  const next = trimStore({ ...readPackStore(key), [orderId]: p })
  write(key, next)
  return next
}

export function clearPackProgress(key: string, orderId: number): Store {
  const store = readPackStore(key)
  if (!(orderId in store)) return store
  const next = { ...store }
  delete next[orderId]
  write(key, next)
  return next
}
