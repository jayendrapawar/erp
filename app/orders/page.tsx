import { requirePageUser } from '@/lib/authz'
import { retailerColumns, toBillingVendor } from '@/lib/retailer-columns'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { vendors } from '@/lib/db/schema'
import { eq, asc } from 'drizzle-orm'
import { getSalesmanOrders, getPickerQueue, getBillerQueue, getPackedOrders } from '@/app/actions/orders'
import { loadCatalogue } from '@/app/actions/catalogue'
import { getSets } from '@/app/actions/sets'
import { getPickersList } from '@/app/actions/users'
import { MultiRoleOrdersHub } from './_components/multi-role-hub'
import type { BillingVendor } from '@/components/billing-scanner-page'

export const metadata = {
  title: 'Orders & Billing - Shayona Inventory',
  description: 'Orders, picking, billing and dispatch',
}

async function loadVendorMap() {
  const rows = await db.select({
    partyName: vendors.partyName,
    phone: vendors.phone,
    address: vendors.address,
    city: vendors.city,
  }).from(vendors)
  return new Map(rows.map(v => [
    v.partyName,
    {
      phone: v.phone || null,
      address: [v.address, v.city].filter(Boolean).join(', ') || null,
    },
  ]))
}

export default async function OrdersPage() {
  {
    const me = await requirePageUser()
    const roles: string[] = me.roles

    if (roles.includes('admin') || roles.includes('accountant')) {
      redirect('/orders/admin')
    }

    const orderRoles = roles.filter(r => ['salesman', 'picker', 'biller', 'dispatcher'].includes(r))

    if (orderRoles.length === 0) {
      redirect('/orders/pending-role')
    }

    // Load data for all assigned order roles and render the multi-tab Order Hub
    let salesmanOrders: any[] = []
    let pickerQueue: any[] = []
    let billerOrders: any[] = []
    let dispatcherOrders: any[] = []

    const promises: Promise<any>[] = []

    if (orderRoles.includes('salesman')) {
      promises.push(getSalesmanOrders().then(res => { salesmanOrders = res }))
    }
    if (orderRoles.includes('picker')) {
      promises.push(getPickerQueue().then(res => { pickerQueue = res }))
    }
    if (orderRoles.includes('biller')) {
      promises.push(getBillerQueue().then(res => { billerOrders = res }))
    }
    if (orderRoles.includes('dispatcher')) {
      promises.push(
        Promise.all([getPackedOrders(), loadVendorMap()]).then(([packed, vendorMap]) => {
          dispatcherOrders = packed.map(o => {
            const v = vendorMap.get(o.shopkeeperName)
            return { ...o, shopkeeperPhone: v?.phone ?? null, shopkeeperAddress: v?.address ?? null }
          })
        })
      )
    }

    const [catalogue, vendorRows, sets, pickers] = await Promise.all([
      loadCatalogue(),
      db.select(retailerColumns).from(vendors).where(eq(vendors.status, 'active')).orderBy(asc(vendors.partyName)),
      getSets(),
      getPickersList(),
      ...promises,
    ])

    const billingVendors: BillingVendor[] = vendorRows.map(toBillingVendor)

    return (
      <MultiRoleOrdersHub
        roles={roles}
        salesmanOrders={salesmanOrders}
        userName={me.name}
        pickerQueue={pickerQueue}
        currentPickerId={me.id}
        billerOrders={billerOrders}
        currentBillerId={me.id}
        dispatcherOrders={dispatcherOrders}
        catalogue={catalogue}
        sets={sets}
        pickers={pickers}
        billingVendors={billingVendors}
      />
    )
  }
}
