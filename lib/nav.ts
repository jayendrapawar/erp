// App modules for navigation (bottom bar on phones, "More" sheet). Pure: safe on server and client.
import { hasPermission, type Permission, type Role } from '@/lib/permissions'
import type { TranslationKey } from '@/lib/translations'

export type NavIcon = 'home' | 'scanner' | 'inventory' | 'orders' | 'payments' | 'purchases' | 'master' | 'reports'

export interface NavItem { href: string; label: TranslationKey; icon: NavIcon; permission: Permission | null }

/** In priority order: the first ones a role may open go in the bottom bar, the rest in "More". */
export const NAV_ITEMS: NavItem[] = [
  { href: '/home', label: 'navHome', icon: 'home', permission: null },
  { href: '/scanner', label: 'scanner', icon: 'scanner', permission: 'scan.record' },
  { href: '/orders', label: 'navOrders', icon: 'orders', permission: 'orders.view' },
  { href: '/inventory', label: 'navInventory', icon: 'inventory', permission: 'inventory.view.all' },
  { href: '/payments', label: 'navPayments', icon: 'payments', permission: 'payments.view' },
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
      ...(orders ? [orders] : []),
      // Payments (owner, 22 Nov 2026): what retailers owe, money received, cheques.
      ...(can('payments.view') ? [{ href: '/payments', label: 'Payments', icon: 'payments' as NavIcon, children: [
        { href: '/payments#outstanding', label: 'Outstanding' }, { href: '/payments#cheques', label: 'Payments & cheques' },
        { href: '/payments#statement', label: 'Party statement' },
      ] }] : []),
    ] },
    { title: 'Stock', links: [
      ...(can('inventory.view.all') ? [{ href: '/inventory', label: 'Inventory', icon: 'inventory' as NavIcon, children: [
        { href: '/inventory#overview', label: 'Overview' }, { href: '/inventory#stock', label: 'Stock' },
        { href: '/inventory#movements', label: 'Movements' }, { href: '/inventory#dispatch', label: 'Unscanned dispatch' },
      ] }] : []),
      // Scanner sits with Inventory (owner 23 Nov 2026). A top-level link, not an Inventory sub-item:
      // sub-items are hash tabs of /inventory, and this keeps it reachable when the sidebar is collapsed.
      ...(can('scan.record') ? [{ href: '/scanner', label: 'Scanner', icon: 'scanner' as NavIcon }] : []),
      ...(can('purchases.view') ? [{ href: '/purchases', label: 'Purchases', icon: 'purchases' as NavIcon, children: [
        { href: '/purchases#bills', label: 'Bills' }, { href: '/purchases#receive', label: 'Receive' },
        { href: '/purchases#expected', label: 'Expected stock' }, { href: '/purchases#unexpected', label: 'Unexpected' },
      ] }] : []),
    ] },
    { title: 'Setup', links: [
      ...(master ? [master] : []),
      ...(can('users.view') ? [{ href: '/reports', label: 'Reports', icon: 'reports' as NavIcon }] : []),
    ] },
  ]
  return sections.filter((s) => s.links.length > 0)
}

// ── Go-to chords (keyboard, docs/architecture/keyboard.md) ───────────────────
// "g" then a letter. Only pages in the user's own menu (sidebarSections), so roles decide.

export interface GoToTarget { letter: string; label: string; href: string }

export function goToTargets(sections: SideSection[], roles: readonly Role[]): GoToTarget[] {
  const links = sections.flatMap((s) => s.links)
  const top = (path: string) => links.find((l) => l.href === path)?.href
  const orders = links.find((l) => l.icon === 'orders')
  // Billing: the Biller tab of the orders hub; a biller whose only order role is billing has no tabs.
  const billing = orders?.children?.find((c) => c.href.endsWith('#biller'))?.href
    ?? (orders && roles.includes('biller') ? orders.href : undefined)
  const all: Array<[string, string, string | undefined]> = [
    ['h', 'Home', top('/home')],
    ['o', 'Orders', orders?.href],
    ['i', 'Inventory', top('/inventory')],
    ['s', 'Scanner', top('/scanner')],
    ['b', 'Billing', billing],
    ['y', 'Payments', top('/payments')],
    ['p', 'Purchases', top('/purchases')],
    ['m', 'Master', top('/master')],
    ['r', 'Reports', top('/reports')],
  ]
  return all.filter((x): x is [string, string, string] => !!x[2]).map(([letter, label, href]) => ({ letter, label, href }))
}
