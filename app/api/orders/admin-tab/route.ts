import { NextResponse } from 'next/server'
import { AuthError, getSessionUser } from '@/lib/authz'
import { withDbRetry } from '@/lib/db'
import { ADMIN_TABS, loadAdminTab, tabAllowed, type AdminTab } from '@/app/orders/admin/tab-data'

// GET /api/orders/admin-tab?tab=picker
// One tab of the admin Orders hub (Orders speed, 22 Nov 2026). A GET route, not a server action:
// the browser runs server actions one at a time, route requests in parallel. Admin / accountant only
// (accountants: picker / biller / dispatcher only with that role). Reads only, so one retry on a
// database hiccup (Neon waking). Never cached: orders change all the time.
export async function GET(req: Request) {
  const tab = new URL(req.url).searchParams.get('tab') as AdminTab | null
  if (!tab || !(ADMIN_TABS as readonly string[]).includes(tab)) return NextResponse.json({ error: 'Unknown tab' }, { status: 400 })
  try {
    const u = await getSessionUser()
    if (!u) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!(u.roles.includes('admin') || u.roles.includes('accountant')) || !tabAllowed(tab, u.roles)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const data = await withDbRetry(() => loadAdminTab(tab))
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    console.error('[/api/orders/admin-tab]', tab, err)
    return NextResponse.json({ error: 'Could not load this tab' }, { status: 500 })
  }
}
