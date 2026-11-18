import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AuthError, requirePermission } from '@/lib/authz'
import { buildAssortmentWorkbook } from '@/lib/catalog/assortment-excel'
import { divisionsFrom, listActiveAssortments } from '@/lib/catalog/assortment-store'

// GET /api/assortments/export[?division=Flite%20EVA][&template=1]
// The upload format as an .xlsx: the current assortments (optionally one division), or an
// empty template. Edit it in Excel and upload it again in Master → Assortments. One query.
export async function GET(req: Request) {
  try {
    await requirePermission('assortments.view')
    const url = new URL(req.url)
    const division = url.searchParams.get('division')
    const template = url.searchParams.get('template') === '1'
    const active = await listActiveAssortments(db)
    const rows = template ? [] : active.filter(a => !division || a.division === division)
    const buf = await buildAssortmentWorkbook(rows, divisionsFrom(active)).xlsx.writeBuffer()
    const name = template ? 'assortment-template.xlsx' : `assortments${division ? `-${division.replace(/[^A-Za-z0-9]+/g, '-')}` : ''}.xlsx`
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    console.error('[/api/assortments/export]', err)
    return NextResponse.json({ error: 'Could not build the file' }, { status: 500 })
  }
}
