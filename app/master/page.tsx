import { requirePageUser } from '@/lib/authz'
import { getAllUsers } from '@/app/actions/users'
import { MasterDashboard } from './master-dashboard'
import { getVendors } from '@/app/actions/vendors'
import { getArticles, getCatalogReviewItems, getMissingArticles } from '@/app/actions/articles'
import { getSets } from '@/app/actions/sets'
import { getSuppliers } from '@/app/actions/suppliers'
import { getAssortments } from '@/app/actions/assortments'

export const metadata = {
  title: 'Master - Shayona Inventory',
  description: 'User management, role assignment & master data',
}

export default async function MasterPage() {
  let currentUserId = ''
  let isAccountant = false
  const me = await requirePageUser({ anyRole: ['admin', 'accountant'] })
  currentUserId = me.id
  isAccountant = !me.roles.includes('admin') && me.roles.includes('accountant')

  const [allUsers, vendors, articles, sets, missingArticles, suppliers, catalogReviewItems, assortments] = await Promise.all([
    getAllUsers(),
    getVendors(),
    getArticles(),
    getSets(),
    getMissingArticles(),
    getSuppliers(),
    getCatalogReviewItems(),
    getAssortments(),
  ])

  return (
    <MasterDashboard
      users={allUsers}
      currentUserId={currentUserId}
      vendors={vendors}
      articles={articles}
      missingArticles={missingArticles}
      catalogReviewItems={catalogReviewItems}
      sets={sets}
      suppliers={suppliers}
      assortments={assortments}
      isAccountant={isAccountant}
    />
  )
}
