// One bill PDF → saved bill (shared by upload and mail). Server only.

import crypto from 'node:crypto'
import { extractText, getDocumentProxy } from 'unpdf'
import type { Actor, Db } from '@/lib/db/types'
import { DIVISION_MAP } from '@/lib/qr-config'
import { parseRelaxoBill, suggestDivision } from './relaxo-bill'
import { saveBill } from './store'

export const MAX_PDF_BYTES = 4 * 1024 * 1024

export interface ImportFileResult {
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

/** Read, check and save one bill PDF. The PDF itself is not stored. */
export async function importBillPdf(db: Db, actor: Actor, file: { name: string; bytes: Uint8Array; source: 'upload' | 'mail' }): Promise<ImportFileResult> {
  const { name, bytes } = file
  if (bytes.length > MAX_PDF_BYTES) return { file: name, status: 'error', errors: ['Larger than 4 MB.'] }
  if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') return { file: name, status: 'error', errors: ['Not a PDF file.'] }
  // Fingerprint first: pdf.js takes over (detaches) the buffer it is given, so it gets a copy.
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  let pages: string[]
  try {
    const pdf = await getDocumentProxy(bytes.slice())
    pages = (await extractText(pdf, { mergePages: false })).text as string[]
  } catch {
    return { file: name, status: 'error', errors: ['The PDF could not be read.'] }
  }
  if (!pages.join('').trim()) return { file: name, status: 'error', errors: ['The PDF has no text (scanned image).'] }
  const parsed = parseRelaxoBill(pages)
  if (!parsed.ok) return { file: name, status: 'error', errors: parsed.errors, warnings: parsed.warnings }
  const division = suggestDivision(parsed.bill.lines, DIVISION_MAP)
  const saved = await saveBill(db, actor, parsed.bill, { name, sha256, source: file.source }, division)
  return saved.status === 'duplicate'
    ? { file: name, status: 'duplicate', billId: saved.id, refNo: saved.refNo }
    : { file: name, status: 'saved', billId: saved.id, refNo: saved.refNo, lines: saved.lines, cartons: parsed.bill.totalCartons, pairs: parsed.bill.totalPairs, division, assortmentsFound: saved.assortmentsFound, warnings: parsed.warnings }
}
