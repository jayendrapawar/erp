import { cache } from 'react'
import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { hasPermission, parseRoles, type Permission, type Role } from '@/lib/permissions'

export class AuthError extends Error {
  constructor(public readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN', message?: string) {
    super(message ?? (code === 'UNAUTHENTICATED' ? 'Unauthorized' : 'Forbidden'))
    this.name = 'AuthError'
  }
}

export interface SessionUser {
  id: string
  name: string
  email: string
  roles: Role[]
}

/**
 * Resolve the signed-in user and their roles once per request.
 * Roles are read from the database (not the session cookie) so a role change
 * takes effect on the very next request.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  const [row] = await db
    .select({ role: user.role, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1)
  if (!row) return null
  return {
    id: session.user.id,
    name: row.name ?? session.user.name ?? '',
    email: row.email,
    roles: parseRoles(row.role),
  }
})

export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser()
  if (!u) throw new AuthError('UNAUTHENTICATED')
  return u
}

/** Throws unless the signed-in user holds the permission. */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const u = await requireUser()
  if (!hasPermission(u.roles, permission)) throw new AuthError('FORBIDDEN')
  return u
}

/** Throws unless the signed-in user holds at least one of the roles. */
export async function requireAnyRole(...roles: Role[]): Promise<SessionUser> {
  const u = await requireUser()
  if (!roles.some((r) => u.roles.includes(r))) throw new AuthError('FORBIDDEN')
  return u
}

export async function can(permission: Permission): Promise<boolean> {
  const u = await getSessionUser()
  return Boolean(u && hasPermission(u.roles, permission))
}
