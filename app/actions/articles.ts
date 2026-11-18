'use server'

import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { articles, articleSizes, articleColors, articleMrps, articleScanLinks, missingArticleReviews, catalogReviewItems, type CatalogReviewStatus } from '@/lib/db/schema'
import type { Tx } from '@/lib/db/types'
import { AuthError, requirePermission, type SessionUser } from '@/lib/authz'
import { audit } from '@/lib/audit'
import { parseSizeText, normalizeArticleValue, hasArticleNumberMismatch } from '@/lib/article-utils'
import { parseQr, isValidWarehouseQr } from '@/lib/qr-parser'
import { recordBoxScan, resolvePendingScans } from '@/lib/inventory/scan-service'
import { expandSizeRange, sizeSortOrders, sortSizes } from '@/lib/catalog/sizes'

export type Article = typeof articles.$inferSelect

const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`

function actorOf(u: SessionUser) { return { id: u.id, name: u.name } }

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}

function friendlyUniqueError(error: unknown): never {
  if (isUniqueViolation(error)) throw new Error('An article with this article code and colour code already exists.')
  throw error
}

/** Footwear size order: adult charts 6…12, children's charts 11, 12, 13, 1, 2… (lib/catalog/sizes). */
const sortSizeLabels = sortSizes

/** Sizes from a min–max pair; children's ranges such as 11–1 wrap from 13 to 1. */
function sizesFromRange(minSize: string, maxSize: string): string[] {
  const r = expandSizeRange(minSize, maxSize)
  return r.ok ? r.sizes : []
}

/** Attach a variant to its article-code record (catalog_articles), creating it if needed. */
async function ensureCatalogArticle(tx: Tx, articleId: number, artCode: string, artName: string, source: 'manual' | 'import' | 'scan_dialog') {
  if (!artCode) return
  await tx.execute(sql`
    WITH c AS (
      INSERT INTO catalog_articles ("artCode", "artName", source) VALUES (${artCode}, ${artName}, ${source})
      ON CONFLICT ("artCode") DO UPDATE SET "updatedAt" = catalog_articles."updatedAt"
      RETURNING id)
    UPDATE articles SET "catalogArticleId" = (SELECT id FROM c) WHERE id = ${articleId}`)
}

/**
 * Make the article's active sizes equal `labels`. Existing size rows (SKUs) keep their ids:
 * missing labels are added, removed labels are deactivated — never deleted, because the
 * stock ledger references them.
 */
async function syncSizes(tx: Tx, articleId: number, labels: string[]) {
  const sorted = sortSizeLabels([...new Set(labels.map((l) => l.trim()).filter(Boolean))])
  const order = sizeSortOrders(sorted)
  const existing = await tx.select().from(articleSizes).where(eq(articleSizes.articleId, articleId))
  for (const label of sorted) {
    const row = existing.find((r) => r.sizeLabel === label)
    const sortOrder = order.get(label)!
    if (row) {
      if (!row.active || row.sortOrder !== sortOrder) await tx.update(articleSizes).set({ active: true, sortOrder }).where(eq(articleSizes.id, row.id))
    } else {
      await tx.insert(articleSizes).values({ articleId, sizeLabel: label, sortOrder })
    }
  }
  const stale = existing.filter((r) => r.active && !sorted.includes(r.sizeLabel)).map((r) => r.id)
  if (stale.length) await tx.update(articleSizes).set({ active: false }).where(inArray(articleSizes.id, stale))
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getArticles(): Promise<Article[]> {
  await requirePermission('articles.view')
  return db.select().from(articles).orderBy(asc(articles.artName))
}

export type MissingArticle = {
  artCode: string
  colorCode: string
  boxCount: number
  scanCount: number
  sizes: string[]
  mrps: string[]
  rawQr: string
  /** 'missing_article': code/colour unknown. 'missing_size': article known, size not configured. */
  kind: 'missing_article' | 'missing_size'
  firstSeen: string
  lastSeen: string
  scannedBy: string[]
  reviewStatus: 'open' | 'ignored'
  reviewNote: string
}

/** Scanned code/colour pairs that are not (fully) in the article master. Built from scan events. */
export async function getMissingArticles(): Promise<MissingArticle[]> {
  await requirePermission('articles.view')
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT e."articleCode", e."colourCode",
           sum(e.quantity)::int AS boxes, count(*)::int AS scans,
           array_remove(array_agg(DISTINCT e."sizeLabel"), NULL) AS sizes,
           array_remove(array_agg(DISTINCT e.mrp::text), NULL) AS mrps,
           (array_agg(e."rawInput" ORDER BY e.id DESC) FILTER (WHERE e."rawInput" IS NOT NULL))[1] AS raw,
           bool_or(e.resolution = 'missing_article') AS "anyMissingArticle",
           min(e."createdAt") AS first, max(e."createdAt") AS last,
           array_agg(DISTINCT e."userName") AS users,
           coalesce(max(r.status), 'open') AS "reviewStatus", coalesce(max(r.note), '') AS "reviewNote"
    FROM scan_events e
    LEFT JOIN missing_article_reviews r ON r."articleCode" = e."articleCode" AND r."colourCode" = coalesce(e."colourCode", '')
    WHERE e.status = 'active' AND e.resolution <> 'resolved' AND e."articleCode" IS NOT NULL
    GROUP BY e."articleCode", e."colourCode"
    ORDER BY max(e."createdAt") DESC
    LIMIT 500`)
  return r.rows.map((x) => ({
    artCode: x.articleCode as string,
    colorCode: (x.colourCode as string) ?? '',
    boxCount: Number(x.boxes),
    scanCount: Number(x.scans),
    sizes: sortSizeLabels((x.sizes as string[]) ?? []),
    mrps: ((x.mrps as string[]) ?? []).sort((a, b) => Number(a) - Number(b)),
    rawQr: (x.raw as string) ?? '',
    kind: x.anyMissingArticle ? 'missing_article' : 'missing_size',
    firstSeen: new Date(x.first as string).toISOString(),
    lastSeen: new Date(x.last as string).toISOString(),
    scannedBy: ((x.users as string[]) ?? []).filter(Boolean),
    reviewStatus: x.reviewStatus as 'open' | 'ignored',
    reviewNote: x.reviewNote as string,
  }))
}

