// Ctrl+K "# " record search (docs/architecture/keyboard.md): what each role may find and where a
// found record opens. Pure: shared by app/api/search/route.ts and tests.

import { hasPermission, type Role } from '@/lib/permissions'

export type RecordKind = 'order' | 'retailer' | 'article'

export interface RecordHit {
  kind: RecordKind
  id: string
  title: string
  sub: string
  href: string
}

/** Raw row from the search query. */
export interface RecordRow {
  kind: RecordKind
  id: string
  title: string
  sub: string | null
  status: string | null
  salesman_id: string | null
}

export const MIN_QUERY = 2
export const MAX_QUERY = 60
export const PER_KIND = 10

/** "%" and "_" typed by the user are searched as themselves. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Normalise the typed text: trimmed, inner spaces collapsed, at most 60 characters. null = too short. */
export function cleanQuery(raw: string | null | undefined): string | null {
  const q = (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY)
  return q.length >= MIN_QUERY ? q : null
}

const isHub = (roles: readonly Role[]) => roles.includes('admin') || roles.includes('accountant')

/** Which orders a user may find: the same as their own order screens. */
export function orderScope(roles: readonly Role[]): { all: true } | { salesman: boolean; statuses: string[] } | null {
  if (!hasPermission(roles, 'orders.view')) return null
  if (isHub(roles)) return { all: true }
  const statuses = new Set<string>()
  if (roles.includes('picker')) ['pending', 'assigned'].forEach((s) => statuses.add(s))
  if (roles.includes('biller')) ['packed', 'billed'].forEach((s) => statuses.add(s))
  if (roles.includes('dispatcher')) ['billed', 'dispatched'].forEach((s) => statuses.add(s))
  return { salesman: roles.includes('salesman'), statuses: [...statuses] }
}

/** Retailers: Master → Retailers for admin / accountant; salesmen start an order. Others: not listed. */
export function canFindRetailers(roles: readonly Role[]): boolean {
  return hasPermission(roles, 'users.view') || roles.includes('salesman')
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

/** Where a found record opens. Lists read "f.<column>" from the address into their filter. */
export function recordHref(row: RecordRow, roles: readonly Role[], userId: string): string {
  if (row.kind === 'article') return `/inventory?${q({ 'f.code': row.title })}#stock`
  if (row.kind === 'retailer') {
    return hasPermission(roles, 'users.view') ? `/master?${q({ 'f.name': row.title })}#vendors` : `/orders?${q({ 'f.shop': row.title })}#salesman`
  }
  // order
  if (isHub(roles)) return `/orders/admin?${q({ 'f.order': row.title })}#overview`
  const s = row.status ?? ''
  const tab = row.salesman_id === userId && roles.includes('salesman') ? 'salesman'
    : roles.includes('picker') && ['pending', 'assigned'].includes(s) ? 'picker'
    : roles.includes('biller') && ['packed', 'billed'].includes(s) ? 'biller'
    : roles.includes('dispatcher') && ['billed', 'dispatched'].includes(s) ? 'dispatcher'
    : 'salesman'
  return `/orders?${q({ 'f.order': row.title })}#${tab}`
}

export function toHit(row: RecordRow, roles: readonly Role[], userId: string): RecordHit {
  const sub = row.kind === 'order' ? [row.sub, row.status].filter(Boolean).join(' · ') : row.sub ?? ''
  return { kind: row.kind, id: row.id, title: row.title, sub, href: recordHref(row, roles, userId) }
}
