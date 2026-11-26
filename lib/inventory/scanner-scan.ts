/**
 * One scan in the Warehouse Scanner = ONE request (POST /api/scanner/scan), owner 26 Nov 2026.
 *
 * Before: three server actions one after another per box (article check → save → reload the last
 * 50 scans), plus a page re-render on the server; Next.js sends server actions one at a time, so
 * fast scans queued behind each other. Now the route does the check and the save together and
 * returns the row the screen shows. Several scans can be in flight at once (each has its own
 * clientEventId, so a retry never adds a box twice).
 *
 *  - Carton label → the stocktake carton check (nothing saved; the screen asks to confirm).
 *  - Box whose article / colour is not in the master, and the user may create articles → 'unknown'
 *    (nothing saved; the new-article dialog opens). Everyone else's is saved as a missing article.
 *  - Otherwise → recordBoxScan (one transaction) + one read for the names.
 */

import { sql } from 'drizzle-orm'
import type { Actor, DbOrTx, Db } from '@/lib/db/types'
import { normalizeArticleValue } from '@/lib/article-utils'
import { parseQr, type QrParseResult } from '@/lib/qr/parser'
import { recordBoxScan } from './scan-service'
import { checkStocktakeCarton, type StocktakeCheck } from './stocktake-carton'
import type { FeedItem } from './stocktake-sessions'

const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`

export type MasterCheck =
  | { status: 'duplicate'; scannedByName: string }
  | { status: 'known' }
  | { status: 'new_colour'; artName: string }
  | { status: 'unknown' }

/** Is this box already scanned, and is its article + colour in the master? One statement. */
export async function boxMasterCheck(db: DbOrTx, p: QrParseResult): Promise<MasterCheck> {
  const code = normalizeArticleValue(p.fields.articleCode?.value)
  const colour = normalizeArticleValue(p.fields.colourCode?.value)
  const r = await db.execute<{ dupBy: string | null; artName: string | null; colourKnown: boolean }>(sql`
    SELECT (SELECT "userName" FROM scan_events WHERE ${p.dedupeKey ? sql`"dedupeKey" = ${p.dedupeKey}` : sql`false`} AND status = 'active' AND purpose = 'stocktake' LIMIT 1) AS "dupBy",
           (SELECT "artName" FROM articles WHERE ${NORM(sql`"artCode"`)} = ${code} AND active ORDER BY id LIMIT 1) AS "artName",
           EXISTS (SELECT 1 FROM articles WHERE ${NORM(sql`"artCode"`)} = ${code} AND ${NORM(sql`"colorCode"`)} = ${colour} AND active) AS "colourKnown"`)
  const x = r.rows[0]
  if (x.dupBy != null) return { status: 'duplicate', scannedByName: String(x.dupBy) }
  if (x.colourKnown) return { status: 'known' }
  if (x.artName != null) return { status: 'new_colour', artName: String(x.artName) }
  return { status: 'unknown' }
}

export type ScanReply =
  | { kind: 'saved'; item: FeedItem; replay: boolean }
  | { kind: 'duplicate'; scannedByName: string; scannedAt: string | null }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; mode: 'unknown' | 'new_colour'; existingName?: string }
  | { kind: 'carton'; check: StocktakeCheck }

export interface ScannerScanInput {
  raw: string
  clientEventId: string
  sessionId: number | null
  deviceAt?: string | null
  /** The user may create articles and has not chosen "save for later": ask before saving an unknown box. */
  askIfUnknown?: boolean
  /** Optional rack / area name the scan is tagged with. */
  flag?: string | null
  offline?: boolean
}

export async function scannerScan(db: Db, actor: Actor, input: ScannerScanInput): Promise<ScanReply> {
  const p = parseQr(input.raw)
  if (p.kind === 'carton') return { kind: 'carton', check: await checkStocktakeCarton(db, input.raw) }
  if (p.kind !== 'box' || p.status === 'invalid' || p.status === 'unrecognised') {
    return { kind: 'rejected', message: p.issues.find((i) => i.severity === 'error')?.message ?? 'QR code not recognised.' }
  }
  if (input.askIfUnknown) {
    const m = await boxMasterCheck(db, p)
    if (m.status === 'duplicate') return { kind: 'duplicate', scannedByName: m.scannedByName, scannedAt: null }
    if (m.status === 'unknown') return { kind: 'unknown', mode: 'unknown' }
    if (m.status === 'new_colour') return { kind: 'unknown', mode: 'new_colour', existingName: m.artName }
  }
  const deviceAt = input.deviceAt ? new Date(input.deviceAt) : null
  const out = await recordBoxScan(db, actor, {
    clientEventId: input.clientEventId, rawInput: input.raw, sessionId: input.sessionId, flag: input.flag ?? null,
    deviceAt: deviceAt && !Number.isNaN(deviceAt.getTime()) ? deviceAt : null,
    source: input.offline ? 'offline_sync' : 'app',
  })
  if (out.status === 'duplicate') return { kind: 'duplicate', scannedByName: out.original.userName, scannedAt: new Date(out.original.createdAt).toISOString() }
  if (out.status === 'rejected') return { kind: 'rejected', message: out.message }
  const e = out.event
  const names = e.articleId
    ? (await db.execute<{ artName: string; color: string }>(sql`SELECT "artName", color FROM articles WHERE id = ${e.articleId}`)).rows[0]
    : undefined
  return {
    kind: 'saved', replay: out.replay,
    item: {
      key: `scan:${e.id}`, id: e.id, eventId: e.clientEventId, type: 'box', articleCode: e.articleCode, colourCode: e.colourCode, size: e.sizeLabel,
      articleName: names?.artName ?? null, colourName: names?.color ?? null, pairs: e.quantity, mrp: e.mrp,
      resolution: e.resolution, userName: e.userName, at: e.createdAt.toISOString(), detail: null,
    },
  }
}
