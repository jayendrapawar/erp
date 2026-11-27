// App settings changed on screen by an admin (table app_settings, migration 0009). Server only.

import { sql } from 'drizzle-orm'
import type { Actor, Db, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'

export const SETTING_BILL_MAIL_START = 'billMail.startDate'

export interface SettingRow<T> { value: T; updatedByName: string; updatedAt: string }

/** One query. */
export async function getSetting<T>(db: DbOrTx, key: string): Promise<SettingRow<T> | null> {
  const r = await db.execute<{ value: T; updatedByName: string; updatedAt: string }>(sql`
    SELECT value, "updatedByName", "updatedAt" FROM app_settings WHERE key = ${key}`)
  const x = r.rows[0]
  return x ? { value: x.value, updatedByName: x.updatedByName, updatedAt: new Date(x.updatedAt).toISOString() } : null
}

/** Set (or with null, remove) a setting. One transaction: read, write, audit. */
export async function setSetting(db: Db, actor: Actor, key: string, value: unknown | null, reason?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await getSetting(tx, key)
    if (value === null) await tx.execute(sql`DELETE FROM app_settings WHERE key = ${key}`)
    else {
      await tx.execute(sql`
        INSERT INTO app_settings (key, value, "updatedBy", "updatedByName", "updatedAt")
        VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${actor.id}, ${actor.name}, now())
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedBy" = excluded."updatedBy", "updatedByName" = excluded."updatedByName", "updatedAt" = now()`)
    }
    await audit(tx, { actor, action: 'setting.changed', entityType: 'app_setting', entityId: key, before: before?.value ?? null, after: value, reason: reason ?? null })
  })
}
