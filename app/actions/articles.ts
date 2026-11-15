'use server'

import { db } from '@/lib/db'
import { articles, articleSizes, articleColors, articleMrps, scans, user } from '@/lib/db/schema'
import { asc, sql, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { parseSizeText, normalizeArticleValue, hasArticleNumberMismatch } from '@/lib/article-utils'
import { parseQr, isValidWarehouseQr } from '@/lib/qr-parser'

async function requireAuth() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
}

export type Article = typeof articles.$inferSelect
// Linking is available to signed-in users for now; this becomes admin-only later.
const LINK_ROLES: string[] = []

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


// ── Fetch all articles ────────────────────────────────────────────────────────
export async function getArticles(): Promise<Article[]> {
  await requireAuth()
  return db.select().from(articles).orderBy(asc(articles.artName))
}

// ── Save (upsert) a single article ───────────────────────────────────────────
export async function saveArticle(
  input: Omit<Article, 'id'> & { id?: number; customSizes?: string }
): Promise<Article[]> {
  await requireAuth()

  // Extract customSizes so we don't insert it into articles database table which has no such column
  const { customSizes, ...cleanInput } = input

  try { await db.transaction(async (tx) => {
    let articleId: number

    if (cleanInput.id) {
      await tx
        .insert(articles)
        .values({ ...cleanInput, id: cleanInput.id })
        .onConflictDoUpdate({
          target: articles.id,
          set: {
            artName:   cleanInput.artName,
            artCode:   cleanInput.artCode,
            color:     cleanInput.color,
            colorCode: cleanInput.colorCode,
            maxSize:   cleanInput.maxSize,
            minSize:   cleanInput.minSize,
          },
        })
      articleId = cleanInput.id
    } else {
      const [inserted] = await tx
        .insert(articles)
        .values({ ...cleanInput })
        .returning({ id: articles.id })
      articleId = inserted.id
    }

    // Sync article_colors
    await tx.delete(articleColors).where(eq(articleColors.articleId, articleId))
    if (cleanInput.color.trim()) {
      await tx.insert(articleColors).values({
        articleId,
        colorName: cleanInput.color.trim(),
        colorHex:  cleanInput.colorCode.trim() || null,
      })
    }

    // Sync article_sizes
    const min = parseInt(cleanInput.minSize, 10)
    const max = parseInt(cleanInput.maxSize, 10)
    await tx.delete(articleSizes).where(eq(articleSizes.articleId, articleId))
    
    const sizeLabels = new Set<string>()

    // 1. Process custom sizes if present
    if (customSizes) {
      const customs = customSizes
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      for (const custom of customs) {
        sizeLabels.add(custom)
      }
    }

    // 2. Process sequential size range
    if (!isNaN(min) && !isNaN(max) && min <= max) {
      for (let size = min; size <= max; size++) {
        sizeLabels.add(String(size))
      }
    }

    if (sizeLabels.size > 0) {
      // Sort collected sizes naturally (numerics first, then XS/S/M/L, then alphanumeric strings)
      const sortedLabels = Array.from(sizeLabels).sort((a, b) => {
        const numA = parseInt(a, 10)
        const numB = parseInt(b, 10)
        
        if (!isNaN(numA) && !isNaN(numB)) {
          return numA - numB
        }
        if (!isNaN(numA)) return -1
        if (!isNaN(numB)) return 1
        
        const standardOrder = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '3XL', '4XL']
        const idxA = standardOrder.indexOf(a.toUpperCase())
        const idxB = standardOrder.indexOf(b.toUpperCase())
        
        if (idxA !== -1 && idxB !== -1) {
          return idxA - idxB
        }
        if (idxA !== -1) return -1
        if (idxB !== -1) return 1
        
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      })

      const sizeRows = sortedLabels.map((label, idx) => ({
        articleId,
        sizeLabel: label,
        sortOrder: idx + 1
      }))

      await tx.insert(articleSizes).values(sizeRows)
    }
  }) } catch (error) { friendlyUniqueError(error) }

  return db.select().from(articles).orderBy(asc(articles.artName))
}

