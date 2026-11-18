// Role and permission map shared by server actions, pages and client UI.
// Pure module: no server imports, safe to use in client components.

export const ROLES = [
  'admin',
  'supervisor',
  'accountant',
  'warehouse',
  'salesman',
  'picker',
  'biller',
  'dispatcher',
] as const

export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  supervisor: 'Supervisor',
  accountant: 'Accountant',
  warehouse: 'Warehouse helper',
  salesman: 'Salesman',
  picker: 'Picker',
  biller: 'Biller',
  dispatcher: 'Dispatcher',
}

const STAFF: Role[] = [...ROLES]
const SCANNING: Role[] = ['admin', 'supervisor', 'warehouse', 'accountant', 'salesman', 'picker', 'biller', 'dispatcher']

/**
 * Permission → roles allowed. A user without any listed role (including the
 * placeholder "user" role given at first sign-in) has no access at all.
 */
export const PERMISSIONS = {
  'scan.record': SCANNING,
  'scan.void.own': SCANNING,
  'scan.void.any': ['admin', 'supervisor'],
  'inventory.view': STAFF,
  'inventory.view.all': STAFF, // stock levels were visible to every staff member before; kept

  'inventory.export': ['admin', 'supervisor', 'accountant'],
  'inventory.adjust': ['admin', 'supervisor'],
  'articles.view': STAFF,
  'articles.edit': ['admin', 'accountant'],
  'articles.delete': ['admin'],
  'articles.create_from_scan': ['admin'],
  'articles.review_missing': ['admin'],
  'articles.review_catalog': ['admin'],
  'retailers.view': STAFF,
  'retailers.edit': ['admin', 'accountant'],
  'suppliers.view': ['admin', 'supervisor', 'accountant'],
  'suppliers.edit': ['admin', 'accountant'],
  'sets.view': STAFF,
  'orders.view': ['admin', 'accountant', 'salesman', 'picker', 'biller', 'dispatcher'],
  'sets.edit': ['admin'],
  'users.view': ['admin', 'accountant'],
  'users.manage': ['admin'],
  'flags.create': SCANNING,
  'audit.view': ['admin'],
} as const satisfies Record<string, readonly Role[]>

export type Permission = keyof typeof PERMISSIONS

/** Parse the comma-separated role column into known roles only. */
export function parseRoles(raw: string | null | undefined): Role[] {
  if (!raw) return []
  const known = new Set<string>(ROLES)
  const out: Role[] = []
  for (const part of raw.split(',')) {
    const r = part.trim().toLowerCase()
    if (known.has(r) && !out.includes(r as Role)) out.push(r as Role)
  }
  return out
}

export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  const allowed = PERMISSIONS[permission] as readonly Role[]
  return roles.some((r) => allowed.includes(r))
}

/** Serialize roles back to the stored column format. Empty → 'user' (no access). */
export function serializeRoles(roles: readonly string[]): string {
  const valid = parseRoles(roles.join(','))
  return valid.length ? valid.join(',') : 'user'
}
