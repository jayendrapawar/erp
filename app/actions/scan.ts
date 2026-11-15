'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { scans } from '@/lib/db/schema'
import { articles, articleMrps, articleScanLinks } from '@/lib/db/schema'
import { and, eq, isNull, desc, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { DUPLICATE_QR_ERROR, INVALID_QR_ERROR } from '@/lib/errors'
import { parseQr, isValidWarehouseQr } from '@/lib/qr-parser'
import { normalizeArticleValue } from '@/lib/article-utils'

async function getUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return { id: session.user.id, name: session.user.name ?? null }
}

export async function getCurrentUserName(): Promise<string | null> {
  const user = await getUser()
  return user.name
}

export type RecordScanResult =
  | { ok: true; data: typeof scans.$inferSelect }
  | { ok: false; error: typeof DUPLICATE_QR_ERROR | typeof INVALID_QR_ERROR | 'ERROR'; scannedByName?: string | null }

function colEq(col: Parameters<typeof eq>[0], val: string | undefined) {
  return val ? eq(col, val) : isNull(col)
}

export async function recordScan(rawQrCode: string, notes?: string): Promise<RecordScanResult> {
  if (!isValidWarehouseQr(rawQrCode)) {
    return { ok: false, error: INVALID_QR_ERROR }
  }

  const user = await getUser()
  const parsed = parseQr(rawQrCode)

  const result = await saveParsedScan(rawQrCode, parsed, user.name, notes)
  if (result.ok) {
    try { await recordArticleMrp(parsed) } catch { /* Master price history must never block a scan. */ }
  }
  return result
}