// ── Delete a single article ──────────────────────────────────────────────────
export async function deleteArticle(id: number): Promise<Article[]> {
  await requireAuth()
  await db.delete(articles).where(eq(articles.id, id))
  return db.select().from(articles).orderBy(asc(articles.artName))
}

// ── Fetch size labels for a single article ───────────────────────────────────
export async function getArticleSizes(articleId: number): Promise<string[]> {
  await requireAuth()
  const rows = await db
    .select({ sizeLabel: articleSizes.sizeLabel })
    .from(articleSizes)
    .where(eq(articleSizes.articleId, articleId))
    .orderBy(articleSizes.sortOrder)
  return rows.map(r => r.sizeLabel)
}


// ── Bulk import articles from parsed CSV rows ─────────────────────────────────
export async function importArticles(
  rows: Array<Omit<Article, 'id' | 'createdAt' | 'updatedAt'> & { customSizes?: string }>
): Promise<{ imported: number; skipped: number; list: Article[] }> {
  await requireAuth()

  const existing = await db.select().from(articles)
  const fileRows = new Map<string, Omit<Article, 'id' | 'createdAt' | 'updatedAt'> & { customSizes?: string }>()
  const sizeUnion = new Map<string, Set<string>>()
  const keyFor = (row: { artName: string; color: string; artCode: string; colorCode: string }) => {
    const code = normalizeArticleValue(row.artCode), shade = normalizeArticleValue(row.colorCode)
    return code && shade ? `code:${code}||${shade}` : `name:${normalizeArticleValue(row.artName)}||${normalizeArticleValue(row.color)}`
  }
  for (const row of rows) {
    const key = keyFor(row)
    const labels = new Set<string>()
    const explicitSizes = parseSizeText(row.customSizes ?? '')
    if (explicitSizes.length) explicitSizes.forEach(size => labels.add(size))
    else {
      const min = Number.parseInt(row.minSize, 10), max = Number.parseInt(row.maxSize, 10)
      if (Number.isFinite(min) && Number.isFinite(max) && max >= min && max - min <= 100) for (let n = min; n <= max; n++) labels.add(String(n))
    }
    const prior = fileRows.get(key)
    if (prior) {
      const union = sizeUnion.get(key) ?? new Set<string>()
      labels.forEach(label => union.add(label)); sizeUnion.set(key, union)
    } else {
      fileRows.set(key, { ...row, artCode: normalizeArticleValue(row.artCode), colorCode: normalizeArticleValue(row.colorCode) })
      sizeUnion.set(key, labels)
    }
  }
  const codeKeys = new Set(existing.filter(a => normalizeArticleValue(a.artCode) && normalizeArticleValue(a.colorCode)).map(keyFor))
  const nameKeys = new Set(existing.map(a => `name:${normalizeArticleValue(a.artName)}||${normalizeArticleValue(a.color)}`))
  const candidates = [...fileRows.entries()].filter(([key, row]) => {
    const hasCodes = normalizeArticleValue(row.artCode) && normalizeArticleValue(row.colorCode)
    return !((hasCodes ? codeKeys : nameKeys).has(key))
  })
  const newRows = candidates.map(([key, row]) => ({ ...row, customSizes: [...(sizeUnion.get(key) ?? [])].join(',') }))

  // Insert the full CSV in one transaction. Per-row transactions make large
  // imports slow enough to time out before the server action can respond.
  let insertedCount = 0
  try { await db.transaction(async (tx) => {
    const inserted = newRows.length > 0
      ? await tx.insert(articles).values(newRows.map(({ customSizes: _custom, ...row }) => {
          const sizes = [...(sizeUnion.get(keyFor(row)) ?? [])].map(Number).filter(Number.isFinite)
          return { ...row, minSize: sizes.length ? String(Math.min(...sizes)) : '', maxSize: sizes.length ? String(Math.max(...sizes)) : '' }
        })).returning({ id: articles.id })
      : []
    insertedCount = inserted.length

    const colorRows = inserted.flatMap(({ id }, index) => {
      const row = newRows[index]
      return row.color.trim()
        ? [{ articleId: id, colorName: row.color.trim(), colorHex: row.colorCode.trim() || null }]
        : []
    })
    if (colorRows.length > 0) await tx.insert(articleColors).values(colorRows)

    const sizeRows = inserted.flatMap(({ id }, index) => {
      const row = newRows[index]
      const labels = [...(sizeUnion.get(keyFor(row)) ?? [])]
      return labels.map((sizeLabel, offset) => ({
        articleId: id,
        sizeLabel,
        sortOrder: offset + 1,
      }))
    })
    if (sizeRows.length > 0) await tx.insert(articleSizes).values(sizeRows)
  }) } catch (error) { friendlyUniqueError(error) }

  const list = await db.select().from(articles).orderBy(asc(articles.artName))
  return { imported: insertedCount, skipped: rows.length - insertedCount, list }
}

