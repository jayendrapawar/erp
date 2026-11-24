// Edit a billed bill by scanning (owner, 24 Nov 2026). Pure: the server applies it when saving and the
// Edit bill screen uses it to show the new lines and total while the biller scans.
//
// A box changes the bill line with the same MRP and the same article: the line's name exactly, else
// the name the order used for that code (articlesMatch: "SF0204G" on the box is "SFG-204" on the bill).
// A box with no line gets a new line under its own code, the way Direct bills name their lines.

import { normalizeArticleValue } from '@/lib/article-utils'
import { articlesMatch } from '@/lib/billing-verification'

export interface EditLine { artNumber: string; mrp: number; qty: number; hsn?: string | null }
export interface EditBox { dedupeKey: string; articleCode: string; mrp: number | null }

const sameMrp = (a: number, b: number) => Math.abs(a - b) < 0.005

function findLine(lines: EditLine[], box: EditBox, needQty: boolean): EditLine | undefined {
  const mrp = box.mrp ?? 0
  const ok = (l: EditLine) => sameMrp(l.mrp, mrp) && (!needQty || l.qty > 0)
  return lines.find((l) => ok(l) && normalizeArticleValue(l.artNumber) === box.articleCode)
    ?? lines.find((l) => ok(l) && articlesMatch(l.artNumber, box.articleCode))
}

/**
 * The bill lines after taking `removed` boxes off and putting `added` boxes on. Lines that reach 0 are
 * dropped. Throws when a removed box has no line left to come off (the bill would be wrong).
 */
export function applyBoxChanges(lines: EditLine[], added: EditBox[], removed: EditBox[]): EditLine[] {
  const out = lines.map((l) => ({ ...l }))
  for (const b of removed) {
    const l = findLine(out, b, true)
    if (!l) throw new Error(`No line on this bill for ${b.articleCode} at MRP ${b.mrp ?? 0} to take the box off.`)
    l.qty--
  }
  for (const b of added) {
    const l = findLine(out, b, false)
    if (l) l.qty++
    else out.push({ artNumber: b.articleCode, mrp: b.mrp ?? 0, qty: 1, hsn: null })
  }
  return out.filter((l) => l.qty > 0)
}

/**
 * Money already set against the old bill, set against the edited bill again: oldest first, up to the
 * new total; what does not fit stays as advance. Input in the order to use (oldest first).
 */
export function reattachAmounts(credits: { id: number; amountPaise: number }[], newTotalPaise: number): { id: number; amountPaise: number }[] {
  let left = Math.max(0, newTotalPaise)
  const out: { id: number; amountPaise: number }[] = []
  for (const c of credits) {
    if (left <= 0) break
    const take = Math.min(c.amountPaise, left)
    if (take > 0) { out.push({ id: c.id, amountPaise: take }); left -= take }
  }
  return out
}
