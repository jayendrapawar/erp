'use client'

import { useState, useTransition, useEffect, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { RolePill, fmt, PageHeader } from '../orders/_components/shared'
import { updateUserRole } from '@/app/actions/users'
import type { AppRole } from '@/app/actions/users'
import { VendorsTab } from './vendors-tab'
import type { Vendor } from './vendors-tab'
import { ArticlesTab } from './articles-tab'
import type { Article } from './articles-tab'
import type { CatalogReviewItem } from '@/app/actions/articles'
import type { MissingArticle } from '@/lib/catalog/missing-articles'
import { SetsTab } from './sets-tab'
import { BillTemplateTab } from './bill-template-tab'
import { BanksTab } from '@/components/master/banks-tab'
import { SuppliersTab } from './suppliers-tab'
import { AssortmentsTab } from './assortments-tab'
import type { Assortment } from '@/lib/catalog/assortment-store'
import type { Supplier } from '@/app/actions/suppliers'
import { ROLE_LABELS, ROLES as ALL_ROLES } from '@/lib/permissions'
import type { OrderSet } from './sets-tab'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { PageNav } from '@/components/page-nav'
import { useListKeys } from '@/lib/shortcuts/list'
import { useTabKeys } from '@/lib/shortcuts/tabs'
import { applyColumnFilters, FilterRow, FiltersButton, FilterSummary, type ColumnFilterDef, type FilterValues } from '@/components/column-filters'

type UserRow = { id: string; name: string | null; email: string; role: string | null; createdAt: Date }
const USER_FILTERS: ColumnFilterDef<UserRow>[] = [
  { key: 'name', label: 'Name', kind: 'text', get: u => u.name },
  { key: 'email', label: 'Email', kind: 'text', get: u => u.email },
  { key: 'role', label: 'Current role', kind: 'text', placeholder: 'e.g. biller', get: u => (u.role ?? '').split(',').map(r => `${r} ${(ROLE_LABELS as Record<string, string>)[r] ?? ''}`).join(' ') },
  { key: 'joined', label: 'Joined', kind: 'text', placeholder: 'e.g. Nov', get: u => fmt(u.createdAt) },
]

interface RoleSelectorProps {
  userId: string
  currentRoles: string | null | undefined
  onChange: (userId: string, newRoles: string) => void
  disabled?: boolean
}

function RoleSelector({ userId, currentRoles, onChange, disabled }: RoleSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const activeRoles = (currentRoles ?? 'user')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // The menu is rendered in a portal with fixed positioning, so close it when the page moves underneath it.
  useEffect(() => {
    if (!isOpen) return
    function close(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return
      setIsOpen(false)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [isOpen])

  function handleButtonClick() {
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      const menuHeight = 230
      const gap = 4
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      const openUpward = spaceBelow < menuHeight + gap && spaceAbove > spaceBelow
      const available = Math.max(openUpward ? spaceAbove : spaceBelow, 120) - gap * 2
      setMenuStyle({
        position: 'fixed',
        left: rect.left,
        width: Math.max(rect.width, 192),
        maxHeight: available,
        ...(openUpward
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
      })
    }
    setIsOpen(!isOpen)
  }

  // Keyboard: Enter / Space open the menu (arrows move between buttons). The menu is in a portal at
  // the end of the page, so focus moves into it when it opens;
  // ↑↓ move between roles, Space ticks, Esc / Tab close it and return to the button.
  useEffect(() => {
    if (!isOpen) return
    const t = setTimeout(() => menuRef.current?.querySelector<HTMLInputElement>('input')?.focus(), 0)
    return () => clearTimeout(t)
  }, [isOpen])
  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const boxes = [...(menuRef.current?.querySelectorAll<HTMLInputElement>('input') ?? [])]
    const at = boxes.indexOf(document.activeElement as HTMLInputElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      boxes[(Math.max(0, at) + (e.key === 'ArrowDown' ? 1 : -1) + boxes.length) % boxes.length]?.focus()
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      setIsOpen(false)
      buttonRef.current?.focus()
    }
  }

  function handleToggleRole(role: string) {
    let newRoles: string[]
    if (role === 'admin') {
      const isAdminChecked = activeRoles.includes('admin')
      if (isAdminChecked) {
        // Unchecking admin: clear everything and fallback to 'user'
        newRoles = ['user']
      } else {
        // Checking admin: select all roles
        newRoles = ['admin', 'accountant', 'salesman', 'picker', 'dispatcher']
      }
    } else if (role === 'user') {
      newRoles = ['user']
    } else {
      const filtered = activeRoles.filter(r => r !== 'user')
      if (filtered.includes(role)) {
        newRoles = filtered.filter(r => r !== role)
      } else {
        newRoles = [...filtered, role]
      }
      
      // If we unchecked any of the other roles, also uncheck 'admin' if it was checked
      if (activeRoles.includes('admin')) {
        newRoles = newRoles.filter(r => r !== 'admin')
      }
      
      if (newRoles.length === 0) {
        newRoles = ['user']
      }
    }
    onChange(userId, newRoles.join(','))
  }

  const displayText = activeRoles.length > 0
    ? activeRoles.map(r => r.charAt(0).toUpperCase() + r.slice(1)).join(', ')
    : 'No Role'

  return (
    <div className="relative inline-block text-left w-full sm:w-auto" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={handleButtonClick}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={`Roles: ${displayText}`}
        data-row-open
        className="inline-flex justify-between items-center w-full sm:w-48 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      >
        <span className="truncate">{displayText}</span>
        <svg className="ml-2 h-3.5 w-3.5 text-muted-foreground flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && createPortal(
        <div
          ref={menuRef}
          style={menuStyle}
          role="group"
          aria-label="Roles"
          onKeyDown={onMenuKey}
          className="overflow-y-auto rounded-md shadow-lg bg-popover border border-border z-50 p-2 space-y-1"
        >
          {[...ALL_ROLES, 'user'].map(r => {
            const isChecked = activeRoles.includes(r)
            return (
              <label
                key={r}
                className="flex items-center gap-2 px-2 py-1.5 text-xs text-foreground hover:bg-muted rounded cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={isChecked}
                  onChange={() => handleToggleRole(r)}
                  className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                />
                <span>{r === 'user' ? 'No role (no access)' : ROLE_LABELS[r as keyof typeof ROLE_LABELS]}</span>
              </label>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}
interface Props {
  users: { id: string; name: string | null; email: string; role: string | null; createdAt: Date }[]
  currentUserId: string
  vendors: Vendor[]
  articles: Article[]
  missingArticles: MissingArticle[]
  catalogReviewItems: CatalogReviewItem[]
  sets: OrderSet[]
  suppliers: Supplier[]
  assortments: Assortment[]
  /** When true, only Vendors and Articles tabs are shown (hides Users tab) — used for accountant role */
  isAccountant?: boolean
}

const ROLES: AppRole[] = [...ALL_ROLES, 'user']
/** Section names for the page title (computers hide the tab row; the sidebar lists the sections). */
const MASTER_TAB_LABEL: Record<string, string> = { users: 'Users', vendors: 'Retailers', suppliers: 'Suppliers', articles: 'Articles', assortments: 'Assortments', sets: 'Sets', bill: 'Bill template', banks: 'Banks' }

export function MasterDashboard({ users, currentUserId, vendors: initialVendors, articles: initialArticles, missingArticles, catalogReviewItems, sets: initialSets, suppliers, assortments, isAccountant = false }: Props) {
  const [isPending, startTransition] = useTransition()
  const [userFilters, setUserFilters] = useState<FilterValues>({})
  const [vendorList, setVendorList] = useState<Vendor[]>(initialVendors)
  const [articleList, setArticleList] = useState<Article[]>(initialArticles)
  const [setList, setSetList] = useState<OrderSet[]>(initialSets)

  const filteredUsers = applyColumnFilters(users, USER_FILTERS, userFilters)

  function handleRoleChange(userId: string, role: string) {
    startTransition(async () => {
      await updateUserRole(userId, role as AppRole)
    })
  }

  const defaultTab = isAccountant ? 'vendors' : 'users'
  // Tab from the address (#articles) so the sidebar can open it; switching tabs updates the address.
  const tabIds = isAccountant ? ['vendors', 'suppliers', 'articles', 'assortments', 'banks'] : ['users', 'vendors', 'suppliers', 'articles', 'assortments', 'sets', 'bill', 'banks']
  const [tab, setTab] = useState(defaultTab)
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.replace('#', '')
      if (tabIds.includes(h)) setTab(h)
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [isAccountant])
  function changeTab(v: string) {
    setTab(v)
    window.history.replaceState(null, '', `#${v}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
  // Keyboard: Alt+1…7 switch tabs; ↑↓ / j k on the users list (lib/shortcuts).
  useTabKeys(tabIds.map(t => ({ value: t, label: MASTER_TAB_LABEL[t] ?? t })), changeTab, { group: 'Master tabs' })
  const usersListRef = useRef<HTMLDivElement>(null)
  useListKeys(usersListRef, { label: 'Users list' })
  // Admin tab count — sets tab shown only for admin
  const isAdmin = !isAccountant

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <PageHeader title={MASTER_TAB_LABEL[tab] ? `Master · ${MASTER_TAB_LABEL[tab]}` : 'Master'} subtitle={isAccountant ? 'Retailers, suppliers & articles' : 'Users, retailers, suppliers, articles & sets'} />
          <PageNav />
        </div>

        {/* People per role — only with the Users section (redesign, 21 Nov 2026); hidden for accountants */}
        {!isAccountant && tab === 'users' && (
        <div className="flex flex-wrap gap-2 mb-4">
          {ROLES.map(r => {
            const count = users.filter(u => {
              const roles = (u.role ?? 'user').split(',').map(x => x.trim())
              return roles.includes(r)
            }).length
            return (
              <div key={r} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
                <span className="text-xs font-medium capitalize text-muted-foreground">{r}</span>
                <span className="text-sm font-bold tabular-nums text-foreground">{count}</span>
              </div>
            )
          })}
        </div>
        )}

        {/* Tabs — pill style matching scanner / admin hub */}
        <Tabs value={tab} onValueChange={(v) => changeTab(String(v))} className="w-full">
          <TabsList
            className="flex w-full mb-4 sm:mb-6 md:hidden"
          >
            {!isAccountant && <TabsTrigger value="users"    className="text-xs sm:text-sm">Users ({users.length})</TabsTrigger>}
            <TabsTrigger value="vendors"  className="text-xs sm:text-sm">Retailers ({vendorList.length})</TabsTrigger>
            <TabsTrigger value="suppliers" className="text-xs sm:text-sm">Suppliers ({suppliers.length})</TabsTrigger>
            <TabsTrigger value="articles" className="text-xs sm:text-sm">Articles ({articleList.length})</TabsTrigger>
            <TabsTrigger value="assortments" className="text-xs sm:text-sm">Assortments ({assortments.length})</TabsTrigger>
            {isAdmin && <TabsTrigger value="sets" className="text-xs sm:text-sm">Sets ({setList.length})</TabsTrigger>}
            {isAdmin && <TabsTrigger value="bill" className="text-xs sm:text-sm">Bill template</TabsTrigger>}
            <TabsTrigger value="banks" className="text-xs sm:text-sm">Banks</TabsTrigger>
          </TabsList>

          {/* ── Users tab — hidden for accountant ── */}
          {!isAccountant && (
          <TabsContent value="users">
            <div ref={usersListRef}>
            <FiltersButton className="mb-4 sm:hidden" defs={USER_FILTERS} values={userFilters} onChange={setUserFilters} />
            <div className="mb-2 hidden sm:block"><FilterSummary values={userFilters} onChange={setUserFilters} shown={filteredUsers.length} total={users.length} /></div>

            {filteredUsers.length === 0 && (
              <p className="text-center py-8 text-sm text-muted-foreground">No users found</p>
            )}

            {/* ── Mobile: card list ── */}
            <div className="sm:hidden space-y-3">
              {filteredUsers.map(u => (
                <div key={u.id} data-list-row className="rounded-xl border border-border bg-card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm text-foreground">{u.name ?? '—'}</p>
                        {u.id === currentUserId && (
                          <span className="text-[10px] border-l-2 border-blue-400 pl-1.5 pr-1 py-px font-medium text-blue-500 dark:text-blue-400 tracking-wide">YOU</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 break-all">{u.email}</p>
                    </div>
                    <RolePill role={u.role} />
                  </div>
                  <p className="text-xs text-muted-foreground">Joined {fmt(u.createdAt)}</p>
                  <div className="pt-2 border-t border-border">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Assign Role</p>
                    <RoleSelector
                      userId={u.id}
                      currentRoles={u.role}
                      onChange={handleRoleChange}
                      disabled={isPending}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* ── Desktop: table ── */}
            <div className="hidden sm:block rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Email</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Current Role</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Joined</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Assign Role</th>
                    </tr>
                    <FilterRow columns={[...USER_FILTERS, null]} values={userFilters} onChange={setUserFilters} firstCellClass="px-4" cellClass="px-4" />
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredUsers.map(u => (
                      <tr key={u.id} data-list-row className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 font-medium">
                          {u.name ?? '—'}
                          {u.id === currentUserId && (
                            <span className="ml-2 text-[10px] border-l-2 border-blue-400 pl-1.5 pr-1 py-px font-medium text-blue-500 dark:text-blue-400 tracking-wide">YOU</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                        <td className="px-4 py-3"><RolePill role={u.role} /></td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{fmt(u.createdAt)}</td>
                        <td className="px-4 py-3">
                          <RoleSelector
                            userId={u.id}
                            currentRoles={u.role}
                            onChange={handleRoleChange}
                            disabled={isPending}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            </div>
          </TabsContent>
          )}

          {/* ── Vendors tab ── */}
          <TabsContent value="vendors">
            <VendorsTab initialVendors={vendorList} onListChange={setVendorList} />
          </TabsContent>

          {/* ── Articles tab ── */}
          <TabsContent value="suppliers">
            <SuppliersTab initialSuppliers={suppliers} />
          </TabsContent>

          <TabsContent value="articles">
            <ArticlesTab initialArticles={articleList} initialMissingArticles={missingArticles} initialReviewItems={catalogReviewItems} canReviewCatalog={!isAccountant} onListChange={setArticleList} />
          </TabsContent>

          <TabsContent value="assortments">
            <AssortmentsTab initialAssortments={assortments} canEdit />
          </TabsContent>

          {/* ── Sets tab (admin only) ── */}
          {isAdmin && (
            <TabsContent value="sets">
              <SetsTab initialSets={setList} onListChange={setSetList} />
            </TabsContent>
          )}

          {/* ── Banks (admin, accountant): banks money comes into, slip numbers ── */}
          <TabsContent value="banks">
            <BanksTab />
          </TabsContent>

          {/* ── Bill template (admin only): details printed on sale bills ── */}
          {isAdmin && (
            <TabsContent value="bill">
              <BillTemplateTab />
            </TabsContent>
          )}

        </Tabs>
      </div>
    </div>
  )
}
