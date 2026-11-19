// App modules for navigation (bottom bar on phones, "More" sheet). Pure: safe on server and client.
import type { Permission } from '@/lib/permissions'
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
