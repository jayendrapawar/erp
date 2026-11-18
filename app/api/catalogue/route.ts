import { NextResponse } from 'next/server'
import { loadCatalogue } from '@/app/actions/catalogue'
import { AuthError } from '@/lib/authz'

// GET /api/catalogue
// Returns the full catalogue (vendors + articles) as JSON.
// Used by:
//   1. The SW stale-while-revalidate strategy — response is cached in
//      `shayona-catalogue-v4` with a 30-min TTL.
//   2. The useCatalogueCache client hook — reads from Cache API or fetches here.
//
// Cache-Control: revalidate every 5 min at the CDN/browser level; SW adds
// its own 30-min stale-while-revalidate on top.
export async function GET() {
  try {
    const catalogue = await loadCatalogue() // checks the signed-in user's permission

    return NextResponse.json(catalogue, {
      headers: {
        // Contains retailer phone numbers and addresses: browser-only cache, never a shared/CDN cache.
        'Cache-Control': 'private, max-age=300, stale-while-revalidate=1800',
      },
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    }
    console.error('[/api/catalogue]', err)
    return NextResponse.json({ error: 'Failed to load catalogue' }, { status: 500 })
  }
}
