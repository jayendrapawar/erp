import { redirect } from 'next/navigation'
import { asc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { getSessionUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { listStock, stockSummary } from '@/lib/inventory/stock-queries'
import { InventoryPage } from '@/components/inventory/inventory-page'

export const metadata = {
  title: 'Inventory - Shayona Inventory',
  description: 'Stock on hand, value and every stock movement',
}

// First paint: 3 queries in parallel (header figures, first page of stock, staff names for the filter).
export default async function Inventory() {
  const u = await getSessionUser()
  if (!u) redirect('/sign-in')
  if (!hasPermission(u.roles, 'inventory.view.all')) redirect('/home')

  const [summary, firstPage, staff] = await Promise.all([
    stockSummary(db),
    listStock(db, {}),
    db.select({ id: user.id, name: user.name }).from(user).orderBy(asc(user.name)),
  ])

  return (
    <InventoryPage
      initialSummary={summary}
      initialStock={firstPage}
      staff={staff.map((s) => ({ id: s.id, name: s.name ?? s.id }))}
      canAdjust={hasPermission(u.roles, 'inventory.adjust')}
    />
  )
}
