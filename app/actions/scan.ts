'use server'

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { articles } from '@/lib/db/schema'
import { AuthError, requirePermission, requireUser } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import { normalizeArticleValue } from '@/lib/article-utils'
import { parseQr } from '@/lib/qr/parser'
import { recentScansForUser, recordBoxScan, recordManualEntry, voidScanEvent } from '@/lib/inventory/scan-service'
import { DUPLICATE_QR_ERROR, INVALID_QR_ERROR } from '@/lib/errors'
import type { ScanEvent } from '@/lib/db/schema'

/** What the scanner screens display for one scan event. */
export interface ScanView {
  id: number
  entryType: 'scan' | 'manual'
  rawQrCode: string | null
  artNumber: string | null
  colorNumber: string | null
  sizeNumber: string | null
  division: string | null
  mrp: string | null
  mfgMonth: number | null
  mfgYear: number | null
  quantity: number
  scannedAt: Date
  scannedByName: string
  notes: string | null
  flag: string | null
  resolution: 'resolved' | 'missing_article' | 'missing_size'
  masterArtName: string
  masterColorName: string
}

function toView(e: ScanEvent, names?: { artName: string | null; colorName: string | null; division: string | null }): ScanView {
  return {
    id: e.id,
    entryType: e.entryType,
    rawQrCode: e.rawInput,
    artNumber: e.articleCode,
    colorNumber: e.colourCode,
    sizeNumber: e.sizeLabel,
    division: names?.division ?? null,
    mrp: e.mrp,
    mfgMonth: e.mfgMonth,
    mfgYear: e.mfgYear,
    quantity: e.quantity,
    scannedAt: e.createdAt,
    scannedByName: e.userName,
    notes: e.notes,
    flag: e.flag,
    resolution: e.resolution,
    masterArtName: names?.artName ?? '—',
    masterColorName: names?.colorName ?? '—',
  }
}

async function withNames(e: ScanEvent): Promise<ScanView> {
  if (!e.articleId) return toView(e)
  const r = await db.execute<{ artName: string; colorName: string; division: string | null }>(
    sql`SELECT "artName", color AS "colorName", division FROM articles WHERE id = ${e.articleId}`)
  return toView(e, r.rows[0])
}

export interface ScannerContext {
  name: string
  canScan: boolean
  canCreateArticles: boolean
  canVoidAny: boolean
}

export async function getScannerContext(): Promise<ScannerContext> {
  const u = await requireUser()
  return {
    name: u.name,
    canScan: hasPermission(u.roles, 'scan.record'),
    canCreateArticles: hasPermission(u.roles, 'articles.create_from_scan'),
    canVoidAny: hasPermission(u.roles, 'scan.void.any'),
  }
}

export async function getCurrentUserName(): Promise<string | null> {
  return (await requireUser()).name
}

export type RecordScanResult =
  | { ok: true; data: ScanView; replay: boolean }
  | { ok: false; error: typeof DUPLICATE_QR_ERROR; scannedByName: string; scannedAt: Date }
  | { ok: false; error: typeof INVALID_QR_ERROR | 'CARTON_QR'; message: string }
  | { ok: false; error: 'FORBIDDEN' | 'ERROR'; message: string }

export interface RecordScanOptions {
  /** UUID generated on the device when the box was scanned. Makes retries safe. */
  clientEventId?: string
  flag?: string | null
  notes?: string | null
  deviceAt?: string | null
  offline?: boolean
}

export async function recordScan(rawQrCode: string, opts: RecordScanOptions = {}): Promise<RecordScanResult> {
  try {
    const u = await requirePermission('scan.record')
    const out = await recordBoxScan(db, { id: u.id, name: u.name }, {
      clientEventId: opts.clientEventId ?? randomUUID(),
      rawInput: rawQrCode,
      flag: opts.flag,
      notes: opts.notes,
      deviceAt: opts.deviceAt ? new Date(opts.deviceAt) : null,
      source: opts.offline ? 'offline_sync' : 'app',
    })
    if (out.status === 'duplicate') return { ok: false, error: DUPLICATE_QR_ERROR, scannedByName: out.original.userName, scannedAt: out.original.createdAt }
    if (out.status === 'rejected') return { ok: false, error: out.reason === 'carton' ? 'CARTON_QR' : INVALID_QR_ERROR, message: out.message }
    revalidatePath('/dashboard')
    return { ok: true, data: await withNames(out.event), replay: out.replay }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: 'FORBIDDEN', message: 'Your account is not allowed to record scans.' }
    console.error('recordScan failed', e)
    return { ok: false, error: 'ERROR', message: 'The scan could not be saved. Try again.' }
  }
}

export interface ManualEntryForm {
  clientEventId?: string
  artNumber: string
  colorNumber: string
  sizeNumber: string
  quantity: number
  notes?: string | null
  flag?: string | null
  mrp?: number | null
  mfgMonth?: number | null
  mfgYear?: number | null
  offline?: boolean
}

