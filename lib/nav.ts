// App modules for navigation (bottom bar on phones, "More" sheet). Pure: safe on server and client.
import { hasPermission, type Permission, type Role } from '@/lib/permissions'
import type { TranslationKey } from '@/lib/translations'

export type NavIcon = 'home' | 'scanner' | 'inventory' | 'orders' | 'purchases' | 'master' | 'reports'

export interface NavItem { href: string; label: TranslationKey; icon: NavIcon; permission: Permission | null }

/** In priority order: the first ones a role may open go in the bottom bar, the rest in "More". */
export const NAV_ITEMS: NavItem[] = [
  { href: '/home', label: 'navHome', icon: 'home', permission: null },
  { href: '/scanner', label: 'scanner', icon: 'scanner', permission: 'scan.record' },
  { href: '/orders', label: 'navOrders', icon: 'orders', permission: 'orders.view' },
  { href: '/inventory', label: 'navInventory', icon: 'inventory', permission: 'inventory.view.all' },
  { href: '/purchases', label: 'navPurchases', icon: 'purchases', permission: 'purchases.view' },
  { href: '/master', label: 'navMaster', icon: 'master', permission: 'users.view' },
  { href: '/reports', label: 'navReports', icon: 'reports', permission: 'users.view' },
]

/** Bottom bar slots before "More". */
export const BAR_SLOTS = 4

// ── Sidebar (redesign, owner 21 Nov 2026) ─────────────────────────────────────
// Grouped menu for computers. Sub-items open a tab of the page through the address hash
// (/master#articles), which the page reads — no extra server request. Labels are English; the
// Hindi phrase book (lib/i18n/hi.json) translates them on screen.


export interface SideLink { href: string; label: string; icon?: NavIcon; children?: SideLink[] }
export interface SideSection { title: string | null; links: SideLink[] }

export function sidebarSections(roles: readonly Role[]): SideSection[] {
  const can = (p: Permission | null) => !p || hasPermission(roles, p)
  const isAdmin = roles.includes('admin')
  const isAccountant = roles.includes('accountant') && !isAdmin

  // Orders: admins and accountants use the admin hub (/orders/admin); others the role hub (/orders).
  let orders: SideLink | null = null
  if (can('orders.view')) {
    const hub = isAdmin || roles.includes('accountant')
    const base = hub ? '/orders/admin' : '/orders'
    const tabs: Array<[string, string]> = hub
      ? [['overview', 'Overview'], ['salesman', 'Salesman'],
         ...(!isAccountant || roles.includes('picker') ? [['picker', 'Picker'] as [string, string]] : []),
         ...(!isAccountant || roles.includes('biller') ? [['biller', 'Biller'] as [string, string]] : []),
         ...(!isAccountant || roles.includes('dispatcher') ? [['dispatcher', 'Dispatcher'] as [string, string]] : []),
         ['procurement', 'Procurement']]
      : (['salesman', 'picker', 'biller', 'dispatcher'] as const).filter((r) => roles.includes(r)).map((r) => [r, r[0].toUpperCase() + r.slice(1)])
    orders = { href: base, label: 'Orders', icon: 'orders', children: tabs.length > 1 ? tabs.map(([h, l]) => ({ href: `${base}#${h}`, label: l })) : undefined }
  }

  const master: SideLink | null = can('users.view') ? {
    href: '/master', label: 'Master', icon: 'master',
    children: [
      ...(isAccountant ? [] : [{ href: '/master#users', label: 'Users' }]),
      { href: '/master#vendors', label: 'Retailers' },
      { href: '/master#suppliers', label: 'Suppliers' },
      { href: '/master#articles', label: 'Articles' },
      { href: '/master#assortments', label: 'Assortments' },
      ...(isAccountant ? [] : [{ href: '/master#sets', label: 'Sets' }, { href: '/master#bill', label: 'Bill template' }]),
    ],
  } : null

  const sections: SideSection[] = [
    { title: null, links: [{ href: '/home', label: 'Home', icon: 'home' }] },
    { title: 'Daily work', links: [
      ...(can('scan.record') ? [{ href: '/scanner', label: 'Scanner', icon: 'scanner' as NavIcon }] : []),
      ...(orders ? [orders] : []),
    ] },
    { title: 'Stock', links: [
      ...(can('inventory.view.all') ? [{ href: '/inventory', label: 'Inventory', icon: 'inventory' as NavIcon }] : []),
      ...(can('purchases.view') ? [{ href: '/purchases', label: 'Purchases', icon: 'purchases' as NavIcon }] : []),
    ] },
    { title: 'Setup', links: [
      ...(master ? [master] : []),
      ...(can('users.view') ? [{ href: '/reports', label: 'Reports', icon: 'reports' as NavIcon }] : []),
    ] },
  ]
  return sections.filter((s) => s.links.length > 0)
}