export async function getArticleMrps(): Promise<Record<string, string[]>> {
  await requirePermission('articles.view')
  const rows = await db.select({ artCode: articleMrps.artCode, mrp: articleMrps.mrp }).from(articleMrps).orderBy(asc(articleMrps.artCode), asc(articleMrps.mrp))
  const result: Record<string, string[]> = {}
  for (const row of rows) (result[normalizeArticleValue(row.artCode)] ??= []).push(row.mrp)
  return result
}

export async function getArticleSizes(articleId: number): Promise<string[]> {
  await requirePermission('articles.view')
  const rows = await db.select({ sizeLabel: articleSizes.sizeLabel }).from(articleSizes)
    .where(and(eq(articleSizes.articleId, articleId), eq(articleSizes.active, true)))
    .orderBy(articleSizes.sortOrder)
  return rows.map((r) => r.sizeLabel)
}

export async function searchArticleNames(query: string): Promise<string[]> {
  await requirePermission('articles.view')
  const q = normalizeArticleValue(query)
  if (!q) return []
  const rows = await db.selectDistinct({ artName: articles.artName }).from(articles)
    .where(sql`upper(${articles.artName}) LIKE ${`%${q}%`} AND ${articles.active}`).orderBy(asc(articles.artName)).limit(20)
  return rows.map((row) => row.artName)
}

export async function getColoursForName(name: string): Promise<Array<{ colorName: string; hasCodes: boolean }>> {
  await requirePermission('articles.view')
  const rows = await db.select({ colorName: articleColors.colorName, artCode: articles.artCode, colorCode: articles.colorCode })
    .from(articleColors).innerJoin(articles, eq(articles.id, articleColors.articleId))
    .where(sql`${NORM(articles.artName)} = ${normalizeArticleValue(name)} AND ${articles.active}`)
  const result = new Map<string, boolean>()
  for (const row of rows) result.set(row.colorName, (result.get(row.colorName) ?? false) || Boolean(normalizeArticleValue(row.artCode) && normalizeArticleValue(row.colorCode)))
  return [...result].map(([colorName, hasCodes]) => ({ colorName, hasCodes }))
}

