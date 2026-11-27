import { retailers } from '@/lib/db/schema'
import type { BillingVendor } from '@/components/billing-scanner-page'

/**
 * Retailer columns that may leave the server. Everything except the shop PIN hash (migration 0015):
 * use `db.select(retailerColumns).from(retailers)` instead of `select()` wherever rows reach a page.
 */
export const retailerColumns = {
  id: retailers.id,
  partyName: retailers.partyName,
  gst: retailers.gst,
  phone: retailers.phone,
  email: retailers.email,
  address: retailers.address,
  city: retailers.city,
  area: retailers.area,
  day: retailers.day,
  salesman: retailers.salesman,
  status: retailers.status,
  taxType: retailers.taxType,
  shopPhone: retailers.shopPhone,
  shopEnabled: retailers.shopEnabled,
  shopPinSetAt: retailers.shopPinSetAt,
  shopFailedPins: retailers.shopFailedPins,
  shopLockedUntil: retailers.shopLockedUntil,
  createdAt: retailers.createdAt,
  updatedAt: retailers.updatedAt,
}

/** A retailer row → the party list of the billing screens (with its bill type for the default). */
export function toBillingVendor(v: { id: string; partyName: string; area: string | null; phone: string | null; address: string | null; city: string | null; taxType: BillingVendor['taxType'] }): BillingVendor {
  return {
    id: v.id, name: v.partyName, code: v.area || null, phone: v.phone || null,
    address: [v.address, v.city].filter(Boolean).join(', ') || null, taxType: v.taxType,
  }
}
