// Size ranges and size ordering for footwear SKUs.
//
// Source catalogues give a size RANGE per row (minSize–maxSize). A variant (article code +
// colour code) may have several ranges, e.g. kids 11–13, 1 and 2–5. Ranges are kept as given
// (article_size_ranges) and expanded into one SKU per size (article_sizes).
//
// Children's sizes run 11, 12, 13 and then restart at 1. A range whose minimum is larger than
// its maximum ("11–1", "11–5") is read that way. Any other descending range is invalid.

export const KIDS_SIZE_MAX = 13

export interface ExpandedRange {
  ok: true
  min: string
  max: string
  sizes: string[]
  /** true when the range crosses from 13 back to 1 (e.g. 11–1). */
  wraps: boolean
}

export interface InvalidRange {
  ok: false
  min: string
  max: string
  reason: string
}

function asSizeNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!/^\d{1,2}$/.test(t)) return null
  const n = Number(t)
  return n > 0 ? n : null
}

/** Normalise a size label: "06" → "6"; non-numeric labels are trimmed and upper-cased. */
export function normaliseSizeLabel(v: unknown): string {
  const n = asSizeNumber(v)
  if (n != null) return String(n)
  return String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
}

export function expandSizeRange(minRaw: unknown, maxRaw: unknown): ExpandedRange | InvalidRange {
  const min = asSizeNumber(minRaw)
  const max = asSizeNumber(maxRaw)
  const minS = String(minRaw ?? '').trim()
  const maxS = String(maxRaw ?? '').trim()
  if (min == null || max == null) {
    return { ok: false, min: minS, max: maxS, reason: `Size range "${minS}–${maxS}" is not two whole sizes.` }
  }
  if (min > KIDS_SIZE_MAX || max > KIDS_SIZE_MAX) {
    return { ok: false, min: String(min), max: String(max), reason: `Size ${Math.max(min, max)} is above ${KIDS_SIZE_MAX}.` }
  }
  if (min <= max) {
    const sizes: string[] = []
    for (let s = min; s <= max; s++) sizes.push(String(s))
    return { ok: true, min: String(min), max: String(max), sizes, wraps: false }
  }
  // Descending: only valid as a children's run that wraps from 13 to 1.
  if (min < 11) {
    return { ok: false, min: String(min), max: String(max), reason: `Size range ${min}–${max} runs backwards and does not start at 11–13.` }
  }
  const sizes: string[] = []
  for (let s = min; s <= KIDS_SIZE_MAX; s++) sizes.push(String(s))
  for (let s = 1; s <= max; s++) sizes.push(String(s))
  return { ok: true, min: String(min), max: String(max), sizes, wraps: true }
}

/**
 * Sort keys for the sizes of one variant.
 *
 * Adult and ladies charts (any size 6–10 present) sort numerically: 6 … 10, 11, 12.
 * Children's charts (no size 6–10) run 11, 12, 13, 1, 2 … 5, so 11–13 sort first.
 */
export function sizeSortOrders(labels: string[]): Map<string, number> {
  const nums = labels.map(l => asSizeNumber(l))
  const adultChart = nums.some(n => n != null && n >= 6 && n <= 10)
  const out = new Map<string, number>()
  const nonNumeric = labels.filter((_, i) => nums[i] == null).sort()
  labels.forEach((l, i) => {
    const n = nums[i]
    if (n == null) out.set(l, 100 + nonNumeric.indexOf(l))
    else out.set(l, !adultChart && n >= 11 ? n - 20 : n)
  })
  return out
}

export function sortSizes(labels: string[]): string[] {
  const order = sizeSortOrders(labels)
  return [...labels].sort((a, b) => (order.get(a)! - order.get(b)!) || a.localeCompare(b))
}
