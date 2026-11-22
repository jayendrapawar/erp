import { getSessionUser } from '@/lib/authz'
import { hasPermission, ROLE_LABELS } from '@/lib/permissions'
import { goToTargets, NAV_ITEMS, sidebarSections } from '@/lib/nav'
import { BottomNav } from './bottom-nav'
import { SessionUserProvider } from './session-user'
import { Sidebar } from './sidebar'
import { KeyboardHelp } from './keyboard-help'
import { GoToKeys } from './go-to-keys'
import { ConfirmHost } from './confirm-dialog'
import { FormKeys } from './form-keys'

/**
 * Wraps every page (root layout): shares the signed-in user's name and role with the profile menu,
 * adds the sidebar on computers (redesign, 21 Nov 2026) and the phone bottom bar. Uses the session the page already loaded (getSessionUser is cached
 * per request), so it adds no query on most pages.
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  const u = await getSessionUser().catch(() => null)
  const items = u ? NAV_ITEMS.filter((i) => !i.permission || hasPermission(u.roles, i.permission)) : []
  const sections = u ? sidebarSections(u.roles) : []
  const info = u ? { name: u.name, roleLabel: u.roles.map((r) => ROLE_LABELS[r]).join(', ') || 'No role yet' } : null
  return (
    <SessionUserProvider user={info}>
      <div className="md:flex md:min-h-dvh">
        {u && <Sidebar sections={sections} />}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {u && <BottomNav items={items} />}
      {u && <KeyboardHelp />}
      {u && <GoToKeys targets={goToTargets(sections, u.roles)} />}
      {u && <FormKeys />}
      <ConfirmHost />
    </SessionUserProvider>
  )
}