async function saveParsedScan(rawQrCode: string, parsed: ReturnType<typeof parseQr>, userName: string | null, notes?: string): Promise<RecordScanResult> {

  const existing = await db
    .select({ id: scans.id, scannedByName: scans.scannedByName })
    .from(scans)
    .where(
      sql`${scans.rawQrCode} = ${rawQrCode}
          OR ${scans.boxCodes} @> ${JSON.stringify([rawQrCode])}::jsonb`
    )
    .limit(1)

  if (existing.length > 0) {
    return { ok: false, error: DUPLICATE_QR_ERROR, scannedByName: existing[0].scannedByName }
  }

  const artNumber    = parsed.articleCode || undefined
  const colorNumber  = parsed.colorCode   || undefined
  const sizeNumber   = parsed.size        || undefined
  const division     = parsed.division    || undefined
  const mrp          = parsed.mrp ? String(parsed.mrp) : undefined
  const mfgMonth     = parsed.mfgMonth    || undefined
  const mfgYear      = parsed.mfgYear     || undefined

  const matched = await db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        colEq(scans.artNumber,   artNumber),
        colEq(scans.colorNumber, colorNumber),
        colEq(scans.sizeNumber,  sizeNumber),
        colEq(scans.division,    division),
        colEq(scans.mrp,         mrp),
        mfgMonth !== undefined ? eq(scans.mfgMonth, mfgMonth) : isNull(scans.mfgMonth),
        mfgYear  !== undefined ? eq(scans.mfgYear,  mfgYear)  : isNull(scans.mfgYear),
      )
    )
    .limit(1)

  if (matched.length > 0) {
    const rows = await db
      .update(scans)
      .set({
        quantity:  sql`${scans.quantity} + 1`,
        boxCodes:  sql`COALESCE(${scans.boxCodes}, '[]'::jsonb) || ${JSON.stringify([rawQrCode])}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(eq(scans.id, matched[0].id))
      .returning()

    return { ok: true, data: rows[0] }
  }

  const rows = await db
    .insert(scans)
    .values({
      entryType: 'scan',
      rawQrCode,
      boxCodes:  [rawQrCode],
      artNumber,
      colorNumber,
      sizeNumber,
      division,
      mrp,
      mfgMonth,
      mfgYear,
      notes,
      scannedByName: userName ?? '',
      quantity: 1,
    })
    .returning()

  return { ok: true, data: rows[0] }
}

async function recordArticleMrp(parsed: ReturnType<typeof parseQr>) {
  if (!parsed.mrp || !parsed.articleCode) return
  const normalizedCode = normalizeArticleValue(parsed.articleCode)
  const [known] = await db.select({ id: articles.id }).from(articles)
    .where(sql`upper(regexp_replace(btrim(${articles.artCode}), '\\s+', ' ', 'g')) = ${normalizedCode}`).limit(1)
  if (!known) return
  await db.insert(articleMrps).values({ artCode: normalizedCode, mrp: String(parsed.mrp) }).onConflictDoNothing()
}

export type MasterScanCheck =
  | { status: 'duplicate' }
  | { status: 'known' }
  | { status: 'new_colour'; artName: string }
  | { status: 'unknown' }

export async function checkScanAgainstMaster(rawQr: string): Promise<MasterScanCheck> {
  await getUser()
  if (!isValidWarehouseQr(rawQr)) throw new Error('Invalid QR')
  const duplicate = await db.select({ id: scans.id }).from(scans).where(
    sql`${scans.rawQrCode} = ${rawQr} OR ${scans.boxCodes} @> ${JSON.stringify([rawQr])}::jsonb`
  ).limit(1)
  if (duplicate.length) return { status: 'duplicate' }
  const parsed = parseQr(rawQr)
  const code = normalizeArticleValue(parsed.articleCode)
  const color = normalizeArticleValue(parsed.colorCode)
  const codeRows = await db.select({ id: articles.id, artName: articles.artName, colorCode: articles.colorCode })
    .from(articles).where(sql`upper(regexp_replace(btrim(${articles.artCode}), '\\s+', ' ', 'g')) = ${code}`)
  if (!codeRows.length) return { status: 'unknown' }
  if (codeRows.some((row) => normalizeArticleValue(row.colorCode) === color)) return { status: 'known' }
  return { status: 'new_colour', artName: codeRows[0].artName }
}

export async function getRecentScans(limit = 50) {
  const user = await getUser()

  const dbRows = await db
    .select()
    .from(scans)
    .where(eq(scans.scannedByName, user.name ?? ''))
    .orderBy(desc(scans.scannedAt))
    .limit(limit * 4)

  const masterArticles = await db.select({ artCode: articles.artCode, colorCode: articles.colorCode, artName: articles.artName, colorName: articles.color }).from(articles)
  const masterByPair = new Map<string, { artName: string; colorName: string }>()
  for (const article of masterArticles) {
    if (!normalizeArticleValue(article.artCode) || !normalizeArticleValue(article.colorCode)) continue
    const key = `${normalizeArticleValue(article.artCode)}|${normalizeArticleValue(article.colorCode)}`
    if (!masterByPair.has(key)) masterByPair.set(key, { artName: article.artName, colorName: article.colorName })
  }

  type ScanRow = typeof scans.$inferSelect

  const expanded: Array<ScanRow & { _boxCode?: string; masterArtName: string; masterColorName: string }> = []

  for (const row of dbRows) {
    const codes: string[] = Array.isArray(row.boxCodes) && row.boxCodes.length > 0
      ? (row.boxCodes as string[])
      : row.rawQrCode ? [row.rawQrCode] : []
    const normalizedCode = normalizeArticleValue(row.artNumber ?? '')
    const normalizedColor = normalizeArticleValue(row.colorNumber ?? '')
    const master = normalizedCode && normalizedColor ? masterByPair.get(`${normalizedCode}|${normalizedColor}`) : undefined
    const articleLabels = { masterArtName: master?.artName ?? '—', masterColorName: master?.colorName ?? '—' }

    if (codes.length > 0) {
      for (let i = codes.length - 1; i >= 0; i--) {
        expanded.push({ ...row, ...articleLabels, quantity: 1, rawQrCode: codes[i], _boxCode: codes[i] })
        if (expanded.length >= limit) break
      }
    } else {
      expanded.push({ ...row, ...articleLabels })
    }
    if (expanded.length >= limit) break
  }

  return expanded.slice(0, limit)
}

export async function updateScanQuantity(scanId: number, quantity: number) {
  const result = await db
    .update(scans)
    .set({ quantity })
    .where(eq(scans.id, scanId))
    .returning()

  revalidatePath('/scanner')
  revalidatePath('/dashboard')
  return result[0]
}

export async function deleteScan(
  scanId: number,
  rawQrCode?: string,
): Promise<{ scan: typeof scans.$inferSelect | null; undone?: { action: 'created' | 'linked'; artCode: string; colorCode: string } } | null> {
  const rows = await db
    .select({ id: scans.id, quantity: scans.quantity })
    .from(scans)
    .where(eq(scans.id, scanId))
    .limit(1)

  if (rows.length === 0) return null

  const [scanData] = await db.select().from(scans).where(eq(scans.id, scanId)).limit(1)
  const storedBoxCodes = Array.isArray(scanData.boxCodes) ? scanData.boxCodes as string[] : []
  const qrToDelete = rawQrCode ?? scanData.rawQrCode
  if (rawQrCode && storedBoxCodes.length > 0 && !storedBoxCodes.includes(rawQrCode)) return null
  if (rawQrCode && storedBoxCodes.length === 0 && scanData.rawQrCode !== rawQrCode) return null

  const { id, quantity } = rows[0]

  if (quantity <= 1) {
    await db.delete(scans).where(eq(scans.id, id))
    const undone = qrToDelete ? await undoArticleLink(qrToDelete, scanData.artNumber ?? '', scanData.colorNumber ?? '') : undefined
    revalidatePath('/scanner')
    revalidatePath('/dashboard')
    return { scan: null, undone }
  }

  const updated = await db
    .update(scans)
    .set({
      quantity:  sql`${scans.quantity} - 1`,
      ...(rawQrCode
        ? { boxCodes: sql`(SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(${scans.boxCodes}, '[]'::jsonb)) v WHERE v != ${rawQrCode})` }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(scans.id, id))
    .returning()

  const undone = qrToDelete && quantity <= 1 ? await undoArticleLink(qrToDelete, scanData.artNumber ?? '', scanData.colorNumber ?? '') : undefined

  revalidatePath('/scanner')
  revalidatePath('/dashboard')
  return { scan: updated[0], undone }
}

async function undoArticleLink(rawQr: string, artCode: string, colorCode: string): Promise<{ action: 'created' | 'linked'; artCode: string; colorCode: string } | undefined> {
  try {
    const [link] = await db.select().from(articleScanLinks).where(eq(articleScanLinks.rawQr, rawQr)).limit(1)
    if (!link) return undefined
    const normalizedCode = normalizeArticleValue(artCode)
    const normalizedColor = normalizeArticleValue(colorCode)
    const [remaining] = await db.select({ count: sql<number>`count(*)` }).from(scans).where(
      sql`upper(regexp_replace(btrim(${scans.artNumber}), '\\s+', ' ', 'g')) = ${normalizedCode} AND upper(regexp_replace(btrim(${scans.colorNumber}), '\\s+', ' ', 'g')) = ${normalizedColor}`
    )
    if (Number(remaining?.count ?? 0) > 0) return undefined
    if (link.action === 'created') {
      await db.delete(articles).where(eq(articles.id, link.articleId))
      const [otherArticle] = await db.select({ id: articles.id }).from(articles).where(sql`upper(regexp_replace(btrim(${articles.artCode}), '\\s+', ' ', 'g')) = ${normalizedCode}`).limit(1)
      if (!otherArticle) await db.delete(articleMrps).where(sql`upper(btrim(${articleMrps.artCode})) = ${normalizedCode}`)
    } else {
      await db.update(articles).set({ artCode: '', colorCode: '' }).where(eq(articles.id, link.articleId))
    }
    await db.delete(articleScanLinks).where(eq(articleScanLinks.id, link.id))
    return { action: link.action, artCode, colorCode }
  } catch {
    return undefined
  }
}

export async function getAllScans() {
  return db
    .select()
    .from(scans)
    .orderBy(desc(scans.createdAt))
}
