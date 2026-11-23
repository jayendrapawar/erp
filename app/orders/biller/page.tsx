import { requirePageUser } from '@/lib/authz'
import { retailerColumns } from '@/lib/retailer-columns'
import { db } from '@/lib/db'
import { vendors } from '@/lib/db/schema'
import { eq, asc } from 'drizzle-orm'
import { getBillerQueue } from '@/app/actions/orders'
import { loadCatalogue } from '@/app/actions/catalogue'
import { BillerDashboard } from './biller-dashboard'
import { listPickerChoices } from '@/lib/orders/pickers'
import type { BillingVendor } from '@/components/billing-scanner-page'

export const metadata = { title: 'Biller — Orders & Billing | Shayona' }

export default async function BillerPage() {
  let currentBillerId = ''
  const me = await requirePageUser({ anyRole: ['biller', 'admin'], elseTo: '/orders' })
  currentBillerId = me.id

  const [billerOrders, vendorRows, catalogue, pickers] = await Promise.all([
    getBillerQueue(),
    db.select(retailerColumns).from(vendors).where(eq(vendors.status, 'active')).orderBy(asc(vendors.partyName)),
    loadCatalogue(),
    listPickerChoices(db),
  ])

  const billingVendors: BillingVendor[] = vendorRows.map(v => ({
    id:      v.id,
    name:    v.partyName,
    code:    v.area   || null,
    phone:   v.phone  || null,
    address: [v.address, v.city].filter(Boolean).join(', ') || null,
  }))

  const articleNumbers = catalogue.articles.map(a => a.artNumber)
  return <BillerDashboard orders={billerOrders} currentBillerId={currentBillerId} vendors={billingVendors} articles={articleNumbers} pickers={pickers} />
}