// ── Writes from the Master screen ────────────────────────────────────────────

export async function saveArticle(
  input: Omit<Article, 'id' | 'reviewStatus' | 'active' | 'source' | 'division' | 'catalogArticleId' | 'retiredAt' | 'retiredReason'> & { id?: number; customSizes?: string; division?: string | null },
): Promise<Article[]> {
  const u = await requirePermission('articles.edit')
  const { customSizes, id, ...fields } = input
  const clean = {
    artName: fields.artName.trim(),
    artCode: normalizeArticleValue(fields.artCode),
    color: fields.color.trim(),
    colorCode: normalizeArticleValue(fields.colorCode),
    minSize: fields.minSize,
    maxSize: fields.maxSize,
    division: fields.division?.trim() || null,
  }

  const labels = new Set<string>(parseSizeText(customSizes ?? ''))
  for (const s of sizesFromRange(clean.minSize, clean.maxSize)) labels.add(s)

  try {
    await db.transaction(async (tx) => {
      let articleId: number
      let resyncSizes = true
      if (id) {
        const [before] = await tx.select().from(articles).where(eq(articles.id, id)).for('update')
        if (!before) throw new Error('Article not found.')
        // A variant supplied in several size ranges (kids 11–13, 1, 2–5) shows only its first and
        // last size here. Unless the admin changed the sizes, keep its SKUs exactly as they are.
        resyncSizes = before.minSize !== clean.minSize || before.maxSize !== clean.maxSize || Boolean((customSizes ?? '').trim())
        await tx.update(articles).set({ ...clean, reviewStatus: 'approved' }).where(eq(articles.id, id))
        articleId = id
        await audit(tx, { actor: actorOf(u), action: 'article.updated', entityType: 'article', entityId: id, before, after: clean })
      } else {
        const [inserted] = await tx.insert(articles).values({ ...clean, reviewStatus: 'approved', source: 'manual' }).returning({ id: articles.id })
        articleId = inserted.id
        await audit(tx, { actor: actorOf(u), action: 'article.created', entityType: 'article', entityId: articleId, after: clean })
      }
      await tx.delete(articleColors).where(eq(articleColors.articleId, articleId))
      if (clean.color) await tx.insert(articleColors).values({ articleId, colorName: clean.color, colorHex: clean.colorCode || null })
      if (resyncSizes) {
        if (!labels.size) throw new Error('Enter a valid size range (for example 6–10, or 11–1 for children) or a list of sizes.')
        await syncSizes(tx, articleId, [...labels])
        const ordered = sortSizeLabels([...labels])
        await tx.update(articles).set({ minSize: ordered[0], maxSize: ordered[ordered.length - 1] }).where(eq(articles.id, articleId))
      }
      await ensureCatalogArticle(tx, articleId, clean.artCode, clean.artName, 'manual')
      // Scans that were waiting for this code/colour/size are posted now.
      if (clean.artCode && clean.colorCode) await resolvePendingScans(tx, actorOf(u), clean.artCode, clean.colorCode)
    })
  } catch (error) { friendlyUniqueError(error) }

  revalidatePath('/master')
  return db.select().from(articles).orderBy(asc(articles.artName))
}

/**
 * Remove an article. If anything references it (scans, stock, orders) it is deactivated
 * instead, so history keeps pointing at the right record.
 */
