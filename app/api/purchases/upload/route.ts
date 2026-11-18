import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { extractText, getDocumentProxy } from 'unpdf'
import { db } from '@/lib/db'
import { AuthError, requirePermission } from '@/lib/authz'
import { DIVISION_MAP } from '@/lib/qr-config'
import { parseRelaxoBill, suggestDivision } from '@/lib/purchases/relaxo-bill'
import { saveBill } from '@/lib/purchases/store'

export const runtime = 'nodejs'

const MAX_FILES = 10
const MAX_BYTES = 4 * 1024 * 1024

export interface UploadFileResult {
  file: string
  status: 'saved' | 'duplicate' | 'error'
  billId?: number
  refNo?: string
  lines?: number
  cartons?: number
  pairs?: number
  division?: string
  assortmentsFound?: number
  errors?: string[]
  warnings?: string[]
}

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
      if (file.size > MAX_BYTES) { results.push({ file: file.name, status: 'error', errors: ['Larger than 4 MB.'] }); continue }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') { results.push({ file: file.name, status: 'error', errors: ['Not a PDF file.'] }); continue }
      // Fingerprint first: pdf.js takes over (detaches) the buffer it is given, so it gets a copy.
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
      let pages: string[]
      try {
        const pdf = await getDocumentProxy(bytes.slice())
        pages = (await extractText(pdf, { mergePages: false })).text as string[]
      } catch {
        results.push({ file: file.name, status: 'error', errors: ['The PDF could not be read.'] }); continue
      }
      if (!pages.join('').trim()) { results.push({ file: file.name, status: 'error', errors: ['The PDF has no text (scanned image). Ask Relaxo for the system-generated PDF.'] }); continue }
      const parsed = parseRelaxoBill(pages)
      if (!parsed.ok) { results.push({ file: file.name, status: 'error', errors: parsed.errors, warnings: parsed.warnings }); continue }
      const division = suggestDivision(parsed.bill.lines, DIVISION_MAP)
      const saved = await saveBill(db, { id: u.id, name: u.name }, parsed.bill, { name: file.name, sha256 }, division)
      results.push(saved.status === 'duplicate'
        ? { file: file.name, status: 'duplicate', billId: saved.id, refNo: saved.refNo }
        : { file: file.name, status: 'saved', billId: saved.id, refNo: saved.refNo, lines: saved.lines, cartons: parsed.bill.totalCartons, pairs: parsed.bill.totalPairs, division, assortmentsFound: saved.assortmentsFound, warnings: parsed.warnings })
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
