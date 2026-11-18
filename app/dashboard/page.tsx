import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { DashboardPage } from '@/components/dashboard-page'

export const metadata = {
  title: 'Dashboard - Shayona Inventory',
  description: 'Manage and view your warehouse inventory',
}

export default async function Dashboard() {
  // Signed in is not enough: the account needs a role that allows this page.
  const u = await getSessionUser()
  if (!u) redirect('/sign-in')
  if (!hasPermission(u.roles, 'inventory.view')) redirect('/home')

  return <DashboardPage />
}
