import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { listBills, purchaseSummary } from '@/lib/purchases/store'
import { SETTING_BILL_MAIL_START, getSetting } from '@/lib/settings'
import { PurchasesPage } from '@/components/purchases/purchases-page'

export const metadata = {
  title: 'Purchases - Shayona Inventory',
  description: 'Expected stock from supplier bills, carton receiving and verification',
}

// First paint: 3 queries in parallel (figures, bills, mail start date).
export default async function Purchases() {
  const u = await getSessionUser()
  if (!u) redirect('/sign-in')
  if (!hasPermission(u.roles, 'purchases.view')) redirect('/home')
  const [summary, bills, mailStart] = await Promise.all([purchaseSummary(db), listBills(db, { limit: 200 }), getSetting<string>(db, SETTING_BILL_MAIL_START)])
  return (
    <PurchasesPage
      initialSummary={summary}
      initialBills={bills}
      canUpload={hasPermission(u.roles, 'purchases.upload')}
      mailboxReady={Boolean(process.env.BILL_MAIL_USER && process.env.BILL_MAIL_PASSWORD && process.env.BILL_MAIL_FROM)}
      mailStart={{ day: mailStart?.value ?? null, updatedByName: mailStart?.updatedByName ?? '', updatedAt: mailStart?.updatedAt ?? null }}
      canSetMailStart={hasPermission(u.roles, 'purchases.mail_start')}
      canReceive={hasPermission(u.roles, 'purchases.receive')}
      canManage={hasPermission(u.roles, 'purchases.manage')}
    />
  )
}