export async function searchArticleNames(query: string): Promise<string[]> {
  await requireAuth()
  const q = normalizeArticleValue(query)
  if (!q) return []
  const rows = await db.selectDistinct({ artName: articles.artName }).from(articles)
    .where(sql`upper(${articles.artName}) LIKE ${`%${q}%`}`).orderBy(asc(articles.artName)).limit(20)
  return rows.map((row) => row.artName)
}

export async function getColoursForName(name: string): Promise<Array<{ colorName: string; hasCodes: boolean }>> {
  await requireAuth()
  const rows = await db.select({ colorName: articleColors.colorName, artCode: articles.artCode, colorCode: articles.colorCode })
    .from(articleColors).innerJoin(articles, eq(articles.id, articleColors.articleId))
    .where(sql`upper(regexp_replace(btrim(${articles.artName}), '\\s+', ' ', 'g')) = ${normalizeArticleValue(name)}`)
  const result = new Map<string, boolean>()
  for (const row of rows) result.set(row.colorName, (result.get(row.colorName) ?? false) || Boolean(normalizeArticleValue(row.artCode) && normalizeArticleValue(row.colorCode)))
  return [...result].map(([colorName, hasCodes]) => ({ colorName, hasCodes }))
}

type LinkResult = { ok: true; articleId: number } | { ok: false; error: 'SIZE_NOT_IN_ARTICLE'; sizes: string[] } | { ok: false; error: 'NUMBER_MISMATCH' | 'DUPLICATE_QR' | 'SIZES_REQUIRED' | 'NAME_REQUIRED' | 'ALREADY_EXISTS' | 'FORBIDDEN' | 'INVALID_QR' }

export async function linkOrCreateArticle(input: {
  rawQr: string; artName: string; colorName: string; sizesText: string; addScannedSize: boolean; confirmWarnings: boolean; notes?: string
}): Promise<LinkResult> {
  try {
    return await linkOrCreateArticleOnce(input)
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    try {
      return await linkOrCreateArticleOnce(input)
    } catch (retryError) {
      if (isUniqueViolation(retryError)) return { ok: false, error: 'ALREADY_EXISTS' }
      throw retryError
    }
  }
}