export async function deleteArticle(id: number): Promise<Article[]> {
  const u = await requirePermission('articles.delete')
  await db.transaction(async (tx) => {
    const [art] = await tx.select().from(articles).where(eq(articles.id, id)).for('update')
    if (!art) return
    const used = await tx.execute(sql`
      SELECT 1 FROM scan_events WHERE "articleId" = ${id}
      UNION ALL SELECT 1 FROM stock_movements m JOIN article_sizes s ON s.id = m."skuId" WHERE s."articleId" = ${id}
      UNION ALL SELECT 1 FROM order_items WHERE upper(btrim("artNumber")) = upper(btrim(${art.artName}))
        AND upper(coalesce("colorNumber", '')) IN (upper(${art.color}), upper(${art.colorCode}))
      LIMIT 1`)
    if (used.rows.length) {
      await tx.update(articles).set({ active: false }).where(eq(articles.id, id))
      await audit(tx, { actor: actorOf(u), action: 'article.deactivated', entityType: 'article', entityId: id, before: art, after: { active: false }, reason: 'Delete requested; article is referenced by scans, stock or orders' })
    } else {
      await tx.delete(articles).where(eq(articles.id, id))
      await audit(tx, { actor: actorOf(u), action: 'article.deleted', entityType: 'article', entityId: id, before: art })
    }
  })
  revalidatePath('/master')
  return db.select().from(articles).orderBy(asc(articles.artName))
}

/** Bulk import from CSV. All-or-nothing: any conflict rolls back the whole file. */
export async function importArticles(
  rows: Array<Omit<Article, 'id' | 'reviewStatus' | 'active' | 'source' | 'division' | 'catalogArticleId' | 'retiredAt' | 'retiredReason'> & { customSizes?: string }>,
): Promise<{ imported: number; skipped: number; list: Article[] }> {
  const u = await requirePermission('articles.edit')

  const existing = await db.select({ artName: articles.artName, color: articles.color, artCode: articles.artCode, colorCode: articles.colorCode }).from(articles)
  type Row = (typeof rows)[number]
  const fileRows = new Map<string, Row>()
  const sizeUnion = new Map<string, Set<string>>()
  const keyFor = (row: { artName: string; color: string; artCode: string; colorCode: string }) => {
    const code = normalizeArticleValue(row.artCode), shade = normalizeArticleValue(row.colorCode)
    return code && shade ? `code:${code}||${shade}` : `name:${normalizeArticleValue(row.artName)}||${normalizeArticleValue(row.color)}`
  }
  for (const row of rows) {
    const key = keyFor(row)
    const labels = new Set<string>()
    const explicit = parseSizeText(row.customSizes ?? '')
    if (explicit.length) explicit.forEach((s) => labels.add(s))
    else sizesFromRange(row.minSize, row.maxSize).forEach((s) => labels.add(s))
    if (fileRows.has(key)) labels.forEach((l) => sizeUnion.get(key)!.add(l))
    else {
      fileRows.set(key, { ...row, artCode: normalizeArticleValue(row.artCode), colorCode: normalizeArticleValue(row.colorCode) })
      sizeUnion.set(key, labels)
    }
  }
  const codeKeys = new Set(existing.filter((a) => normalizeArticleValue(a.artCode) && normalizeArticleValue(a.colorCode)).map(keyFor))
  const nameKeys = new Set(existing.map((a) => `name:${normalizeArticleValue(a.artName)}||${normalizeArticleValue(a.color)}`))
  const newRows = [...fileRows.entries()].filter(([key, row]) => {
    const hasCodes = normalizeArticleValue(row.artCode) && normalizeArticleValue(row.colorCode)
    return !(hasCodes ? codeKeys : nameKeys).has(key)
  })

  let insertedCount = 0
  try {
    await db.transaction(async (tx) => {
      if (!newRows.length) return
      const inserted = await tx.insert(articles).values(newRows.map(([key, { customSizes: _c, ...row }]) => {
        const sizes = sortSizeLabels([...(sizeUnion.get(key) ?? [])])
        return { ...row, minSize: sizes[0] ?? '', maxSize: sizes[sizes.length - 1] ?? '', source: 'import' as const }
      })).returning({ id: articles.id })
      insertedCount = inserted.length
      const colorRows = inserted.flatMap(({ id }, i) => newRows[i][1].color.trim() ? [{ articleId: id, colorName: newRows[i][1].color.trim(), colorHex: newRows[i][1].colorCode || null }] : [])
      if (colorRows.length) await tx.insert(articleColors).values(colorRows)
      const sizeRows = inserted.flatMap(({ id }, i) => {
        const labels = sortSizeLabels([...(sizeUnion.get(newRows[i][0]) ?? [])])
        const order = sizeSortOrders(labels)
        return labels.map((sizeLabel) => ({ articleId: id, sizeLabel, sortOrder: order.get(sizeLabel)! }))
      })
      for (let i = 0; i < sizeRows.length; i += 1000) await tx.insert(articleSizes).values(sizeRows.slice(i, i + 1000))
      // Attach coded rows to their article-code records (two statements for the whole file).
      const insertedIds = JSON.stringify(inserted.map((r) => r.id))
      await tx.execute(sql`
        INSERT INTO catalog_articles ("artCode", "artName", source)
        SELECT DISTINCT ON (a."artCode") a."artCode", a."artName", 'import' FROM articles a
        WHERE a.id IN (SELECT json_array_elements_text(${insertedIds}::json)::int) AND a."artCode" <> ''
        ON CONFLICT ("artCode") DO NOTHING`)
      await tx.execute(sql`
        UPDATE articles a SET "catalogArticleId" = c.id FROM catalog_articles c
        WHERE a.id IN (SELECT json_array_elements_text(${insertedIds}::json)::int) AND c."artCode" = a."artCode"`)
      await audit(tx, { actor: actorOf(u), action: 'article.imported', entityType: 'article_import', entityId: new Date().toISOString(), after: { rows: rows.length, imported: insertedCount } })
      const codes = new Set(newRows.map(([, r]) => `${r.artCode}|${r.colorCode}`).filter((k) => !k.startsWith('|') && !k.endsWith('|')))
      for (const k of codes) { const [c, col] = k.split('|'); await resolvePendingScans(tx, actorOf(u), c, col) }
    })
  } catch (error) { friendlyUniqueError(error) }

  revalidatePath('/master')
  const list = await db.select().from(articles).orderBy(asc(articles.artName))
  return { imported: insertedCount, skipped: rows.length - insertedCount, list }
}

