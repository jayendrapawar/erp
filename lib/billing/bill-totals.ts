/**
 * Sale bill totals in integer paise (owner, 23 Nov 2026). One function for billing, the frozen
 * amounts in sale_bills, the printed bill, the PDF and the screen, so they can never disagree.
 *
 * Same arithmetic as the bill has always printed (lib/bill-html.ts billTotals), without floating
 * point:
 *   rate per pair   = MRP − line discount %, rounded UP to the whole rupee
 *   gross           = Σ rate × qty                                   (printed "Sub total")
 *   discount        = gross × bill discount %, rounded to the paisa (half up)
 *                       within / outside the state: 4.75 %
 *                       untaxed small party:        none (owner, 23 Nov 2026)
 *                       walk-in customer:           typed on the bill (default 0)
 *   taxable         = gross − discount
 *   intra-state     CGST 2.5 % + SGST 2.5 %, each rounded to the paisa
 *   inter-state     IGST 5 %, rounded to the paisa
 *   untaxed         no GST
 *   round-off       to the nearest rupee (50 paise goes up); old bills keep 0
 *
 * Percentages are handled in basis points (1 % = 100 bp), so 4.75 % = 475 bp is exact.
 */

export type TaxType = 'intra_state' | 'inter_state' | 'untaxed'

export const BILL_RATES_BP = { discount: 475, cgst: 250, sgst: 250, igst: 500 } as const

/** The bill discount a bill of this type gets unless one is typed (walk-in). */
export function defaultDiscountBp(taxType: TaxType): number {
  return taxType === 'untaxed' ? 0 : BILL_RATES_BP.discount
}

export interface TotalsLine { mrp: number | string; qty: number }

export interface BillTotalsPaise {
  totalQty: number
  grossPaise: number
  discountBp: number
  discountPaise: number
  taxablePaise: number
  cgstBp: number; cgstPaise: number
  sgstBp: number; sgstPaise: number
  igstBp: number; igstPaise: number
  /** Before round-off. */
  netPaise: number
  roundOffPaise: number
  grandTotalPaise: number
}

/** Rupees (number or numeric string like "499.00") → integer paise, exactly. */
export function toPaise(v: number | string): number {
  const s = typeof v === 'number' ? v.toFixed(2) : String(v).trim()
  const m = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s)
  if (!m) throw new Error(`Not an amount: ${v}`)
  const p = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  return m[1] ? -p : p
}

/** Percent (number or "30.00") → basis points, exactly. */
export function toBp(v: number | string): number {
  return toPaise(v) // same shape: two decimals → ×100
}

/** Basis points → the percent text the database stores (numeric(5,2)), e.g. 475 → "4.75". */
export function bpToPct(bp: number): string {
  return (bp / 100).toFixed(2)
}

/** a × bp / 10000, rounded half up (a ≥ 0). */
function pct(a: number, bp: number): number {
  return Math.floor((a * bp + 5000) / 10000)
}

/** Rate per pair in paise: MRP less the line discount, rounded up to the whole rupee. */
export function ratePaise(mrp: number | string, lineDiscPct: number | string): number {
  const m = toPaise(mrp), keep = 10000 - toBp(lineDiscPct)
  if (m <= 0 || keep <= 0) return 0
  return Math.ceil((m * keep) / 1_000_000) * 100 // ceil(paise × keep / 10000 / 100 paise) rupees
}

export function computeBillTotals(
  lines: TotalsLine[],
  lineDiscPct: number | string,
  taxType: TaxType,
  opts: { roundOff?: boolean; discountBp?: number } = {},
): BillTotalsPaise {
  const R = BILL_RATES_BP
  const discountBp = opts.discountBp ?? defaultDiscountBp(taxType)
  if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10000) throw new Error('Bill discount must be between 0 and 100 %.')
  const totalQty = lines.reduce((s, l) => s + l.qty, 0)
  const grossPaise = lines.reduce((s, l) => s + ratePaise(l.mrp, lineDiscPct) * l.qty, 0)
  const discountPaise = pct(grossPaise, discountBp)
  const taxablePaise = grossPaise - discountPaise
  const cgstBp = taxType === 'intra_state' ? R.cgst : 0
  const sgstBp = taxType === 'intra_state' ? R.sgst : 0
  const igstBp = taxType === 'inter_state' ? R.igst : 0
  const cgstPaise = pct(taxablePaise, cgstBp), sgstPaise = pct(taxablePaise, sgstBp), igstPaise = pct(taxablePaise, igstBp)
  const netPaise = taxablePaise + cgstPaise + sgstPaise + igstPaise
  const grandTotalPaise = opts.roundOff === false ? netPaise : Math.floor((netPaise + 50) / 100) * 100
  return {
    totalQty, grossPaise, discountBp, discountPaise, taxablePaise,
    cgstBp, cgstPaise, sgstBp, sgstPaise, igstBp, igstPaise,
    netPaise, roundOffPaise: grandTotalPaise - netPaise, grandTotalPaise,
  }
}
