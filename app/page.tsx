import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/authz'

export const metadata = {
  title: 'Shayona Inventory Management',
  description: 'Warehouse inventory scanning and management system',
}

export default async function Home() {
  const u = await getSessionUser()
  redirect(u ? '/home' : '/sign-in')
}
