// Arrow-key navigation between buttons, links and fields by where they are on screen
// (docs/architecture/keyboard.md). Pure geometry here; the browser side is components/arrow-nav.tsx.

export type Dir = 'up' | 'down' | 'left' | 'right'

export interface Box { left: number; top: number; right: number; bottom: number }

/** Distance from `from` to `to` when moving in `dir`; null when `to` is not in that direction. */
export function score(from: Box, to: Box, dir: Dir): number | null {
  const fcx = (from.left + from.right) / 2, fcy = (from.top + from.bottom) / 2
  const tcx = (to.left + to.right) / 2, tcy = (to.top + to.bottom) / 2
  let main: number, cross: number
  if (dir === 'down' || dir === 'up') {
    // Must lie beyond the current element (a little overlap allowed for uneven rows).
    if (dir === 'down' ? tcy <= fcy + 1 || to.bottom <= from.bottom : tcy >= fcy - 1 || to.top >= from.top) return null
    main = dir === 'down' ? Math.max(0, to.top - from.bottom) : Math.max(0, from.top - to.bottom)
    // Side distance: 0 when they overlap horizontally.
    cross = Math.max(0, Math.max(from.left, to.left) - Math.min(from.right, to.right))
    const offset = Math.abs(tcx - fcx)
    return main + cross * 2 + offset * 0.05
  }
  if (dir === 'right' ? tcx <= fcx + 1 || to.right <= from.right : tcx >= fcx - 1 || to.left >= from.left) return null
  main = dir === 'right' ? Math.max(0, to.left - from.right) : Math.max(0, from.left - to.right)
  cross = Math.max(0, Math.max(from.top, to.top) - Math.min(from.bottom, to.bottom))
  const offset = Math.abs(tcy - fcy)
  // Moving sideways: stay on the same line if anything is there (cross weighs heavily).
  return main + cross * 4 + offset * 0.05
}

const TOL = 4

/** Fully beyond `from` in `dir` (edges, a few pixels of overlap allowed). */
function beyond(from: Box, to: Box, dir: Dir): boolean {
  if (dir === 'down') return to.top >= from.bottom - TOL
  if (dir === 'up') return to.bottom <= from.top + TOL
  if (dir === 'right') return to.left >= from.right - TOL
  return to.right <= from.left + TOL
}

/** Same row (for ← →) or same column (for ↑ ↓). */
function inLine(from: Box, to: Box, dir: Dir): boolean {
  return dir === 'up' || dir === 'down'
    ? Math.min(from.right, to.right) - Math.max(from.left, to.left) > 0
    : Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top) > 0
}

/**
 * Index of the best target in `dir`, or -1. In order: controls fully beyond and in line (same
 * row / column), then fully beyond anywhere, then anything whose centre lies that way.
 */
export function pickNext(from: Box, targets: Box[], dir: Dir): number {
  const tiers: Array<(t: Box) => boolean> = [
    (t) => beyond(from, t, dir) && inLine(from, t, dir),
    (t) => beyond(from, t, dir),
    () => true,
  ]
  for (const ok of tiers) {
    let best = -1, bestScore = Infinity
    targets.forEach((t, i) => {
      if (!ok(t)) return
      const s = score(from, t, dir)
      if (s !== null && s < bestScore) { bestScore = s; best = i }
    })
    if (best >= 0) return best
  }
  return -1
}

export const DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
