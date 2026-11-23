// Details printed on sale bills, editable by an admin in Master → Bill template (owner, 20 Nov 2026).
// Stored in app_settings under "bill.template" (migration 0009 table; audited). Client-safe.
//
// The DEFAULT bill discount and GST rates are here too (owner, 24 Nov 2026: editable; a bill may
// change them). Every bill stores the rates it was made with (sale_bills), so a reprint never changes.

import { DEFAULT_BILL_RATES, type BillRates } from './billing/bill-totals'

export const SETTING_BILL_TEMPLATE = 'bill.template'

export interface BillTemplate {
  tagline: string
  shopName: string
  address: string
  gstin: string
  phone: string
  email: string
  bankName: string
  accountNo: string
  ifsc: string
  branch: string
  upiId: string
  /** PNG / JPEG data URL of the payment QR; '' = the shop's standard QR. */
  qrImage: string
  showQr: boolean
  showBank: boolean
  /** Retailer name also in Hindi (looked up when printing). */
  showHindiName: boolean
  /** One per line, printed small above the signatures. */
  terms: string
  footer: string
  defaultPageSize: 'A4' | 'A5'
  /** Heading on bills without GST (a bill without tax cannot say "TAX INVOICE"; owner to confirm the words). */
  untaxedHeading: string
  /** Default bill discount % on GST bills (bills without GST: 0 unless typed). */
  discountPct: number
  cgstPct: number
  sgstPct: number
  igstPct: number
}

/** The default rates in a template. */
export const templateRates = (t: BillTemplate): BillRates => ({ discountPct: t.discountPct, cgstPct: t.cgstPct, sgstPct: t.sgstPct, igstPct: t.igstPct })

export const DEFAULT_BILL_TEMPLATE: BillTemplate = {
  tagline: '!! JAY SHREE SWAMINARAYAN !!',
  shopName: 'SHAYONA SHOE PALACE',
  address: 'Plot No 16, 17, Sahkar Group Society, Opp. Harinagar, Udhna',
  gstin: '24ABEPA6540L1ZV',
  phone: '',
  email: '',
  bankName: 'ICICI BANK',
  accountNo: '183605003484',
  ifsc: 'ICIC0001836',
  branch: 'VED ROAD',
  upiId: '',
  qrImage: '',
  showQr: true,
  showBank: true,
  showHindiName: true,
  terms: 'Goods once sold will not be taken back.\nSubject to Surat jurisdiction.',
  footer: 'Thank you for your business',
  defaultPageSize: 'A4',
  untaxedHeading: 'BILL',
  ...DEFAULT_BILL_RATES,
}

const LIMITS: Partial<Record<keyof BillTemplate, number>> = {
  tagline: 80, shopName: 60, address: 200, gstin: 20, phone: 60, email: 80, bankName: 60, accountNo: 30,
  ifsc: 20, branch: 60, upiId: 80, terms: 600, footer: 120, untaxedHeading: 40,
}
const MAX_QR_CHARS = 400_000

/** Fill gaps with defaults, trim, cap lengths, refuse odd values. */
export function normalizeBillTemplate(raw: unknown): BillTemplate {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = { ...DEFAULT_BILL_TEMPLATE }
  for (const [k, max] of Object.entries(LIMITS) as [keyof BillTemplate, number][]) {
    if (typeof r[k] === 'string') (out as Record<string, unknown>)[k] = (r[k] as string).replace(/\r\n/g, '\n').trim().slice(0, max)
  }
  for (const k of ['showQr', 'showBank', 'showHindiName'] as const) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  if (r.defaultPageSize === 'A4' || r.defaultPageSize === 'A5') out.defaultPageSize = r.defaultPageSize
  if (typeof r.qrImage === 'string' && (r.qrImage === '' || (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(r.qrImage) && r.qrImage.length <= MAX_QR_CHARS))) out.qrImage = r.qrImage
  if (!out.shopName) out.shopName = DEFAULT_BILL_TEMPLATE.shopName
  if (!out.untaxedHeading || /tax\s*invoice/i.test(out.untaxedHeading)) out.untaxedHeading = DEFAULT_BILL_TEMPLATE.untaxedHeading
  // Rates: 0–100 %, two decimals; anything else keeps the default.
  for (const k of ['discountPct', 'cgstPct', 'sgstPct', 'igstPct'] as const) {
    const v = typeof r[k] === 'string' && (r[k] as string).trim() !== '' ? Number(r[k]) : r[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) out[k] = Math.round(v * 100) / 100
  }
  return out
}

/** Problems that block saving (shown on the screen). */
export function checkBillTemplate(t: BillTemplate): string[] {
  const e: string[] = []
  if (t.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(t.gstin.toUpperCase())) e.push('GSTIN should be 15 letters and digits (e.g. 24ABEPA6540L1ZV).')
  if (t.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(t.ifsc.toUpperCase())) e.push('IFSC should look like ICIC0001836.')
  if (t.upiId && !/^[\w.-]+@[\w.-]+$/.test(t.upiId)) e.push('UPI ID should look like name@bank.')
  for (const [k, label] of [['discountPct', 'Bill discount'], ['cgstPct', 'CGST'], ['sgstPct', 'SGST'], ['igstPct', 'IGST']] as const) {
    if (!Number.isFinite(t[k]) || t[k] < 0 || t[k] > 100) e.push(`${label} must be between 0 and 100 %.`)
  }
  return e
}
