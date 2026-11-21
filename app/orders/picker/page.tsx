import { requirePageUser } from '@/lib/authz'
import { getPickerQueue } from '@/app/actions/orders'
import { PickerDashboard } from './picker-dashboard'

export const metadata = { title: 'Picker — Orders & Billing | Shayona' }

export default async function PickerPage() {
  let currentPickerId = ''
  const me = await requirePageUser({ anyRole: ['picker', 'admin'], elseTo: '/orders' })
  currentPickerId = me.id

  const queue = await getPickerQueue()
  return <PickerDashboard queue={queue} currentPickerId={currentPickerId} />
}
