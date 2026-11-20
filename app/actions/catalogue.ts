'use server'

import { db } from '@/lib/db'
import { articles, articleColors, articleSizes } from '@/lib/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { searchVendors, getVendors } from '@/app/actions/vendors'
import { fuzzyScore } from '@/lib/fuzzy'

import { requirePermission } from '@/lib/authz'

async function requireAuth() {
  return requirePermission('articles.view')
}

// ── Shopkeeper search (backed by vendors DB table) ────────────────────────────

export interface ShopkeeperResult {
  id: number
  name: string
  code: string | null
  phone: string | null
  address: string | null
}

export async function searchShopkeepers(query: string): Promise<ShopkeeperResult[]> {
  await requireAuth()
  const rows = await searchVendors(query)
  return rows.map(v => ({
    id: 0,                         // unused — orders store shopkeeperName as text
    name: v.partyName,
    code: v.area || null,
    phone: v.phone || null,
    address: [v.address, v.city].filter(Boolean).join(', ') || null,
  }))
}

// ── Article search — returns DISTINCT artName only ───────────────────────────
// Each artName may have multiple rows (one per color). We deduplicate here
// so the search dropdown shows each article name exactly once.

export interface ArticleResult {
  artNumber: string  // unique article name (artName column)
}

export async function searchArticles(query: string): Promise<ArticleResult[]> {
  await requireAuth()
  const q = query.trim()

  if (!q) {
    const rows = await db.execute(sql`
      SELECT DISTINCT "artName" AS "artNumber"
      FROM articles
      WHERE active
      ORDER BY "artName" ASC
      LIMIT 20
    `)
    return (rows.rows as unknown[]).map(r => ({ artNumber: (r as Record<string, unknown>).artNumber as string }))
  }

  // Broad substring fetch for the DB pass
  const rows = await db.execute(sql`
    SELECT DISTINCT "artName" AS "artNumber"
    FROM articles
    WHERE active AND lower("artName") LIKE ${'%' + q.toLowerCase() + '%'}
    LIMIT 100
  `)
  const candidates = (rows.rows as unknown[]).map(r => (r as Record<string, unknown>).artNumber as string)

  // Also fetch a wider set so typos that don't substring-match still appear
  const wider = await db.execute(sql`
    SELECT DISTINCT "artName" AS "artNumber"
    FROM articles
    WHERE active
    ORDER BY "artName" ASC
    LIMIT 300
  `)
  const widerNames = (wider.rows as unknown[]).map(r => (r as Record<string, unknown>).artNumber as string)

  // Merge unique, score with fuzzy, return top 20
  const seen = new Set<string>()
  const all = [...candidates, ...widerNames].filter(n => {
    if (seen.has(n)) return false
    seen.add(n)
    return true
  })

  const scored = all
    .map(artNumber => ({ artNumber, score: fuzzyScore(artNumber, q) }))
    .filter(x => x.score < Infinity)
    .sort((a, b) => a.score !== b.score ? a.score - b.score : a.artNumber.localeCompare(b.artNumber))

  return scored.slice(0, 20).map(x => ({ artNumber: x.artNumber }))
}

// ── Article detail — all colors + sizes for a given artName ──────────────────
// Because artName has N rows (one per color), we fetch all matching article ids
// then aggregate their colors and sizes into a single detail object.
// The "id" returned is the first article id (used as a stable key only).

export interface ArticleDetail {
  id: number        // id of first article row for this artName (stable key)
  artNumber: string // the artName
  colors: { id: number; articleId: number; colorName: string; colorHex: string | null }[]
  /**
   * Sizes per colour (articleId = the colour's representative variant). When one colour of this name
   * spans several article codes (SS-101 Black: SS0101C 11–13, 1 · SS0101G 6–10 · SS0101S 11–12),
   * `key` is "CODE:size" so the children's 11 and the big 11 stay apart; otherwise key = sizeLabel.
   */
  sizes: { id: number; articleId: number; sizeLabel: string; sortOrder: number; artCode: string; key: string }[]
}

