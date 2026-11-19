'use client'

import { useRouter } from 'next/navigation'
import { ScanBarcode, ShoppingCart, Package, BookOpen, BarChart2, Boxes } from 'lucide-react'
import { hasPermission, parseRoles, type Permission } from '@/lib/permissions'
import { PageNav } from '@/components/page-nav'
import { useLanguage } from '@/lib/language-context'
import type { TranslationKey } from '@/lib/translations'

interface MenuItem {
  label: TranslationKey
  description: TranslationKey
  href: string
  icon: React.ElementType
  color: string
  border: string
  badge?: TranslationKey
  /** Shown when the user holds this permission (lib/permissions.ts). */
  permission: Permission
}

const MENU_ITEMS: MenuItem[] = [
  {
    label: 'scanner',
    description: 'descScanner',
    href: '/scanner',
    icon: ScanBarcode,
    color: 'bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
    permission: 'scan.record',
  },
  {
    label: 'navInventory',
    description: 'descInventory',
    href: '/inventory',
    icon: Boxes,
    color: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400',
    border: 'border-indigo-200 dark:border-indigo-800',
    permission: 'inventory.view.all',
  },
  {
    label: 'navOrders',
    description: 'descOrders',
    href: '/orders',
    icon: ShoppingCart,
    color: 'bg-green-50 text-green-600 dark:bg-green-950 dark:text-green-400',
    border: 'border-green-200 dark:border-green-800',
    permission: 'orders.view',
  },
  {
    label: 'navPurchases',
    description: 'descPurchases',
    href: '/purchases',
    icon: Package,
    color: 'bg-orange-50 text-orange-600 dark:bg-orange-950 dark:text-orange-400',
    border: 'border-orange-200 dark:border-orange-800',
    permission: 'purchases.view',
  },
  {
    label: 'navMaster',
    description: 'descMaster',
    href: '/master',
    icon: BookOpen,
    color: 'bg-teal-50 text-teal-600 dark:bg-teal-950 dark:text-teal-400',
    border: 'border-teal-200 dark:border-teal-800',
    permission: 'users.view',
  },
  {
    label: 'navReports',
    description: 'descReports',
    href: '/reports',
    icon: BarChart2,
    color: 'bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-400',
    border: 'border-rose-200 dark:border-rose-800',
    permission: 'users.view',
  },
]

export function HomeMenuPage({ role }: { role: string }) {
  const router = useRouter()
  const { t } = useLanguage()
  const userRoles = parseRoles(role)
  const visible = MENU_ITEMS.filter(item => hasPermission(userRoles, item.permission))

  const rows = Math.max(1, Math.ceil(visible.length / 2))

  // One screen on every phone: exactly the visible height (100dvh excludes the browser bars), no scrolling.
  // Title and profile share the top row; the tiles share the rest of the height.
  return (
    <div className="flex h-[100dvh] flex-col overflow-y-auto bg-background px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <header className="mx-auto flex w-full max-w-md shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl">{t('appName')}</h1>
          <p className="truncate text-xs text-muted-foreground sm:text-sm">{t('homeSubtitle')}</p>
        </div>
        <PageNav hideHome />
      </header>

      {visible.length === 0 ? (
        <div className="mx-auto mt-6 w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {t('homeNoRole')}
        </div>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 items-center py-4">
          <div
            className="grid h-full w-full grid-cols-2 gap-3"
            style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, maxHeight: `${rows * 200}px` }}
          >
            {visible.map(({ label, description, href, icon: Icon, color, border, badge }) => {
              const disabled = href === '#'
              return (
                <button
                  key={label}
                  onClick={() => { if (!disabled) router.push(href) }}
                  disabled={disabled}
                  className={`relative flex min-h-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border ${border} bg-card p-3 text-center shadow-sm transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    disabled ? 'opacity-60 cursor-not-allowed' : 'hover:shadow-md active:scale-95'
                  }`}
                >
                  {badge && (
                    <span className="absolute top-2.5 right-2.5 rounded-full bg-green-500 px-1.5 py-0.5 text-[10px] font-semibold text-white leading-none">
                      {t(badge)}
                    </span>
                  )}
                  {disabled && (
                    <span className="absolute top-2.5 right-2.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground leading-none">
                      {t('badgeSoon')}
                    </span>
                  )}
                  <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl [@media(max-height:600px)]:h-10 [@media(max-height:600px)]:w-10 ${color}`}>
                    <Icon className="h-6 w-6" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">{t(label)}</span>
                  {/* Short phones: the name alone keeps every tile on screen. */}
                  <span className="line-clamp-2 text-xs leading-snug text-muted-foreground [@media(max-height:640px)]:hidden">{t(description)}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
