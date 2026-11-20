import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'

/** Photos uploaded since the 1st of this month (audit rows stay after a photo is deleted). 1 query. */
export async function photoUploadsThisMonth(db: DbOrTx): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM audit_events
    WHERE action = 'article_photo.added' AND "occurredAt" >= date_trunc('month', now())`)
  return Number(r.rows[0]?.n ?? 0)
}