export async function getArticleDetailByName(artName: string): Promise<ArticleDetail | null> {
  await requireAuth()

  // All article rows for this artName (one per color)
  const artRows = await db
    .select({ id: articles.id, artName: articles.artName, artCode: articles.artCode })
    .from(articles)
    .where(and(eq(articles.artName, artName), eq(articles.active, true)))
    .orderBy(asc(articles.artCode), asc(articles.id))

  if (artRows.length === 0) return null

  const ids = artRows.map(r => r.id)

  // Use raw SQL with explicit int[] cast to avoid type mismatch errors
  const idList = ids.join(',')

  const [colorsRes, sizesRes] = await Promise.all([
    db.execute(sql.raw(`
      SELECT id, "articleId", "colorName", "colorHex"
      FROM article_colors
      WHERE "articleId" = ANY(ARRAY[${idList}]::int[])
      ORDER BY "articleId" ASC, id ASC
    `)),
    db.execute(sql.raw(`
      SELECT id, "articleId", "sizeLabel", "sortOrder"
      FROM article_sizes
      WHERE "articleId" = ANY(ARRAY[${idList}]::int[]) AND active
      ORDER BY "articleId" ASC, "sortOrder" ASC
    `)),
  ])

  const byArt = <T extends { articleId: number }>(rows: T[]) => {
    const m = new Map<number, T[]>()
    for (const r of rows) { const k = Number(r.articleId); if (!m.has(k)) m.set(k, []); m.get(k)!.push({ ...r, articleId: k }) }
    return m
  }
  return groupArticles(artRows, byArt(colorsRes.rows as ColourRow[]), byArt(sizesRes.rows as SizeRow[])).get(artName) ?? null
}

// ── Legacy compat — used by edit-order flow (load by artName string) ──────────
export async function getArticleDetailByNumber(artNumber: string): Promise<ArticleDetail | null> {
  return getArticleDetailByName(artNumber)
}

// ── Load detail by a specific article row id (used when editing order lines) ──
export async function getArticleDetail(articleId: number): Promise<ArticleDetail | null> {
  await requireAuth()
  const [row] = await db
    .select({ artName: articles.artName })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1)
  if (!row) return null
  return getArticleDetailByName(row.artName)
}

type ColourRow = { id: number; articleId: number; colorName: string; colorHex: string | null }
type SizeRow = { id: number; articleId: number; sizeLabel: string; sortOrder: number }

/** Shared by the bulk catalogue and the single-article loader. Pure (no queries). */
function groupArticles(
  artRows: { id: number; artName: string; artCode: string }[],
  colorsByArt: Map<number, ColourRow[]>,
  sizesByArt: Map<number, SizeRow[]>,
): Map<string, ArticleDetail> {
// One ArticleDetail per article name. Colours are merged by name; each colour keeps the sizes of
// every code it comes in, keyed per code when there is more than one code.
const normalizedLabel = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
const artDetailMap = new Map<string, ArticleDetail>()
type Group = { rep: number; variants: { id: number; artCode: string }[] }
const groupsByName = new Map<string, Map<string, Group>>()
for (const row of artRows) {
  if (!artDetailMap.has(row.artName)) artDetailMap.set(row.artName, { id: row.id, artNumber: row.artName, colors: [], sizes: [] })
  const detail = artDetailMap.get(row.artName)!
  if (!groupsByName.has(row.artName)) groupsByName.set(row.artName, new Map())
  const groups = groupsByName.get(row.artName)!
  const colours = colorsByArt.get(row.id) ?? []
  if (!colours.length) {
    // No colour configured: its sizes hang on the variant itself.
    groups.set(`#${row.id}`, { rep: row.id, variants: [{ id: row.id, artCode: row.artCode }] })
    continue
  }
  for (const c of colours) {
    const key = normalizedLabel(c.colorName)
    const g = groups.get(key)
    if (!g) { groups.set(key, { rep: c.articleId, variants: [{ id: row.id, artCode: row.artCode }] }); detail.colors.push(c) }
    else if (!g.variants.some(v => v.id === row.id)) g.variants.push({ id: row.id, artCode: row.artCode })
  }
}
for (const [name, groups] of groupsByName) {
  const detail = artDetailMap.get(name)!
  for (const g of groups.values()) {
    const multi = new Set(g.variants.map(v => v.artCode.trim().toUpperCase())).size > 1
    const seen = new Set<string>()
    const rows: ArticleDetail['sizes'] = []
    for (const v of g.variants) {
      for (const sz of sizesByArt.get(v.id) ?? []) {
        const key = multi ? `${v.artCode.trim().toUpperCase()}:${sz.sizeLabel}` : sz.sizeLabel
        if (seen.has(normalizedLabel(key))) continue
        seen.add(normalizedLabel(key))
        rows.push({ id: sz.id, articleId: g.rep, sizeLabel: sz.sizeLabel, sortOrder: sz.sortOrder, artCode: v.artCode.trim().toUpperCase(), key })
      }
    }
    // Codes in a sensible order: children's runs (with sizes 1–5) first, then by smallest size
    // (6–10 before big 11–12); sizes in chart order inside each code.
    const rank = new Map<string, number>()
    for (const code of new Set(rows.map(r => r.artCode))) {
      const nums = rows.filter(r => r.artCode === code).map(r => Number(r.sizeLabel)).filter(n => Number.isFinite(n))
      const kids = nums.some(n => n >= 1 && n <= 5)
      rank.set(code, (kids ? 0 : 1000) + (nums.length ? Math.min(...nums) : 999))
    }
    rows.sort((a, b) => (multi ? (rank.get(a.artCode)! - rank.get(b.artCode)!) || a.artCode.localeCompare(b.artCode) : 0)
      || a.sortOrder - b.sortOrder || a.sizeLabel.localeCompare(b.sizeLabel, undefined, { numeric: true }))
    detail.sizes.push(...rows)
  }
}
  return artDetailMap
}

