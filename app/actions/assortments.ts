'use server'

import { revalidateShopCatalogue } from '@/lib/shop/cache'
import ExcelJS from 'exceljs'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/authz'
import { sheetCells } from '@/lib/catalog/assortment-excel'
import { parseAssortmentSheet, type AssortmentInput, type SheetRow, type UploadLine } from '@/lib/catalog/assortments'
import * as store from '@/lib/catalog/assortment-store'
import type { Assortment } from '@/lib/catalog/assortment-store'


// Server actions accept bodies up to 1 MB (Next.js default); an assortment sheet is a few KB.
const MAX_UPLOAD_BYTES = 900 * 1024

/** Active carton assortments (1 query). */
export async function getAssortments(): Promise<Assortment[]> {
  await requirePermission('assortments.view')
  return store.listActiveAssortments(db)
}

/** Add, or save a new version of, one assortment. Returns the refreshed list (1 extra query). */
export async function saveAssortment(input: AssortmentInput & { id?: number; newDivision?: boolean }): Promise<Assortment[]> {
  const u = await requirePermission('assortments.edit')
  await store.saveAssortment(db, { id: u.id, name: u.name }, input, Boolean(input.newDivision) && !input.id)
  revalidatePath('/master'); revalidateShopCatalogue()
  return store.listActiveAssortments(db)
}

export async function retireAssortment(id: number, reason: string): Promise<Assortment[]> {
  const u = await requirePermission('assortments.edit')
  await store.retireAssortment(db, { id: u.id, name: u.name }, id, reason)
  revalidatePath('/master'); revalidateShopCatalogue()
  return store.listActiveAssortments(db)
}

export interface UploadPreview {
  fileName: string
  rows: SheetRow[]
  lines: UploadLine[]
  errors: string[]
}

/** Read an uploaded workbook and compare it with the database. Writes nothing (1 query). */
export async function previewAssortmentUpload(form: FormData): Promise<UploadPreview> {
  await requirePermission('assortments.edit')
  const file = form.get('file')
  if (!(file instanceof File)) throw new Error('Choose an Excel file.')
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('The file is larger than 900 KB. Upload only the assortment sheet.')
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Upload an .xlsx file (Excel). Save older .xls files as .xlsx first.')
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(await file.arrayBuffer())
  } catch {
    throw new Error('Could not read this file as an Excel workbook.')
  }
  const cells = sheetCells(wb)
  if (!cells) throw new Error('The workbook has no sheets.')
  const parsed = parseAssortmentSheet(cells)
  if (parsed.errors.length) return { fileName: file.name, rows: [], lines: [], errors: parsed.errors }
  if (parsed.rows.length === 0) return { fileName: file.name, rows: [], lines: [], errors: ['The sheet has no assortment rows under the header.'] }
  if (parsed.rows.length > 2000) return { fileName: file.name, rows: [], lines: [], errors: ['More than 2,000 rows. Split the file by division.'] }
  return { fileName: file.name, rows: parsed.rows, lines: await store.previewUpload(db, parsed.rows), errors: [] }
}

/** Apply a previewed sheet. The server re-checks every row against the database before writing. */
export async function applyAssortmentUpload(rows: SheetRow[], fileName: string): Promise<{ result: store.UploadResult; list: Assortment[] }> {
  const u = await requirePermission('assortments.edit')
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2000) throw new Error('Nothing to upload.')
  const result = await store.applyUpload(db, { id: u.id, name: u.name }, rows, String(fileName).slice(0, 200))
  revalidatePath('/master'); revalidateShopCatalogue()
  return { result, list: await store.listActiveAssortments(db) }
}
