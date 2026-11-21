import { redirect } from 'next/navigation'
import { getShopSession } from '@/lib/shop/auth'
import { getShopCatalogue } from '@/lib/shop/catalogue'
import { ShopApp } from '@/components/shop/shop-app'

export const metadata = { title: 'Shayona order app' }
export const dynamic = 'force-dynamic' // signed-in retailer from the cookie

// Session from the signed cookie (no query); catalogue from the cache (no query most of the time).
export default async function ShopPage() {
  const s = await getShopSession()
  if (!s) redirect('/shop/sign-in')
  const catalogue = await getShopCatalogue()
  return <ShopApp catalogue={catalogue} retailerId={s.retailerId} retailerName={s.name} />
}
