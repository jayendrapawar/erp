// The amounts a printed bill / PDF / mail / screen shows (client-safe). A bill made since migration
// 0017 prints its FROZEN amounts (sale_bills); an older bill that has no sale_bills row yet (before
// the backfill) is worked out from its lines with the same arithmetic and no round-off, so it prints
// what it always printed.

import { computeBillTotals, type BillTotalsPaise, type TaxType, type TotalsLine } from './bill-totals'

export interface BillAmounts {
  taxType: TaxType
  /** Walk-in customer: name only, no "M/s.", no ledger. */
  walkIn: boolean
  totalQty: number
  grossPaise: number
  discountPct: number
  discountPaise: number
  taxablePaise: number
  cgstPct: number; cgstPaise: number
  sgstPct: number; sgstPaise: number
  igstPct: number; igstPaise: number
  roundOffPaise: number
  grandTotalPaise: number
  /** False = worked out for an old bill that has no frozen amounts yet. */
  frozen: boolean
}

/** A sale_bills row as the print queries return it (numeric / bigint columns arrive as strings). */
export interface SaleBillAmountRow {
  taxType: string
  retailerId: string | null
  totalQty: number | string
  grossPaise: number | string
  discountPct: number | string
  discountPaise: number | string
  taxablePaise: number | string
  cgstPct: number | string; cgstPaise: number | string
  sgstPct: number | string; sgstPaise: number | string
  igstPct: number | string; igstPaise: number | string
  roundOffPaise: number | string
  grandTotalPaise: number | string
}

const N = (v: number | string) => Number(v)

export function amountsFromRow(r: SaleBillAmountRow): BillAmounts {
  return {
    taxType: r.taxType as TaxType, walkIn: r.retailerId == null, totalQty: N(r.totalQty),
    grossPaise: N(r.grossPaise), discountPct: N(r.discountPct), discountPaise: N(r.discountPaise), taxablePaise: N(r.taxablePaise),
    cgstPct: N(r.cgstPct), cgstPaise: N(r.cgstPaise), sgstPct: N(r.sgstPct), sgstPaise: N(r.sgstPaise), igstPct: N(r.igstPct), igstPaise: N(r.igstPaise),
    roundOffPaise: N(r.roundOffPaise), grandTotalPaise: N(r.grandTotalPaise), frozen: true,
  }
}

/** Old bill (no sale_bills row): same arithmetic, no round-off. */
export function amountsFromLines(lines: TotalsLine[], lineDiscPct: number, taxType: TaxType): BillAmounts {
  const t = computeBillTotals(lines, lineDiscPct, taxType, { roundOff: false })
  return {
    taxType, walkIn: false, totalQty: t.totalQty, grossPaise: t.grossPaise,
    discountPct: t.discountBp / 100, discountPaise: t.discountPaise, taxablePaise: t.taxablePaise,
    cgstPct: t.cgstBp / 100, cgstPaise: t.cgstPaise, sgstPct: t.sgstBp / 100, sgstPaise: t.sgstPaise, igstPct: t.igstBp / 100, igstPaise: t.igstPaise,
    roundOffPaise: 0, grandTotalPaise: t.grandTotalPaise, frozen: false,
  }
}

/** Columns of sale_bills the print queries select (with alias "sb"). */
export const SALE_BILL_AMOUNT_COLUMNS = `sb."taxType", sb."retailerId", sb."totalQty", sb."grossPaise", sb."discountPct", sb."discountPaise", sb."taxablePaise",
  sb."cgstPct", sb."cgstPaise", sb."sgstPct", sb."sgstPaise", sb."igstPct", sb."igstPaise", sb."roundOffPaise", sb."grandTotalPaise"`

/** Paise → rupees for printing (exact: paise are integers). */
export const rupees = (paise: number) => paise / 100

export const TAX_TYPE_LABEL: Record<TaxType, string> = {
  intra_state: 'Within state (CGST + SGST)',
  inter_state: 'Outside state (IGST)',
  untaxed: 'Without GST',
}

/** Short names for the bill type buttons. */
export const TAX_TYPE_SHORT: Record<TaxType, string> = { intra_state: 'Within state', inter_state: 'Outside state', untaxed: 'Without GST' }

/** Totals just worked out on a screen (before saving) in the same shape as a saved bill. */
export function amountsFromTotals(t: BillTotalsPaise, taxType: TaxType, walkIn = false): BillAmounts {
  return {
    taxType, walkIn, totalQty: t.totalQty, grossPaise: t.grossPaise,
    discountPct: t.discountBp / 100, discountPaise: t.discountPaise, taxablePaise: t.taxablePaise,
    cgstPct: t.cgstBp / 100, cgstPaise: t.cgstPaise, sgstPct: t.sgstBp / 100, sgstPaise: t.sgstPaise, igstPct: t.igstBp / 100, igstPaise: t.igstPaise,
    roundOffPaise: t.roundOffPaise, grandTotalPaise: t.grandTotalPaise, frozen: false,
  }
}

/** ₹1,234.50 from paise. */
export function formatRs(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const pctText = (p: number) => `${Number(p.toFixed(2))}%`

export interface TotalRow { key: string; label: string; value: string; tone: 'plain' | 'minus' | 'muted' }

/**
 * The totals rows every screen shows, in print order: sub total, bill discount, GST (only the taxes
 * this bill has), round off. Net payable is `formatRs(a.grandTotalPaise)`.
 */
export function billTotalRows(a: BillAmounts, unit = 'boxes'): TotalRow[] {
  const rows: TotalRow[] = [{ key: 'gross', label: `Sub total (${a.totalQty} ${unit})`, value: formatRs(a.grossPaise), tone: 'plain' }]
  if (a.discountPaise > 0 || a.discountPct > 0) rows.push({ key: 'disc', label: `Discount (${pctText(a.discountPct)})`, value: `− ${formatRs(a.discountPaise)}`, tone: 'minus' })
  if (a.cgstPct > 0) rows.push({ key: 'cgst', label: `CGST (${pctText(a.cgstPct)})`, value: `+ ${formatRs(a.cgstPaise)}`, tone: 'muted' })
  if (a.sgstPct > 0) rows.push({ key: 'sgst', label: `SGST (${pctText(a.sgstPct)})`, value: `+ ${formatRs(a.sgstPaise)}`, tone: 'muted' })
  if (a.igstPct > 0) rows.push({ key: 'igst', label: `IGST (${pctText(a.igstPct)})`, value: `+ ${formatRs(a.igstPaise)}`, tone: 'muted' })
  if (a.taxType === 'untaxed') rows.push({ key: 'nogst', label: 'GST', value: 'none', tone: 'muted' })
  if (a.roundOffPaise !== 0) rows.push({ key: 'round', label: 'Round off', value: `${a.roundOffPaise > 0 ? '+' : '−'} ${formatRs(Math.abs(a.roundOffPaise))}`, tone: 'muted' })
  return rows
}
