import { requirePageUser } from '@/lib/authz'
import { retailerColumns } from '@/lib/retailer-columns'
import { db } from '@/lib/db'
import { vendors } from '@/lib/db/schema'
import { eq, asc } from 'drizzle-orm'
import type { BillingVendor } from '@/components/billing-scanner-page'
import {
  getAllOrders,
  getOrderStats,
  getAllSalesmanOrders,
  getPickerQueue,
  getBillerQueue,
  getPackedOrders,
  getProcurementSummary,
} from '@/app/actions/orders'
import { getUsersByRole } from '@/app/actions/users'
import { loadCatalogue } from '@/app/actions/catalogue'
import { getSets } from '@/app/actions/sets'
import { AdminHub } from './admin-hub'

export const metadata = { title: 'Admin Hub | Shayona' }

export default async function AdminPage() {
  let adminName = ''
  let adminId   = ''
  let isAccountant = false
  let userRoles: string[] = []
  const me = await requirePageUser({ anyRole: ['admin', 'accountant'], elseTo: '/orders' })
  userRoles = me.roles
  isAccountant = !userRoles.includes('admin') && userRoles.includes('accountant')
  adminName = me.name || me.email
  adminId   = me.id

  const [stats, allOrders, pickerRows, adminRows, salesmanOrders, pickerQueue, billerOrders, packedOrders, vendorRows, procurementRows, catalogue, sets] = await Promise.all([
    getOrderStats(),
    getAllOrders(),
    getUsersByRole('picker'),
    getUsersByRole('admin'),
    getAllSalesmanOrders(),
    getPickerQueue(),
    getBillerQueue(),
    getPackedOrders(),
    db.select(retailerColumns).from(vendors).where(eq(vendors.status, 'active')).orderBy(asc(vendors.partyName)),
    getProcurementSummary({ status: 'pending' }),
    loadCatalogue(),
    getSets(),
  ])

  // Merge pickers + admins (admins can also act as pickers); deduplicate by id
  const pickerSet = new Map([...adminRows, ...pickerRows].map(p => [p.id, p]))
  const pickers = Array.from(pickerSet.values()).map(p => ({
    id: p.id,
    name: p.name,
    email: p.email,
    role: 'picker' as const,
    createdAt: new Date(),
  }))

  const vendorMap = new Map(vendorRows.map(v => [
    v.partyName,
    {
      phone: v.phone || null,
      address: [v.address, v.city].filter(Boolean).join(', ') || null,
    },
  ]))

  const billingVendors: BillingVendor[] = vendorRows.map(v => ({
    id:      v.id,
    name:    v.partyName,
    code:    v.area   || null,
    phone:   v.phone  || null,
    address: [v.address, v.city].filter(Boolean).join(', ') || null,
  }))

  const dispatchOrders = packedOrders.map(o => {
    const v = vendorMap.get(o.shopkeeperName)
    return { ...o, shopkeeperPhone: v?.phone ?? null, shopkeeperAddress: v?.address ?? null }
  })

  return (
    <AdminHub
      adminName={adminName}
      adminId={adminId}
      isAccountant={isAccountant}
      userRoles={userRoles}
      stats={stats}
      allOrders={allOrders}
      pickers={pickers}
      salesmanOrders={salesmanOrders}
      pickerQueue={pickerQueue}
      billerOrders={billerOrders}
      dispatchOrders={dispatchOrders}
      procurementRows={procurementRows}
      catalogue={catalogue}
      sets={sets}
      pickers_list={pickers.map(p => ({ id: p.id, name: p.name ?? null }))}
      billingVendors={billingVendors}
    />
  )
}
