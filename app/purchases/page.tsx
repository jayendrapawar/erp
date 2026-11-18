import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { listBills, purchaseSummary } from '@/lib/purchases/store'
import { PurchasesPage } from '@/components/purchases/purchases-page'

export const metadata = {
  title: 'Purchases - Shayona Inventory',
  description: 'Expected stock from supplier bills, carton receiving and verification',
}

// First paint: 2 queries in parallel (figures, bills).
export default async function Purchases() {
  const u = await getSessionUser()
  if (!u) redirect('/sign-in')
  if (!hasPermission(u.roles, 'purchases.view')) redirect('/home')
  const [summary, bills] = await Promise.all([purchaseSummary(db), listBills(db, { limit: 200 })])
  return (
    <PurchasesPage
      initialSummary={summary}
      initialBills={bills}
      canUpload={hasPermission(u.roles, 'purchases.upload')}
      canReceive={hasPermission(u.roles, 'purchases.receive')}
      canManage={hasPermission(u.roles, 'purchases.manage')}
    />
  )
}
