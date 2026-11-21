import { retailers } from '@/lib/db/schema'

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
  shopPhone: retailers.shopPhone,
  shopEnabled: retailers.shopEnabled,
  shopPinSetAt: retailers.shopPinSetAt,
  shopFailedPins: retailers.shopFailedPins,
  shopLockedUntil: retailers.shopLockedUntil,
  createdAt: retailers.createdAt,
  updatedAt: retailers.updatedAt,
}
