import { NextResponse } from 'next/server'
import { loadCatalogue } from '@/app/actions/catalogue'
import { AuthError } from '@/lib/authz'

// GET /api/catalogue
// Returns the full catalogue (version + vendors + articles) as JSON, for the admin Orders hub
// (lib/use-catalogue-cache.ts). That hook keeps the one saved copy and asks here only when the
// catalogue version changed, so this answer is never cached anywhere else (browser HTTP cache and
// service worker used to serve copies up to 30 min old after a Master edit; 24 Nov 2026).
export async function GET() {
  try {
    const catalogue = await loadCatalogue() // checks the signed-in user's permission

    return NextResponse.json(catalogue, {
      // Contains retailer phone numbers and addresses: never a shared/CDN cache either.
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    }
    console.error('[/api/catalogue]', err)
    return NextResponse.json({ error: 'Failed to load catalogue' }, { status: 500 })
  }
}
