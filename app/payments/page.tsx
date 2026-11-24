import { requirePageUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { db, withDbRetry } from '@/lib/db'
import { listOutstanding, listPartyChoices } from '@/lib/payments/queries'
import { PaymentsPage } from '@/components/payments/payments-page'

export const metadata = {
  title: 'Payments - Shayona Inventory',
  description: 'What parties owe, money received, cheques',
}

// First paint: 2 queries in parallel (outstanding page, party list). Other tabs load when opened.
export default async function Payments() {
  const u = await requirePageUser({ permission: 'payments.view' })
  const [outstanding, parties] = await Promise.all([withDbRetry(() => listOutstanding(db)), withDbRetry(() => listPartyChoices(db))])
  return <PaymentsPage initialOutstanding={outstanding} parties={parties} canRecord={hasPermission(u.roles, 'payments.record')} />
}
