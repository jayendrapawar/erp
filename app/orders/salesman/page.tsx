import { requirePageUser } from '@/lib/authz'
import { getSalesmanOrders } from '@/app/actions/orders'
import { loadCatalogue } from '@/app/actions/catalogue'
import { getSets } from '@/app/actions/sets'
import { getPickersList } from '@/app/actions/users'
import { SalesmanDashboard } from './salesman-dashboard'

export const metadata = { title: 'Salesman — Orders & Billing | Shayona' }

export default async function SalesmanPage() {
  let sessionUser: { id: string; name?: string | null; email?: string } | null = null
  const me = await requirePageUser({ anyRole: ['salesman', 'admin'], elseTo: '/orders' })
  sessionUser = { id: me.id, name: me.name, email: me.email }

  // Load orders, catalogue, sets and pickers in parallel — one round-trip total
  const [myOrders, catalogue, sets, pickers] = await Promise.all([
    getSalesmanOrders(),
    loadCatalogue(),
    getSets(),
    getPickersList(),
  ])

  return (
    <SalesmanDashboard
      orders={myOrders}
      userName={sessionUser?.name ?? ''}
      userId={me.id}
      catalogue={catalogue}
      sets={sets}
      pickers={pickers}
    />
  )
}
