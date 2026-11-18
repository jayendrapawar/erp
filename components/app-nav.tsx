import { getSessionUser } from '@/lib/authz'
import { hasPermission, ROLE_LABELS } from '@/lib/permissions'
import { NAV_ITEMS } from '@/lib/nav'
import { BottomNav } from './bottom-nav'

/**
 * Phone navigation for signed-in users (rendered once, in the root layout). Uses the session the
 * page already loaded (getSessionUser is cached per request), so it adds no query on most pages.
 */
export async function AppNav() {
  const u = await getSessionUser().catch(() => null)
  if (!u) return null
  const items = NAV_ITEMS.filter((i) => !i.permission || hasPermission(u.roles, i.permission))
  return <BottomNav items={items} userName={u.name} roleLabel={u.roles.map((r) => ROLE_LABELS[r]).join(', ') || 'No role yet'} />
}
