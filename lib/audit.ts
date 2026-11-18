import { auditEvents } from '@/lib/db/schema'
import type { Actor, DbOrTx } from '@/lib/db/types'

export interface AuditEntry {
  actor: Actor | null
  action: string
  entityType: string
  entityId: string | number
  before?: unknown
  after?: unknown
  reason?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Record a business action. Call it with the same transaction as the change it
 * describes, so the change and its audit row commit or roll back together.
 */
export async function audit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: e.actor?.id ?? null,
    actorName: e.actor?.name ?? 'system',
    action: e.action,
    entityType: e.entityType,
    entityId: String(e.entityId),
    before: e.before === undefined ? null : (e.before as object),
    after: e.after === undefined ? null : (e.after as object),
    reason: e.reason ?? null,
    metadata: e.metadata ?? null,
  })
}