// ── Bulk catalogue — load everything once for client-side search ──────────────

export interface CatalogueVendor {
  id: string
  name: string
  code: string | null
  phone: string | null
  address: string | null
}

export interface CatalogueData {
  vendors: CatalogueVendor[]
  articles: ArticleDetail[]
}

export async function loadCatalogue(): Promise<CatalogueData> {
  await requireAuth()

  // All vendors (active) and all article data in parallel
  const [vendorRows, artRows, colorRows, sizeRows] = await Promise.all([
    getVendors(),
    db.select({ id: articles.id, artName: articles.artName, artCode: articles.artCode }).from(articles).where(eq(articles.active, true)).orderBy(asc(articles.artName), asc(articles.artCode), asc(articles.id)),
    db.select({ id: articleColors.id, articleId: articleColors.articleId, colorName: articleColors.colorName, colorHex: articleColors.colorHex }).from(articleColors).orderBy(asc(articleColors.articleId), asc(articleColors.id)),
    db.select({ id: articleSizes.id, articleId: articleSizes.articleId, sizeLabel: articleSizes.sizeLabel, sortOrder: articleSizes.sortOrder }).from(articleSizes).where(eq(articleSizes.active, true)).orderBy(asc(articleSizes.articleId), asc(articleSizes.sortOrder)),
  ])

  // Group colors and sizes by articleId
  const colorsByArt = new Map<number, { id: number; articleId: number; colorName: string; colorHex: string | null }[]>()
  for (const c of colorRows) {
    if (!colorsByArt.has(c.articleId)) colorsByArt.set(c.articleId, [])
    colorsByArt.get(c.articleId)!.push(c)
  }
  const sizesByArt = new Map<number, { id: number; articleId: number; sizeLabel: string; sortOrder: number }[]>()
  for (const s of sizeRows) {
    if (!sizesByArt.has(s.articleId)) sizesByArt.set(s.articleId, [])
    sizesByArt.get(s.articleId)!.push(s)
  }

  const artDetailMap = groupArticles(artRows, colorsByArt, sizesByArt)

  const vendors: CatalogueVendor[] = vendorRows
    .filter(v => v.status === 'active')
    .map(v => ({
      id: v.id,
      name: v.partyName,
      code: v.area || null,
      phone: v.phone || null,
      address: [v.address, v.city].filter(Boolean).join(', ') || null,
    }))

  return { vendors, articles: Array.from(artDetailMap.values()) }
}