// ── Missing articles: review actions (admin) ─────────────────────────────────

export async function setMissingArticleReview(articleCode: string, colourCode: string, status: 'open' | 'ignored', note: string): Promise<void> {
  const u = await requirePermission('articles.review_missing')
  const code = normalizeArticleValue(articleCode), colour = normalizeArticleValue(colourCode)
  await db.transaction(async (tx) => {
    await tx.insert(missingArticleReviews).values({ articleCode: code, colourCode: colour, status, note, updatedBy: u.id })
      .onConflictDoUpdate({ target: [missingArticleReviews.articleCode, missingArticleReviews.colourCode], set: { status, note, updatedBy: u.id, updatedAt: new Date() } })
    await audit(tx, { actor: actorOf(u), action: `missing_article.${status}`, entityType: 'article_code', entityId: `${code}|${colour}`, reason: note || null })
  })
  revalidatePath('/master')
}

/** Add a scanned size to an existing article and post the scans that were waiting for it. */
export async function addSizeToArticleFromScans(articleCode: string, colourCode: string, sizeLabel: string): Promise<{ resolved: number }> {
  const u = await requirePermission('articles.create_from_scan')
  const code = normalizeArticleValue(articleCode), colour = normalizeArticleValue(colourCode), size = sizeLabel.trim()
  if (!size) throw new Error('Size is required.')
  const out = await db.transaction(async (tx) => {
    const [art] = await tx.select().from(articles).where(sql`${NORM(articles.artCode)} = ${code} AND ${NORM(articles.colorCode)} = ${colour} AND ${articles.active}`).limit(1)
    if (!art) throw new Error('No active article with this code and colour code.')
    const current = await tx.select({ sizeLabel: articleSizes.sizeLabel }).from(articleSizes).where(and(eq(articleSizes.articleId, art.id), eq(articleSizes.active, true)))
    await syncSizes(tx, art.id, [...current.map((c) => c.sizeLabel), size])
    await audit(tx, { actor: actorOf(u), action: 'article.size_added', entityType: 'article', entityId: art.id, after: { size }, reason: 'Size seen on scanned boxes' })
    return resolvePendingScans(tx, actorOf(u), code, colour)
  })
  revalidatePath('/master')
  return { resolved: out.resolved }
}

