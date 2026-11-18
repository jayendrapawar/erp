// App modules for navigation (bottom bar on phones, "More" sheet). Pure: safe on server and client.
import type { Permission } from '@/lib/permissions'

export type NavIcon = 'home' | 'scanner' | 'inventory' | 'orders' | 'purchases' | 'master' | 'reports'

export interface NavItem { href: string; label: string; icon: NavIcon; permission: Permission | null }

/** In priority order: the first ones a role may open go in the bottom bar, the rest in "More". */
export const NAV_ITEMS: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'home', permission: null },
  { href: '/scanner', label: 'Scanner', icon: 'scanner', permission: 'scan.record' },
  { href: '/orders', label: 'Orders', icon: 'orders', permission: 'orders.view' },
  { href: '/inventory', label: 'Inventory', icon: 'inventory', permission: 'inventory.view.all' },
  { href: '/purchases', label: 'Purchases', icon: 'purchases', permission: 'purchases.view' },
  { href: '/master', label: 'Master', icon: 'master', permission: 'users.view' },
  { href: '/reports', label: 'Reports', icon: 'reports', permission: 'users.view' },
]

/** Bottom bar slots before "More". */
export const BAR_SLOTS = 4