export type ManualEntryResult = { ok: true; data: ScanView; replay: boolean } | { ok: false; error: 'FORBIDDEN' | 'INVALID' | 'ERROR'; message: string }

export async function addManualEntry(input: ManualEntryForm): Promise<ManualEntryResult> {
  try {
    const u = await requirePermission('scan.record')
    const { event, replay } = await recordManualEntry(db, { id: u.id, name: u.name }, {
      clientEventId: input.clientEventId ?? randomUUID(),
      articleCode: input.artNumber,
      colourCode: input.colorNumber,
      sizeLabel: input.sizeNumber,
      quantity: input.quantity,
      notes: input.notes,
      flag: input.flag,
      mrp: input.mrp,
      mfgMonth: input.mfgMonth,
      mfgYear: input.mfgYear,
      source: input.offline ? 'offline_sync' : 'app',
    })
    revalidatePath('/dashboard')
    return { ok: true, data: await withNames(event), replay }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: 'FORBIDDEN', message: 'Your account is not allowed to record stock.' }
    if (e instanceof Error && /required|whole number/.test(e.message)) return { ok: false, error: 'INVALID', message: e.message }
    console.error('addManualEntry failed', e)
    return { ok: false, error: 'ERROR', message: 'The entry could not be saved. Try again.' }
  }
}

export type MasterScanCheck =
  | { status: 'duplicate'; scannedByName: string }
  | { status: 'known' }
  | { status: 'new_colour'; artName: string; canCreate: boolean }
  | { status: 'unknown'; canCreate: boolean }
  | { status: 'carton' }
  | { status: 'invalid'; message: string }

/** Read-only pre-check used by the scanner to decide whether to show the new-article dialog. */
export async function checkScanAgainstMaster(rawQr: string): Promise<MasterScanCheck> {
  const u = await requirePermission('scan.record')
  const p = parseQr(rawQr)
  if (p.kind === 'carton') return { status: 'carton' }
  if (p.kind !== 'box' || p.status === 'invalid' || p.status === 'unrecognised') {
    return { status: 'invalid', message: p.issues.find((i) => i.severity === 'error')?.message ?? 'QR code not recognised.' }
  }
  if (p.dedupeKey) {
    const dup = await db.execute<{ userName: string }>(sql`
      SELECT "userName" FROM scan_events WHERE "dedupeKey" = ${p.dedupeKey} AND status = 'active' AND purpose = 'stocktake' LIMIT 1`)
    if (dup.rows[0]) return { status: 'duplicate', scannedByName: dup.rows[0].userName }
  }
  const canCreate = hasPermission(u.roles, 'articles.create_from_scan')
  const code = normalizeArticleValue(p.fields.articleCode?.value)
  const colour = normalizeArticleValue(p.fields.colourCode?.value)
  const rows = await db.select({ artName: articles.artName, colorCode: articles.colorCode, active: articles.active }).from(articles)
    .where(sql`upper(regexp_replace(btrim(${articles.artCode}), '\\s+', ' ', 'g')) = ${code}`)
  const live = rows.filter((r) => r.active)
  if (!live.length) return { status: 'unknown', canCreate }
  if (live.some((r) => normalizeArticleValue(r.colorCode) === colour)) return { status: 'known' }
  return { status: 'new_colour', artName: live[0].artName, canCreate }
}

export async function getRecentScans(limit = 50): Promise<ScanView[]> {
  const u = await requirePermission('scan.record')
  const rows = await recentScansForUser(db, u.id, limit)
  return rows.map((r) => toView(r.event, { artName: r.artName, colorName: r.colorName, division: r.division }))
}

export type DeleteScanResult =
  | { ok: true; reversed: boolean; articleDeactivated?: { artCode: string; colorCode: string } }
  | { ok: false; message: string }

/** Undo a scan: marks it void and posts a reversing stock movement. Nothing is deleted. */
export async function deleteScan(scanId: number, opts: { reason?: string; removeCreatedArticle?: boolean } = {}): Promise<DeleteScanResult> {
  const u = await requirePermission('scan.void.own')
  const out = await voidScanEvent(db, { id: u.id, name: u.name }, {
    eventId: scanId,
    reason: opts.reason?.trim() || 'Undone from the scanner',
    canVoidAny: hasPermission(u.roles, 'scan.void.any'),
    removeCreatedArticle: opts.removeCreatedArticle,
    canRemoveArticle: hasPermission(u.roles, 'articles.delete'),
  })
  if (!out.ok) return { ok: false, message: out.message }
  revalidatePath('/dashboard')
  if (out.articleDeactivated) revalidatePath('/master')
  return { ok: true, reversed: out.reversed, articleDeactivated: out.articleDeactivated }
}
