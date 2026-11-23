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
 *
 * The bill discount and GST rates are editable (owner, 24 Nov 2026): the defaults live in Master →
 * Bill template (start: 4.75 %, CGST 2.5 %, SGST 2.5 %, IGST 5 %) and a bill may change them; each
 * bill saves the rates it was made with.
 */

export type TaxType = 'intra_state' | 'inter_state' | 'untaxed'

export const BILL_RATES_BP = { discount: 475, cgst: 250, sgst: 250, igst: 500 } as const

/** Bill discount and GST rates, in percent. */
export interface BillRates { discountPct: number; cgstPct: number; sgstPct: number; igstPct: number }

export const DEFAULT_BILL_RATES: BillRates = {
  discountPct: BILL_RATES_BP.discount / 100, cgstPct: BILL_RATES_BP.cgst / 100, sgstPct: BILL_RATES_BP.sgst / 100, igstPct: BILL_RATES_BP.igst / 100,
}

/**
 * The rates a bill of this type gets: what was typed on the bill, else the default (Master → Bill
 * template). A bill without GST gets no bill discount unless one is typed.
 */
export function billRatesFor(taxType: TaxType, defaults: BillRates = DEFAULT_BILL_RATES, edits: Partial<BillRates> = {}): BillRates {
  return {
    discountPct: edits.discountPct ?? (taxType === 'untaxed' ? 0 : defaults.discountPct),
    cgstPct: edits.cgstPct ?? defaults.cgstPct,
    sgstPct: edits.sgstPct ?? defaults.sgstPct,
    igstPct: edits.igstPct ?? defaults.igstPct,
  }
}

/** Refuses rates that are not 0–100 % with at most two decimals. */
export function cleanBillRates(raw: unknown): BillRates {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const one = (k: keyof BillRates, label: string) => {
    const v = Number(r[k])
    if (r[k] === '' || r[k] == null || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`${label} must be between 0 and 100 %.`)
    if (Math.round(v * 100) !== Number((v * 100).toFixed(6))) throw new Error(`${label} may have at most two decimals.`)
    return Math.round(v * 100) / 100
  }
  return { discountPct: one('discountPct', 'Bill discount'), cgstPct: one('cgstPct', 'CGST'), sgstPct: one('sgstPct', 'SGST'), igstPct: one('igstPct', 'IGST') }
}

/** Rates → the basis-point options of computeBillTotals. */
export function ratesBp(r: BillRates): { discountBp: number; cgstBp: number; sgstBp: number; igstBp: number } {
  return { discountBp: toBp(r.discountPct), cgstBp: toBp(r.cgstPct), sgstBp: toBp(r.sgstPct), igstBp: toBp(r.igstPct) }
}

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
  opts: { roundOff?: boolean; discountBp?: number; cgstBp?: number; sgstBp?: number; igstBp?: number } = {},
): BillTotalsPaise {
  const R = BILL_RATES_BP
  const discountBp = opts.discountBp ?? defaultDiscountBp(taxType)
  const okBp = (v: number) => Number.isInteger(v) && v >= 0 && v <= 10000
  if (!okBp(discountBp)) throw new Error('Bill discount must be between 0 and 100 %.')
  for (const v of [opts.cgstBp, opts.sgstBp, opts.igstBp]) if (v !== undefined && !okBp(v)) throw new Error('GST must be between 0 and 100 %.')
  const totalQty = lines.reduce((s, l) => s + l.qty, 0)
  const grossPaise = lines.reduce((s, l) => s + ratePaise(l.mrp, lineDiscPct) * l.qty, 0)
  const discountPaise = pct(grossPaise, discountBp)
  const taxablePaise = grossPaise - discountPaise
  const cgstBp = taxType === 'intra_state' ? opts.cgstBp ?? R.cgst : 0
  const sgstBp = taxType === 'intra_state' ? opts.sgstBp ?? R.sgst : 0
  const igstBp = taxType === 'inter_state' ? opts.igstBp ?? R.igst : 0
  const cgstPaise = pct(taxablePaise, cgstBp), sgstPaise = pct(taxablePaise, sgstBp), igstPaise = pct(taxablePaise, igstBp)
  const netPaise = taxablePaise + cgstPaise + sgstPaise + igstPaise
  const grandTotalPaise = opts.roundOff === false ? netPaise : Math.floor((netPaise + 50) / 100) * 100
  return {
    totalQty, grossPaise, discountBp, discountPaise, taxablePaise,
    cgstBp, cgstPaise, sgstBp, sgstPaise, igstBp, igstPaise,
    netPaise, roundOffPaise: grandTotalPaise - netPaise, grandTotalPaise,
  }
}
