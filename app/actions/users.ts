'use server'

import { eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { getSessionUser, requirePermission, requireUser } from '@/lib/authz'
import { audit } from '@/lib/audit'
import { listPickerChoices } from '@/lib/orders/pickers'
import { ROLES, serializeRoles, type Role } from '@/lib/permissions'

/** 'user' = signed in but not yet given a role: no access to any module. */
export type AppRole = Role | 'user'

const hasRole = (role: string) => sql`${role} = ANY (string_to_array(replace(coalesce(${user.role}, ''), ' ', ''), ','))`

export async function getAllUsers() {
  await requirePermission('users.view')
  return db
    .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
    .from(user)
    .orderBy(user.createdAt)
}

export async function getUsersByRole(role: AppRole) {
  await requirePermission('users.view')
  return db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(hasRole(role))
}

/** Only admins assign roles. Unknown role names are dropped; no role at all becomes 'user'. */
export async function updateUserRole(userId: string, role: string) {
  const actor = await requirePermission('users.manage')
  const next = serializeRoles(role.split(','))
  if (userId === actor.id && !next.split(',').includes('admin')) {
    throw new Error('You cannot remove your own admin role.')
  }
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ role: user.role }).from(user).where(eq(user.id, userId)).for('update')
    if (!before) throw new Error('User not found.')
    await tx.update(user).set({ role: next, updatedAt: new Date() }).where(eq(user.id, userId))
    await audit(tx, { actor: { id: actor.id, name: actor.name }, action: 'user.roles_changed', entityType: 'user', entityId: userId, before, after: { role: next } })
  })
  revalidatePath('/master')
  revalidatePath('/orders/admin')
}

/** Who can be named as an order's picker: pickers and admins (lib/orders/pickers.ts). */
export async function getPickersList() {
  await requireUser()
  return listPickerChoices(db)
}

export async function getCurrentUserRole(): Promise<string> {
  const u = await getSessionUser()
  return u && u.roles.length ? u.roles.join(',') : 'user'
}

export async function getAssignableRoles(): Promise<readonly Role[]> {
  await requirePermission('users.manage')
  return ROLES
}
