// New Order: what is typed in the size grid becomes order lines (pure, no database).
//
// Owner, 27 Nov 2026: Create Order, Save Changes and Save draft first take whatever is entered in the
// size grid, as if "Add to Order" had been pressed, so pairs typed but not added are never lost.
// "Next Article" uses the same rule.

import type { OrderLine, SizeEntry } from './drafts'

export interface MatrixArticle {
  id: number
  artNumber: string
  colors: { id: number; articleId: number; colorName: string; colorHex: string | null }[]
  sizes: SizeEntry[]
}

/**
 * Every colour of the open article with at least one pair entered goes into the lines: the line
 * being edited is replaced, a colour already in the order is replaced (no merge), a new colour is
 * added at the end. Colours with no pairs are left out. `added` = how many colours were taken.
 */
export function mergeMatrix(
  lines: OrderLine[],
  art: MatrixArticle | null,
  colorQuantities: Record<number, Record<string, number>>,
  editingLineId: string | null,
  newId: () => string,
): { lines: OrderLine[]; added: number; lastQuantities: Record<string, number> | null } {
  if (!art) return { lines, added: 0, lastQuantities: null }
  let next = lines
  let added = 0
  let lastQuantities: Record<string, number> | null = null
  for (const [colorIdStr, qties] of Object.entries(colorQuantities)) {
    const colorId = Number(colorIdStr)
    const total = Object.values(qties).reduce((s, n) => s + (n > 0 ? n : 0), 0)
    if (total === 0) continue
    const colour = art.colors.find(c => c.id === colorId)
    if (!colour) continue
    const quantities = Object.fromEntries(Object.entries(qties).filter(([, n]) => n > 0))
    added++
    lastQuantities = quantities
    const editIdx = editingLineId ? next.findIndex(l => l.id === editingLineId && l.colorId === colorId) : -1
    const idx = editIdx !== -1 ? editIdx : next.findIndex(l => l.articleId === art.id && l.colorId === colorId)
    if (idx !== -1) {
      next = next.map((l, i) => (i === idx ? { ...l, quantities } : l))
    } else {
      next = [...next, {
        id: newId(),
        articleId: art.id,
        artNumber: art.artNumber,
        colorId,
        colorName: colour.colorName,
        colorHex: colour.colorHex,
        sizes: art.sizes.filter(s => s.articleId === colour.articleId),
        quantities,
      }]
    }
  }
  return { lines: next, added, lastQuantities }
}

/** Pairs typed in the grid for the open article (not yet in the lines). */
export function matrixPairs(art: MatrixArticle | null, colorQuantities: Record<number, Record<string, number>>): number {
  if (!art) return 0
  const ids = new Set(art.colors.map(c => c.id))
  let total = 0
  for (const [id, q] of Object.entries(colorQuantities)) {
    if (!ids.has(Number(id))) continue
    for (const n of Object.values(q)) if (n > 0) total += n
  }
  return total
}
