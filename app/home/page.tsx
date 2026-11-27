import { requirePageUser } from '@/lib/authz'
import { HomeMenuPage } from '@/components/home-menu-page'
import type { AppRole } from '@/app/actions/users'

export const metadata = {
  title: 'Home - Shayona Inventory',
  description: 'Select a module to manage your warehouse inventory',
}

export default async function Home() {
  let role: AppRole = 'user'
  const u = await requirePageUser()
  role = (u.roles.join(',') || 'user') as AppRole

  return <HomeMenuPage role={role} />
}
