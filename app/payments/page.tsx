import { requirePageUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { db, withDbRetry } from '@/lib/db'
import { listOutstanding, listPartyChoices } from '@/lib/payments/queries'
import { listBanks } from '@/lib/payments/slips'
import { PaymentsPage } from '@/components/payments/payments-page'

export const metadata = {
  title: 'Payments - Shayona Inventory',
  description: 'What parties owe, money received, cheques',
}

// First paint: 3 queries in parallel (outstanding page, party list, banks). Other tabs load when opened.
export default async function Payments() {
  const u = await requirePageUser({ permission: 'payments.view' })
  const [outstanding, parties, banks] = await Promise.all([withDbRetry(() => listOutstanding(db)), withDbRetry(() => listPartyChoices(db)), withDbRetry(() => listBanks(db, { activeOnly: true }))])
  return <PaymentsPage initialOutstanding={outstanding} parties={parties} banks={banks} canRecord={hasPermission(u.roles, 'payments.record')} />
}
