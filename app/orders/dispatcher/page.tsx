import { requirePageUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { vendors } from '@/lib/db/schema'
import { getPackedOrders } from '@/app/actions/orders'
import { DispatcherDashboard } from './dispatcher-dashboard'

export const metadata = { title: 'Dispatcher — Orders & Billing | Shayona' }

async function loadVendorMap(): Promise<Map<string, { phone: string | null; address: string | null }>> {
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

export default async function DispatcherPage() {
  let currentDispatcherId = ''
  const me = await requirePageUser({ anyRole: ['dispatcher', 'admin'], elseTo: '/orders' })
  currentDispatcherId = me.id

  const [packedOrders, vendorMap] = await Promise.all([getPackedOrders(), loadVendorMap()])

  const enriched = packedOrders.map(o => {
    const v = vendorMap.get(o.shopkeeperName)
    return { ...o, shopkeeperPhone: v?.phone ?? null, shopkeeperAddress: v?.address ?? null }
  })

  return <DispatcherDashboard orders={enriched} currentDispatcherId={currentDispatcherId} />
}
