'use client'

import { useRouter } from 'next/navigation'
import { ScanBarcode, ShoppingCart, Receipt, Package, BookOpen, BarChart2, Boxes } from 'lucide-react'
import { hasPermission, parseRoles, type Permission } from '@/lib/permissions'
import { PageNav } from '@/components/page-nav'

interface MenuItem {
  label: string
  description: string
  href: string
  icon: React.ElementType
  color: string
  border: string
  badge?: string
  /** Shown when the user holds this permission (lib/permissions.ts). */
  permission: Permission
}

const MENU_ITEMS: MenuItem[] = [
  {
    label: 'Scanner',
    description: 'Scan warehouse inventory items',
    href: '/scanner',
    icon: ScanBarcode,
    color: 'bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
    permission: 'scan.record',
  },
  {
    label: 'Inventory',
    description: 'Stock on hand, value and movements',
    href: '/inventory',
    icon: Boxes,
    color: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400',
    border: 'border-indigo-200 dark:border-indigo-800',
    permission: 'inventory.view.all',
  },
  {
    label: 'Orders',
    description: 'Manage sales, packing & dispatch',
    href: '/orders',
    icon: ShoppingCart,
    color: 'bg-green-50 text-green-600 dark:bg-green-950 dark:text-green-400',
    border: 'border-green-200 dark:border-green-800',
    badge: 'New',
    permission: 'orders.view',
  },
  {
    label: 'Billing',
    description: 'Coming soon',
    href: '#',
    icon: Receipt,
    color: 'bg-purple-50 text-purple-600 dark:bg-purple-950 dark:text-purple-400',
    border: 'border-purple-200 dark:border-purple-800',
    permission: 'users.view',
  },
  {
    label: 'Purchases',
    description: 'Track stock purchases and suppliers',
    href: '/purchases',
    icon: Package,
    color: 'bg-orange-50 text-orange-600 dark:bg-orange-950 dark:text-orange-400',
    border: 'border-orange-200 dark:border-orange-800',
    permission: 'suppliers.view',
  },
  {
    label: 'Master',
    description: 'Manage products, categories and suppliers',
    href: '/master',
    icon: BookOpen,
    color: 'bg-teal-50 text-teal-600 dark:bg-teal-950 dark:text-teal-400',
    border: 'border-teal-200 dark:border-teal-800',
    permission: 'users.view',
  },
  {
    label: 'Reports',
    description: 'Inventory analytics and business reports',
    href: '/reports',
    icon: BarChart2,
    color: 'bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-400',
    border: 'border-rose-200 dark:border-rose-800',
    permission: 'users.view',
  },
]

export function HomeMenuPage({ role }: { role: string }) {
  const router = useRouter()
  const userRoles = parseRoles(role)
  const visible = MENU_ITEMS.filter(item => hasPermission(userRoles, item.permission))

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-12">
      {/* Top-right nav */}
      <div className="fixed top-4 right-4 z-50">
        <PageNav hideHome />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Shayona Inventory</h1>
          <p className="mt-1 text-sm text-muted-foreground">Select a module to get started</p>
        </div>

        {visible.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            Your account is signed in but has no role yet. Ask an admin to assign your role in Master → Users.
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          {visible.map(({ label, description, href, icon: Icon, color, border, badge }) => {
            const disabled = href === '#'
            return (
              <button
                key={label}
                onClick={() => { if (!disabled) router.push(href) }}
                disabled={disabled}
                className={`relative flex flex-col items-center gap-3 rounded-2xl border ${border} bg-card p-6 text-center shadow-sm transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  disabled ? 'opacity-60 cursor-not-allowed' : 'hover:shadow-md active:scale-95'
                }`}
              >
                {badge && (
                  <span className="absolute top-2.5 right-2.5 rounded-full bg-green-500 px-1.5 py-0.5 text-[10px] font-semibold text-white leading-none">
                    {badge}
                  </span>
                )}
                {disabled && (
                  <span className="absolute top-2.5 right-2.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground leading-none">
                    Soon
                  </span>
                )}
                <span className={`flex h-14 w-14 items-center justify-center rounded-xl ${color}`}>
                  <Icon className="h-7 w-7" />
                </span>
                <span className="font-semibold text-foreground text-sm">{label}</span>
                <span className="text-xs text-muted-foreground leading-snug">{description}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
