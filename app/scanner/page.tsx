import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { ScannerPage } from '@/components/scanner-page'

export const metadata = {
  title: 'Scanner - Shayona Inventory',
  description: 'Scan warehouse inventory items',
}

export default async function Scanner() {
  // Signed in is not enough: the account needs a role that allows this page.
  const u = await getSessionUser()
  if (!u) redirect('/sign-in')
  if (!hasPermission(u.roles, 'scan.record')) redirect('/home')

  return <ScannerPage />
}
