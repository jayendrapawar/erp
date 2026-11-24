import { NextResponse } from 'next/server'
import { AuthError, getSessionUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { db, withDbRetry } from '@/lib/db'
import { listOutstanding, listPayments, partyStatement, type OutstandingSort } from '@/lib/payments/queries'
import { listOpenings } from '@/lib/payments/opening'

// GET /api/payments?view=outstanding&q=&sort=&overdue=1&offset=
//     /api/payments?view=statement&party=V12&from=2026-04-01&to=2026-11-24
//     /api/payments?view=payments&q=
//     /api/payments?view=openings&q=
// The Payments screens' reads (payments step 5): one query each. A GET route so the browser runs
// them in parallel (server actions run one at a time). payments.view only. Never cached: money moves.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams
  const view = p.get('view')
  try {
    const u = await getSessionUser()
    if (!u) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(u.roles, 'payments.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    let data: unknown
    if (view === 'outstanding') {
      data = await withDbRetry(() => listOutstanding(db, {
        q: p.get('q') ?? '', sort: (p.get('sort') ?? 'balance') as OutstandingSort, overdueOnly: p.get('overdue') === '1', offset: Number(p.get('offset') ?? 0),
      }))
    } else if (view === 'statement') {
      const party = p.get('party') ?? ''
      data = await withDbRetry(() => partyStatement(db, party, p.get('from') ?? '', p.get('to') ?? ''))
      if (!data) return NextResponse.json({ error: 'Party not found' }, { status: 404 })
    } else if (view === 'openings') {
      data = await withDbRetry(() => listOpenings(db, p.get('q') ?? ''))
    } else if (view === 'payments') {
      data = await withDbRetry(() => listPayments(db, { q: p.get('q') ?? '' }))
    } else {
      return NextResponse.json({ error: 'Unknown view' }, { status: 400 })
    }
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    const msg = err instanceof Error ? err.message : ''
    if (/Choose the dates|is after/.test(msg)) return NextResponse.json({ error: msg }, { status: 400 })
    console.error('[/api/payments]', view, err)
    return NextResponse.json({ error: 'Could not load' }, { status: 500 })
  }
}
