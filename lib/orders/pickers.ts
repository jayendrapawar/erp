// Who can be named as the picker of an order: users with the picker role, and admins (admins pick
// too). Server only. Used by the picker lists and by Direct bills, which must say who picked the
// goods (owner, 23 Nov 2026).

import { and, eq, or, sql } from 'drizzle-orm'
import { user } from '@/lib/db/schema'
import type { DbOrTx } from '@/lib/db/types'

const hasRole = (role: string) => sql`${role} = ANY (string_to_array(replace(coalesce(${user.role}, ''), ' ', ''), ','))`
const CAN_PICK = or(hasRole('picker'), hasRole('admin'))

/** Pickers and admins, by name. 1 query. */
export async function listPickerChoices(db: DbOrTx): Promise<{ id: string; name: string | null }[]> {
  return db.select({ id: user.id, name: user.name }).from(user).where(CAN_PICK).orderBy(user.name)
}

/** Refuses unless `pickerId` is a picker or an admin. 1 query. */
export async function assertPickerChoice(db: DbOrTx, pickerId: unknown): Promise<string> {
  const id = typeof pickerId === 'string' ? pickerId.trim() : ''
  if (!id) throw new Error('Choose who picked the goods.')
  const [row] = await db.select({ id: user.id }).from(user).where(and(eq(user.id, id), CAN_PICK)).limit(1)
  if (!row) throw new Error('That person is not a picker. Reload and choose again.')
  return row.id
}
