// Admin Orders hub: the data of ONE tab (server only). The page loads only Overview; the other tabs
// come from GET /api/orders/admin-tab?tab=… when opened (Orders speed, 22 Nov 2026). Queries per tab:
// overview 4, salesman 4, picker 1, biller 2, dispatcher 2, procurement 1 (in parallel).

import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { vendors } from '@/lib/db/schema'
import { retailerColumns } from '@/lib/retailer-columns'
import type { SessionUser } from '@/lib/authz'
import type { BillingVendor } from '@/components/billing-scanner-page'
import {
  getAllOrders, getAllSalesmanOrders, getBillerQueue, getOrderStats, getPackedOrders, getPickerQueue, getProcurementSummary,
} from '@/app/actions/orders'
import { getUsersByRole } from '@/app/actions/users'
import { getSets } from '@/app/actions/sets'
import { listPickerChoices } from '@/lib/orders/pickers'

export const ADMIN_TABS = ['overview', 'salesman', 'picker', 'biller', 'dispatcher', 'procurement'] as const
export type AdminTab = (typeof ADMIN_TABS)[number]

/** Accountants see the picker / biller / dispatcher tabs only with that role too (as before). */
export function tabAllowed(tab: AdminTab, roles: readonly string[]): boolean {
  const accountantOnly = !roles.includes('admin') && roles.includes('accountant')
  if (!accountantOnly) return true
  return tab === 'picker' || tab === 'biller' || tab === 'dispatcher' ? roles.includes(tab) : true
}

/** Pickers to choose from: pickers + admins (admins can pick too), one row each. */
async function pickerChoices() {
  const [pickerRows, adminRows] = await Promise.all([getUsersByRole('picker'), getUsersByRole('admin')])
  return Array.from(new Map([...adminRows, ...pickerRows].map((p) => [p.id, p])).values())
    .map((p) => ({ id: p.id, name: p.name, email: p.email, role: 'picker' as const, createdAt: new Date() }))
}

export async function loadOverview() {
  const [stats, allOrders, pickers] = await Promise.all([getOrderStats(), getAllOrders(), pickerChoices()])
  return { stats, allOrders, pickers }
}

async function loadSalesman() {
  const [salesmanOrders, sets, pickers] = await Promise.all([getAllSalesmanOrders(), getSets(), pickerChoices()])
  return { salesmanOrders, sets, pickers_list: pickers.map((p) => ({ id: p.id, name: p.name ?? null })) }
}

async function loadBiller() {
  const [billerOrders, vendorRows, pickers] = await Promise.all([
    getBillerQueue(),
    db.select(retailerColumns).from(vendors).where(eq(vendors.status, 'active')).orderBy(asc(vendors.partyName)),
    listPickerChoices(db), // Direct bill: who picked it
  ])
  const billingVendors: BillingVendor[] = vendorRows.map((v) => ({
    id: v.id, name: v.partyName, code: v.area || null, phone: v.phone || null,
    address: [v.address, v.city].filter(Boolean).join(', ') || null,
  }))
  return { billerOrders, billingVendors, pickers }
}

async function loadDispatcher() {
  const [packedOrders, vendorRows] = await Promise.all([
    getPackedOrders(),
    db.select({ partyName: vendors.partyName, phone: vendors.phone, address: vendors.address, city: vendors.city }).from(vendors).where(eq(vendors.status, 'active')),
  ])
  const vendorMap = new Map(vendorRows.map((v) => [v.partyName, { phone: v.phone || null, address: [v.address, v.city].filter(Boolean).join(', ') || null }]))
  return {
    dispatchOrders: packedOrders.map((o) => {
      const v = vendorMap.get(o.shopkeeperName)
      return { ...o, shopkeeperPhone: v?.phone ?? null, shopkeeperAddress: v?.address ?? null }
    }),
  }
}

export async function loadAdminTab(tab: AdminTab) {
  switch (tab) {
    case 'overview': return loadOverview()
    case 'salesman': return loadSalesman()
    case 'picker': return { pickerQueue: await getPickerQueue() }
    case 'biller': return loadBiller()
    case 'dispatcher': return loadDispatcher()
    case 'procurement': return { procurementRows: await getProcurementSummary({ status: 'pending' }) }
  }
}

export type AdminTabData = {
  overview: Awaited<ReturnType<typeof loadOverview>>
  salesman: Awaited<ReturnType<typeof loadSalesman>>
  picker: { pickerQueue: Awaited<ReturnType<typeof getPickerQueue>> }
  biller: Awaited<ReturnType<typeof loadBiller>>
  dispatcher: Awaited<ReturnType<typeof loadDispatcher>>
  procurement: { procurementRows: Awaited<ReturnType<typeof getProcurementSummary>> }
}

export type { SessionUser }