// ── Feature 01: create or link an article from a scanned box (admin only) ───

type LinkResult = { ok: true; articleId: number } | { ok: false; error: 'SIZE_NOT_IN_ARTICLE'; sizes: string[] } | { ok: false; error: 'NUMBER_MISMATCH' | 'DUPLICATE_QR' | 'SIZES_REQUIRED' | 'NAME_REQUIRED' | 'ALREADY_EXISTS' | 'FORBIDDEN' | 'INVALID_QR' }

interface LinkInput {
  rawQr: string; artName: string; colorName: string; sizesText: string; addScannedSize: boolean; confirmWarnings: boolean
  flag?: string; notes?: string; saveScan?: boolean; clientEventId?: string
}

class LinkAbort extends Error { constructor(public result: LinkResult) { super('link aborted') } }

export async function linkOrCreateArticle(input: LinkInput): Promise<LinkResult> {
  try {
    return await linkOrCreateArticleOnce(input)
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: 'FORBIDDEN' }
    if (!isUniqueViolation(error)) throw error
    try {
      return await linkOrCreateArticleOnce(input)
    } catch (retryError) {
      if (isUniqueViolation(retryError)) return { ok: false, error: 'ALREADY_EXISTS' }
      throw retryError
    }
  }
}

/**
 * Everything happens in ONE transaction: the article change, the scan of this box, the
 * scan link, posting any other scans that were waiting for this article, and the audit
 * rows. If any step fails, nothing is saved.
 */
