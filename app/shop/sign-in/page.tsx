import { redirect } from 'next/navigation'
import { getShopSession } from '@/lib/shop/auth'
import { ShopSignIn } from '@/components/shop/shop-sign-in'

export const metadata = { title: 'Sign in — Shayona order app' }

export default async function ShopSignInPage() {
  if (await getShopSession()) redirect('/shop')
  return <ShopSignIn />
}
