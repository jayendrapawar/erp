import { requirePageUser } from '@/lib/authz'
import { loadOverview } from './tab-data'
import { AdminHub } from './admin-hub'

export const metadata = { title: 'Admin Hub | Shayona' }

// Orders speed (22 Nov 2026): the page prepares only the Overview tab (4 queries, was 12 for all
// tabs). Other tabs load when opened, from GET /api/orders/admin-tab (see admin-hub.tsx).
export default async function AdminPage() {
  const me = await requirePageUser({ anyRole: ['admin', 'accountant'], elseTo: '/orders' })
  const userRoles = me.roles
  const isAccountant = !userRoles.includes('admin') && userRoles.includes('accountant')
  const overview = await loadOverview()

  return (
    <AdminHub
      adminName={me.name || me.email}
      adminId={me.id}
      isAccountant={isAccountant}
      userRoles={userRoles}
      overview={overview}
      // Changes whenever the server renders this page again (a save that refreshes it): the open tab refetches.
      renderedAt={Date.now()}
    />
  )
}