async function linkOrCreateArticleOnce(input: {
  rawQr: string; artName: string; colorName: string; sizesText: string; addScannedSize: boolean; confirmWarnings: boolean; notes?: string
}): Promise<LinkResult> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return { ok: false, error: 'FORBIDDEN' }
  if (LINK_ROLES.length) {
    const [account] = await db.select({ role: user.role }).from(user).where(eq(user.id, session.user.id)).limit(1)
    const roles = (account?.role ?? '').split(',').map(role => role.trim())
    if (!LINK_ROLES.some(role => roles.includes(role))) return { ok: false, error: 'FORBIDDEN' }
  }
  if (!isValidWarehouseQr(input.rawQr)) return { ok: false, error: 'INVALID_QR' }
  const parsed = parseQr(input.rawQr)
  const artCode = normalizeArticleValue(parsed.articleCode)
  const colorCode = normalizeArticleValue(parsed.colorCode)
  const name = input.artName.trim()
  const color = input.colorName.trim()
  if (!name || !color) return { ok: false, error: 'NAME_REQUIRED' }
  const duplicate = await db.select({ id: scans.id }).from(scans).where(sql`${scans.rawQrCode} = ${input.rawQr} OR ${scans.boxCodes} @> ${JSON.stringify([input.rawQr])}::jsonb`).limit(1)
  if (duplicate.length) return { ok: false, error: 'DUPLICATE_QR' }
  if (!input.confirmWarnings && hasArticleNumberMismatch(name, artCode)) return { ok: false, error: 'NUMBER_MISMATCH' }

  const existingSizes = await db.select({ id: articles.id })
    .from(articles).where(sql`upper(regexp_replace(btrim(${articles.artCode}), '\\s+', ' ', 'g')) = ${artCode} AND upper(regexp_replace(btrim(${articles.colorCode}), '\\s+', ' ', 'g')) = ${colorCode}`).limit(1)
  let sizes: string[] = []
  let articleId: number | undefined = existingSizes[0]?.id
  try { await db.transaction(async (tx) => {
    if (articleId) {
      sizes = (await tx.select({ sizeLabel: articleSizes.sizeLabel }).from(articleSizes).where(eq(articleSizes.articleId, articleId!)).orderBy(articleSizes.sortOrder)).map(r => r.sizeLabel)
      if (!sizes.includes(parsed.size)) {
        if (!input.addScannedSize) throw new Error(`SIZE_NOT_IN_ARTICLE:${JSON.stringify(sizes)}`)
        const [last] = await tx.select({ sortOrder: articleSizes.sortOrder }).from(articleSizes).where(eq(articleSizes.articleId, articleId)).orderBy(sql`${articleSizes.sortOrder} DESC`).limit(1)
        sizes.push(parsed.size)
        await tx.insert(articleSizes).values({ articleId, sizeLabel: parsed.size, sortOrder: (last?.sortOrder ?? 0) + 1 })
        const numeric = sizes.map(Number).filter(Number.isFinite)
        await tx.update(articles).set({ minSize: numeric.length ? String(Math.min(...numeric)) : '', maxSize: numeric.length ? String(Math.max(...numeric)) : '' }).where(eq(articles.id, articleId))
      }
    } else {
      const byName = await tx.select({ id: articles.id, artName: articles.artName, color: articles.color, artCode: articles.artCode, colorCode: articles.colorCode })
        .from(articles).where(sql`upper(regexp_replace(btrim(${articles.artName}), '\\s+', ' ', 'g')) = ${normalizeArticleValue(name)}`)
      const sameColorRows = byName.filter(r => normalizeArticleValue(r.color) === normalizeArticleValue(color))
      const sameColor = sameColorRows.find(r => !normalizeArticleValue(r.artCode) && !normalizeArticleValue(r.colorCode)) ?? sameColorRows[0]
      const blankCode = sameColor && !normalizeArticleValue(sameColor.artCode) && !normalizeArticleValue(sameColor.colorCode) ? sameColor : undefined
      const source = sameColor ?? byName[0]
      const storedName = byName[0]?.artName ?? name
      sizes = source ? (await tx.select({ sizeLabel: articleSizes.sizeLabel }).from(articleSizes).where(eq(articleSizes.articleId, source.id)).orderBy(articleSizes.sortOrder)).map(r => r.sizeLabel) : parseSizeText(input.sizesText)
      if (!source && !parseSizeText(input.sizesText).length) throw new Error('SIZES_REQUIRED')
      if (!sizes.includes(parsed.size)) {
        if (!input.addScannedSize) throw new Error(`SIZE_NOT_IN_ARTICLE:${JSON.stringify(sizes)}`)
        sizes.push(parsed.size)
      }
      if (blankCode) {
        const updated = await tx.update(articles).set({ artCode, colorCode }).where(sql`${articles.id} = ${blankCode.id} AND ${articles.artCode} = '' AND ${articles.colorCode} = ''`).returning({ id: articles.id })
        articleId = updated[0]?.id
      }
      if (!articleId) {
        const min = Math.min(...sizes.map(Number).filter(Number.isFinite))
        const max = Math.max(...sizes.map(Number).filter(Number.isFinite))
        const [inserted] = await tx.insert(articles).values({ artName: storedName, artCode, color, colorCode, minSize: Number.isFinite(min) ? String(min) : '', maxSize: Number.isFinite(max) ? String(max) : '' }).returning({ id: articles.id })
        const insertedArticleId = inserted.id
        articleId = insertedArticleId
        await tx.insert(articleColors).values({ articleId: insertedArticleId, colorName: color, colorHex: colorCode || null })
        if (sizes.length) await tx.insert(articleSizes).values(sizes.map((sizeLabel, idx) => ({ articleId: insertedArticleId, sizeLabel, sortOrder: idx + 1 })))
      } else {
        const linkedArticleId = articleId
        const current = await tx.select({ sizeLabel: articleSizes.sizeLabel }).from(articleSizes).where(eq(articleSizes.articleId, linkedArticleId))
        if (!current.some(row => row.sizeLabel === parsed.size)) {
          const [last] = await tx.select({ sortOrder: articleSizes.sortOrder }).from(articleSizes).where(eq(articleSizes.articleId, linkedArticleId)).orderBy(sql`${articleSizes.sortOrder} DESC`).limit(1)
          await tx.insert(articleSizes).values({ articleId: linkedArticleId, sizeLabel: parsed.size, sortOrder: (last?.sortOrder ?? 0) + 1 })
        }
        const numeric = sizes.map(Number).filter(Number.isFinite)
        await tx.update(articles).set({ minSize: numeric.length ? String(Math.min(...numeric)) : '', maxSize: numeric.length ? String(Math.max(...numeric)) : '' }).where(eq(articles.id, linkedArticleId))
      }
    }
  }) } catch (error) {
    if (error instanceof Error && error.message === 'SIZES_REQUIRED') return { ok: false, error: 'SIZES_REQUIRED' }
    if (error instanceof Error && error.message.startsWith('SIZE_NOT_IN_ARTICLE:')) {
      return { ok: false, error: 'SIZE_NOT_IN_ARTICLE', sizes: JSON.parse(error.message.slice('SIZE_NOT_IN_ARTICLE:'.length)) as string[] }
    }
    throw error
  }
  if (!articleId) throw new Error('Unable to link article')
  if (!sizes.includes(parsed.size)) return { ok: false, error: 'SIZE_NOT_IN_ARTICLE', sizes }
  const scanResult = await recordScanInternal(input.rawQr, input.notes)
  if (!scanResult) return { ok: false, error: 'DUPLICATE_QR' }
  revalidatePath('/master')
  try {
    const historicalMrps = await db.selectDistinct({ mrp: scans.mrp }).from(scans)
      .where(sql`upper(regexp_replace(btrim(${scans.artNumber}), '\\s+', ' ', 'g')) = ${artCode} AND ${scans.mrp} IS NOT NULL`)
    if (historicalMrps.length) await db.insert(articleMrps).values(historicalMrps.map(({ mrp }) => ({ artCode, mrp: mrp! }))).onConflictDoNothing()
  } catch { /* Existing scan price history must not block a successful link. */ }
  return { ok: true, articleId }
}

async function recordScanInternal(rawQr: string, notes?: string) {
  const { recordScan } = await import('./scan')
  const result = await recordScan(rawQr, notes)
  return result.ok ? result.data : null
}
