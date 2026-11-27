// Credit note arithmetic for a money note (owner, 24 Nov 2026). Pure, client-safe: the screen and the
// saved note use the same function. GST on the amount before GST at the given rates (half up, like
// bills), total rounded to the rupee.

import { ratesBp, type BillRates, type TaxType } from '@/lib/billing/bill-totals'

export interface NoteTotals {
  totalQty: number; grossPaise: number; discountBp: number; discountPaise: number; taxablePaise: number
  cgstBp: number; cgstPaise: number; sgstBp: number; sgstPaise: number; igstBp: number; igstPaise: number
  roundOffPaise: number; totalPaise: number
}

const half = (a: number, bp: number) => Math.floor((a * bp + 5000) / 10000)

export function moneyNoteTotals(taxablePaise: number, taxType: TaxType, rates: BillRates): NoteTotals {
  const r = ratesBp(rates)
  const cgstBp = taxType === 'intra_state' ? r.cgstBp : 0, sgstBp = taxType === 'intra_state' ? r.sgstBp : 0, igstBp = taxType === 'inter_state' ? r.igstBp : 0
  const cgstPaise = half(taxablePaise, cgstBp), sgstPaise = half(taxablePaise, sgstBp), igstPaise = half(taxablePaise, igstBp)
  const net = taxablePaise + cgstPaise + sgstPaise + igstPaise
  const totalPaise = Math.floor((net + 50) / 100) * 100
  return { totalQty: 0, grossPaise: 0, discountBp: 0, discountPaise: 0, taxablePaise, cgstBp, cgstPaise, sgstBp, sgstPaise, igstBp, igstPaise, roundOffPaise: totalPaise - net, totalPaise }
}
