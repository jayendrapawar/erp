import { NextResponse, type NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withDbRetry } from '@/lib/db'
import { AuthError, requireUser } from '@/lib/authz'
import { canFindRetailers, cleanQuery, likePattern, orderScope, PER_KIND, toHit, type RecordRow } from '@/lib/search/records'

// GET /api/search?q=… — Ctrl+K "# " record search: order number (or bill number), retailer, article
// code. One SQL statement (three branches, LIMIT 10 each) + the session check. Only after 2+
// characters; the palette debounces typing and cancels stale requests. Nothing is cached: orders
// change all the time. Each role finds only what its own screens show (lib/search/records.ts).
export async function GET(request: NextRequest) {
  try {
    const u = await requireUser()
    const text = cleanQuery(request.nextUrl.searchParams.get('q'))
    if (!text) return NextResponse.json({ results: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
    const like = likePattern(text)
    const prefix = `${like.slice(1)}` // "abc%": starts-with matches first

    const scope = orderScope(u.roles)
    const orderWhere = !scope ? sql`false`
      : 'all' in scope ? sql`true`
      : sql`(${scope.salesman ? sql`o."salesmanId" = ${u.id}` : sql`false`}
            OR ${scope.statuses.length ? sql`o.status::text IN (${sql.join(scope.statuses.map((s) => sql`${s}`), sql`, `)})` : sql`false`})`
    const retailers = canFindRetailers(u.roles)

    const r = await withDbRetry(() => db.execute(sql`
      (SELECT 'order' AS kind, o.id::text AS id, o."orderNumber" AS title, o."shopkeeperName" AS sub,
              o.status::text AS status, o."salesmanId" AS salesman_id
         FROM orders o
        WHERE (o."orderNumber" ILIKE ${like} OR o."billNo" ILIKE ${like}) AND ${orderWhere}
        ORDER BY (o."orderNumber" ILIKE ${prefix}) DESC, o.id DESC
        LIMIT ${PER_KIND})
      UNION ALL
      (SELECT 'retailer', r.id, r."partyName", concat_ws(' · ', NULLIF(r.city, ''), NULLIF(r.phone, '')), r.status, NULL
         FROM retailers r
        WHERE ${retailers} AND (r."partyName" ILIKE ${like} OR r.id ILIKE ${like} OR r.phone ILIKE ${like})
        ORDER BY (r."partyName" ILIKE ${prefix}) DESC, r."partyName"
        LIMIT ${PER_KIND})
      UNION ALL
      (SELECT 'article', min(a.id)::text, a."artCode", string_agg(DISTINCT NULLIF(a."artName", ''), ' / '), NULL, NULL
         FROM articles a
        WHERE a.active AND a."retiredAt" IS NULL AND btrim(a."artCode") <> '' AND (a."artCode" ILIKE ${like} OR a."artName" ILIKE ${like})
        GROUP BY a."artCode"
        ORDER BY (a."artCode" ILIKE ${prefix}) DESC, a."artCode"
        LIMIT ${PER_KIND})
    `))
    const results = (r.rows as unknown as RecordRow[]).map((row) => toHit(row, u.roles, u.id))
    return NextResponse.json({ results }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    }
    console.error('[/api/search]', err)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
