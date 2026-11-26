import { NextResponse, type NextRequest } from 'next/server'
import { db, withDbRetry } from '@/lib/db'
import { AuthError, requirePermission } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { scannerScan, type ScanReply } from '@/lib/inventory/scanner-scan'
import { ensureOpenStocktake } from '@/lib/inventory/stocktake-sessions'
import { parseQr } from '@/lib/qr/parser'

// POST /api/scanner/scan — one box or carton label from the Warehouse Scanner
// (lib/inventory/scanner-scan.ts). A route, not a server action: Next.js sends server actions one
// at a time per page, and a scanner machine reads faster than that. Session check + one transaction
// (~7–9 statements) + one read for the names. Never cached.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return reply({ kind: 'rejected', message: 'Bad request.' }, 400) }
  const raw = typeof body.raw === 'string' ? body.raw.slice(0, 500) : ''
  const clientEventId = typeof body.clientEventId === 'string' ? body.clientEventId : ''
  const flag = typeof body.flag === 'string' && body.flag.trim() ? body.flag.trim().slice(0, 50) : null
  if (!raw.trim() || !UUID_RE.test(clientEventId)) return reply({ kind: 'rejected', message: 'Bad request.' }, 400)
  try {
    const u = await requirePermission('scan.record')
    const ask = body.saveUnknown !== true && hasPermission(u.roles, 'articles.create_from_scan')
    // Safe to retry: the clientEventId makes the save idempotent.
    const actor = { id: u.id, name: u.name }
    // A live scan always goes into the OPEN stocktake (one indexed lookup), started by this scan when
    // none is open — even if this phone has not heard yet that the last one was finished. A carton
    // label only reads, so it starts nothing. (Scans kept offline keep theirs: the sync action.)
    const session = parseQr(raw).kind === 'carton' ? null : (await withDbRetry(() => ensureOpenStocktake(db, actor))).id
    const out = await withDbRetry(() => scannerScan(db, actor, {
      raw, clientEventId, flag, sessionId: session, deviceAt: typeof body.deviceAt === 'string' ? body.deviceAt : null, askIfUnknown: ask,
    }))
    return reply({ ...out, sessionId: session })
  } catch (e) {
    if (e instanceof AuthError) return reply({ kind: 'rejected', message: 'Your account is not allowed to record scans. Sign in again if this is wrong.' }, e.message === 'UNAUTHENTICATED' ? 401 : 403)
    console.error('scanner scan failed', e)
    return NextResponse.json({ kind: 'error', message: 'The scan could not be saved. It will be kept on this phone and sent again.' }, { status: 500, headers: NO_STORE })
  }
}

function reply(out: ScanReply & { sessionId?: number | null }, status = 200) {
  return NextResponse.json(out, { status, headers: NO_STORE })
}