async function linkOrCreateArticleOnce(input: LinkInput): Promise<LinkResult> {
  const u = await requirePermission('articles.create_from_scan')
  const actor = actorOf(u)
  if (!isValidWarehouseQr(input.rawQr)) return { ok: false, error: 'INVALID_QR' }
  const parsed = parseQr(input.rawQr)
  const artCode = normalizeArticleValue(parsed.articleCode)
  const colorCode = normalizeArticleValue(parsed.colorCode)
  const name = input.artName.trim()
  const color = input.colorName.trim()
  if (!name || !color) return { ok: false, error: 'NAME_REQUIRED' }
  if (!input.confirmWarnings && hasArticleNumberMismatch(name, artCode)) return { ok: false, error: 'NUMBER_MISMATCH' }

  try {
    const articleId = await db.transaction(async (tx) => {
      let sizes: string[] = []
      let linkAction: 'created' | 'linked' | undefined
      const [byCode] = await tx.select({ id: articles.id, active: articles.active, retiredReason: articles.retiredReason }).from(articles)
        .where(sql`${NORM(articles.artCode)} = ${artCode} AND ${NORM(articles.colorCode)} = ${colorCode}`).limit(1).for('update')
      let articleId: number | undefined = byCode?.id
      if (byCode && !byCode.active) {
        // Same code + colour exists but was retired (e.g. absent from the approved catalogue).
        // It is the same product: re-activate it so its id, sizes and history are kept, and
        // flag it for review because the approved catalogue did not list it.
        await tx.update(articles).set({ active: true, retiredAt: null, retiredReason: null, reviewStatus: 'needs_review' }).where(eq(articles.id, byCode.id))
        await audit(tx, { actor, action: 'article.reactivated_from_scan', entityType: 'article', entityId: byCode.id,
          before: { active: false, retiredReason: byCode.retiredReason }, after: { active: true, reviewStatus: 'needs_review' }, metadata: { rawQr: input.rawQr } })
      }

      if (articleId) {
        sizes = (await tx.select({ sizeLabel: articleSizes.sizeLabel }).from(articleSizes)
          .where(and(eq(articleSizes.articleId, articleId), eq(articleSizes.active, true))).orderBy(articleSizes.sortOrder)).map((r) => r.sizeLabel)
        if (!sizes.includes(parsed.size)) {
          if (!input.addScannedSize) throw new LinkAbort({ ok: false, error: 'SIZE_NOT_IN_ARTICLE', sizes })
          await syncSizes(tx, articleId, [...sizes, parsed.size])
        }
      } else {
        const byName = await tx.select({ id: articles.id, artName: articles.artName, color: articles.color, artCode: articles.artCode, colorCode: articles.colorCode })
          .from(articles).where(sql`${NORM(articles.artName)} = ${normalizeArticleValue(name)} AND ${articles.active}`)
        const sameCodeRows = await tx.select({ id: articles.id }).from(articles).where(sql`${NORM(articles.artCode)} = ${artCode} AND ${articles.active}`)
        const blankCode = byName.find((r) => normalizeArticleValue(r.color) === normalizeArticleValue(color) && !normalizeArticleValue(r.artCode) && !normalizeArticleValue(r.colorCode))
        const sizeSource = sameCodeRows[0] ?? blankCode
        const storedName = byName[0]?.artName ?? name
        sizes = sizeSource
          ? (await tx.select({ sizeLabel: articleSizes.sizeLabel }).from(articleSizes).where(and(eq(articleSizes.articleId, sizeSource.id), eq(articleSizes.active, true))).orderBy(articleSizes.sortOrder)).map((r) => r.sizeLabel)
          : parseSizeText(input.sizesText)
        if (!sizeSource && !sizes.length) throw new LinkAbort({ ok: false, error: 'SIZES_REQUIRED' })
        if (!sizes.includes(parsed.size)) {
          if (!input.addScannedSize) throw new LinkAbort({ ok: false, error: 'SIZE_NOT_IN_ARTICLE', sizes })
          sizes.push(parsed.size)
        }
        if (blankCode && !sameCodeRows.length) {
          const updated = await tx.update(articles).set({ artCode, colorCode, reviewStatus: 'approved' })
            .where(sql`${articles.id} = ${blankCode.id} AND ${articles.artCode} = '' AND ${articles.colorCode} = ''`).returning({ id: articles.id })
          articleId = updated[0]?.id
          if (articleId) {
            linkAction = 'linked'
            await syncSizes(tx, articleId, [...sizes])
            await ensureCatalogArticle(tx, articleId, artCode, blankCode.artName, 'scan_dialog')
            await audit(tx, { actor, action: 'article.linked_from_scan', entityType: 'article', entityId: articleId, before: blankCode, after: { artCode, colorCode }, metadata: { rawQr: input.rawQr } })
          }
        }
        if (!articleId) {
          const ordered = sortSizeLabels(sizes)
          const [inserted] = await tx.insert(articles).values({
            artName: storedName, artCode, color, colorCode,
            minSize: ordered[0] ?? '', maxSize: ordered[ordered.length - 1] ?? '',
            reviewStatus: 'approved', source: 'scan_dialog',
          }).returning({ id: articles.id })
          articleId = inserted.id
          linkAction = 'created'
          await tx.insert(articleColors).values({ articleId, colorName: color, colorHex: colorCode || null })
          await syncSizes(tx, articleId, sizes)
          await ensureCatalogArticle(tx, articleId, artCode, storedName, 'scan_dialog')
          await audit(tx, { actor, action: 'article.created_from_scan', entityType: 'article', entityId: articleId, after: { artName: storedName, artCode, color, colorCode, sizes }, metadata: { rawQr: input.rawQr } })
        }
      }

      let scanEventId: number | null = null
      if (input.saveScan !== false) {
        const scan = await recordBoxScan(tx, actor, { clientEventId: input.clientEventId ?? randomUUID(), rawInput: input.rawQr, flag: input.flag, notes: input.notes })
        if (scan.status === 'duplicate') throw new LinkAbort({ ok: false, error: 'DUPLICATE_QR' })
        if (scan.status === 'rejected') throw new LinkAbort({ ok: false, error: 'INVALID_QR' })
        scanEventId = scan.event.id
      }
      if (linkAction) {
        await tx.insert(articleScanLinks).values({ articleId: articleId!, action: linkAction, rawQr: input.rawQr, userName: actor.name, userId: actor.id, scanEventId })
      }
      await resolvePendingScans(tx, actor, artCode, colorCode)
      return articleId!
    })
    revalidatePath('/master')
    revalidatePath('/dashboard')
    return { ok: true, articleId }
  } catch (error) {
    if (error instanceof LinkAbort) return error.result
    throw error
  }
}

