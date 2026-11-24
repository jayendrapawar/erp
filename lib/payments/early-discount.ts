// Early-payment discount SUGGESTION (owner, 23 Nov 2026). Pure, client-safe.
//
// A few parties get a discount when they pay a bill early, each its own % (retailers.earlyPayDiscountBp)
// within its own number of days (retailers.earlyPayDays). Base = the bill amount BEFORE GST
// (taxablePaise). How much is given depends on how late the payment comes ("it's subjective"), so the
// app only suggests: the full % when paid within the days, nothing after. The accountant can change
// or untick it. It never exceeds what is still unpaid on the bill.

export interface EarlyDiscountTerms { discountBp: number | null; days: number | null }
export interface DiscountableBill { taxablePaise: number; billDate: string; openPaise: number }

/** Whole days from the bill date to the payment date (both YYYY-MM-DD). */
export function daysBetween(fromDate: string, toDate: string): number {
  const d = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
  return Math.round((d(toDate) - d(fromDate)) / 86_400_000)
}

/** Suggested discount in paise (0 = none). */
export function suggestEarlyDiscount(terms: EarlyDiscountTerms, bill: DiscountableBill, payDate: string): number {
  if (!terms.discountBp || !terms.days) return 0
  const days = daysBetween(bill.billDate, payDate)
  if (days < 0 || days > terms.days) return 0
  const paise = Math.floor((bill.taxablePaise * terms.discountBp + 5000) / 10000)
  return Math.max(0, Math.min(paise, bill.openPaise))
}
