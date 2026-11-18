import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AuthError, requirePermission } from '@/lib/authz'
import { importBillPdf, type ImportFileResult } from '@/lib/purchases/import-pdf'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_FILES = 10

export type UploadFileResult = ImportFileResult

// POST /api/purchases/upload (multipart, field "files"): read Relaxo bill PDFs and save them as
// expected stock. Each file: text extraction in memory (the PDF itself is not stored), parsing,
// total checks, then one transaction. A file already uploaded (same reference or bytes) is skipped.
export async function POST(req: Request) {
  try {
    const u = await requirePermission('purchases.upload')
    const form = await req.formData()
    const files = form.getAll('files').filter((f): f is File => f instanceof File).slice(0, MAX_FILES)
    if (!files.length) return NextResponse.json({ error: 'Choose one or more bill PDFs.' }, { status: 400 })
    const results: UploadFileResult[] = []
    for (const file of files) {
      results.push(await importBillPdf(db, { id: u.id, name: u.name }, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), source: 'upload' }))
    }
    return NextResponse.json({ results })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    console.error('[/api/purchases/upload]', err)
    // Local development only: show the cause (never in production builds).
    const detail = process.env.NODE_ENV === 'development' && err instanceof Error ? ` (${err.message})` : ''
    return NextResponse.json({ error: `Upload failed.${detail}` }, { status: 500 })
  }
}