/** Review progress and data-quality counts for the article master. */
export async function getArticleMasterStatus(): Promise<{ unverified: number; approved: number; needsReview: number; inactive: number; issues: Record<string, number> }> {
  await requirePermission('articles.view')
  const [counts, issues] = await Promise.all([
    db.execute<{ unverified: number; approved: number; needsReview: number; inactive: number }>(sql`
      SELECT count(*) FILTER (WHERE active AND "reviewStatus" = 'unverified')::int AS unverified,
             count(*) FILTER (WHERE active AND "reviewStatus" = 'approved')::int AS approved,
             count(*) FILTER (WHERE active AND "reviewStatus" = 'needs_review')::int AS "needsReview",
             count(*) FILTER (WHERE NOT active)::int AS inactive FROM articles`),
    db.execute<{ issue: string; n: number }>(sql`SELECT issue, count(DISTINCT "articleId")::int AS n FROM article_quality_issues GROUP BY issue`),
  ])
  const c = counts.rows[0]
  return {
    unverified: Number(c?.unverified ?? 0), approved: Number(c?.approved ?? 0), needsReview: Number(c?.needsReview ?? 0), inactive: Number(c?.inactive ?? 0),
    issues: Object.fromEntries(issues.rows.map((r) => [r.issue, Number(r.n)])),
  }
}

// ── Catalogue review queue (conflicts found by catalogue imports) ────────────

export type CatalogReviewItem = {
  id: number
  kind: string
  severity: 'info' | 'review' | 'error'
  artCode: string
  colorCode: string | null
  articleId: number | null
  message: string
  status: CatalogReviewStatus
  resolution: string | null
  createdAt: string
}

/** Open items first; at most 300 rows (one query). */
export async function getCatalogReviewItems(): Promise<CatalogReviewItem[]> {
  await requirePermission('articles.view')
  const rows = await db.select({
    id: catalogReviewItems.id, kind: catalogReviewItems.kind, severity: catalogReviewItems.severity, artCode: catalogReviewItems.artCode,
    colorCode: catalogReviewItems.colorCode, articleId: catalogReviewItems.articleId, message: catalogReviewItems.message,
    status: catalogReviewItems.status, resolution: catalogReviewItems.resolution, createdAt: catalogReviewItems.createdAt,
  }).from(catalogReviewItems)
    .orderBy(sql`CASE ${catalogReviewItems.status} WHEN 'open' THEN 0 ELSE 1 END`, asc(catalogReviewItems.kind), asc(catalogReviewItems.artCode))
    .limit(300)
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
}

/** Admin closes (resolved / dismissed) or re-opens a review item with a note. Data fixes are made in the article editor. */
export async function setCatalogReviewItemStatus(id: number, status: CatalogReviewStatus, note: string): Promise<CatalogReviewItem[]> {
  const u = await requirePermission('articles.review_catalog')
  const text = note.trim()
  if (status !== 'open' && !text) throw new Error('Add a short note saying what was decided.')
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(catalogReviewItems).where(eq(catalogReviewItems.id, id)).for('update')
    if (!before) throw new Error('Review item not found.')
    await tx.update(catalogReviewItems).set({
      status, resolution: text || null,
      resolvedAt: status === 'open' ? null : new Date(), resolvedBy: status === 'open' ? null : u.id,
    }).where(eq(catalogReviewItems.id, id))
    await audit(tx, { actor: actorOf(u), action: `catalog_review.${status}`, entityType: 'catalog_review_item', entityId: id,
      before: { status: before.status, resolution: before.resolution }, after: { status, resolution: text || null }, reason: text || null })
  })
  revalidatePath('/master')
  return getCatalogReviewItems()
}
