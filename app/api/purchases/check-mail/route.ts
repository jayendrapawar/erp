import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AuthError, requirePermission } from '@/lib/authz'
import { audit } from '@/lib/audit'
import { checkBillMail } from '@/lib/purchases/mail'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST /api/purchases/check-mail  { since?: "yyyy-mm-dd" }
// Reads new Relaxo bill mails and imports their PDFs (lib/purchases/mail.ts). On demand only.
export async function POST(req: Request) {
  try {
    const u = await requirePermission('purchases.upload')
    const body = await req.json().catch(() => ({})) as { since?: string }
    const actor = { id: u.id, name: u.name }
    const result = await checkBillMail(db, actor, { since: body.since })
    await audit(db, { actor, action: 'purchase_bill.mail_checked', entityType: 'mailbox', entityId: 'bills', after: { since: result.since, found: result.found, processed: result.processed, saved: result.files.filter((f) => f.status === 'saved').length } })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    console.error('[/api/purchases/check-mail]', err)
    const msg = err instanceof Error && /mailbox|not set up|switched off/.test(err.message) ? err.message : 'Checking mail failed. Try again.'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
