// Apply an approved catalogue (WorkbookModel) to the database.
//
//   loadCatalogState()   reads the current catalogue (8 queries, run once).
//   planCatalogImport()  pure diff: what would be created, updated, re-activated or retired.
//   applyCatalogImport() writes the plan in ONE transaction with set-based statements
//                        (~15 statements regardless of row count), plus audit rows.
//
// Rules (docs/architecture/article-catalogue.md):
//  - Variants are matched ONLY on normalised article code + colour code. Never on names.
//  - Matched variants keep their id; scans, SKUs, MRP history and stock stay linked.
//  - SKUs are never deleted: sizes missing from the catalogue are deactivated.
//  - In-scope variants absent from the catalogue are retired (active = false), never deleted.
//  - Rows outside the catalogue's scope (other brands) are not touched.
//  - Conflicts become catalog_review_items; nothing is silently chosen or merged.
//  - Re-running with the same workbook changes nothing.

import { sql } from 'drizzle-orm'
import type { Actor, Db, DbOrTx } from '@/lib/db/types'
import { resolvePendingScans } from '@/lib/inventory/scan-service'
import { normaliseSizeLabel } from './sizes'
import { bumpCatalogueVersion } from './version'
import { colourKey, hasSparxCodeOutsideScope, isSparxScope, normCode, type CatalogIssue, type VariantSpec, type WorkbookModel } from './sparx-workbook'

// ── Current state ──────────────────────────────────────────────────────────

export interface DbVariant {
  id: number; artName: string; artCode: string; colorCode: string; color: string; active: boolean
  reviewStatus: string; catalogArticleId: number | null; minSize: string; maxSize: string; retiredAt: string | null
}
export interface DbSku { id: number; articleId: number; sizeLabel: string; active: boolean; sortOrder: number }
export interface DbRange { id: number; articleId: number; minSize: string; maxSize: string; active: boolean }
export interface DbCatalogArticle { id: number; artCode: string; artName: string; active: boolean; reviewStatus: string }
export interface DbColour { id: number; articleId: number; colorName: string }

export interface CatalogState {
  variants: DbVariant[]
  skus: DbSku[]
  ranges: DbRange[]
  catalogArticles: DbCatalogArticle[]
  colours: DbColour[]
  scansByArticle: Map<number, number>
  stockByArticle: Map<number, number>
  stockBySku: Map<number, number>
  linksByArticle: Map<number, number>
  pendingScanKeys: Set<string>
  /** Open review items raised by a workbook (kinds in SOURCE_ISSUE_KINDS). */
  openSourceIssues: number
}

/** Review-item kinds that describe the source workbook itself (not the database). */
export const SOURCE_ISSUE_KINDS = ['invalid_row', 'invalid_size_range', 'range_overlap', 'colour_name_conflict', 'code_has_several_names', 'name_code_mismatch', 'same_colour_name_different_code']

export interface PlanOptions {
  /**
   * The owner has declared the source correct (18 Nov 2026: "assume the article data has no
   * mistakes"). Source conflicts are still reported, but variants are approved, no review items
   * are raised for them, and open ones are closed with that decision as the reason.
   */
  trustSource?: boolean
}

const rows = <T>(r: { rows: unknown[] }) => r.rows as T[]
const toMap = (list: { id: number | string; n: number | string }[]) => new Map(list.map(r => [Number(r.id), Number(r.n)]))

/**
 * Reads the catalogue. Works on older schemas too (read-only dry runs against a database that
 * has not had migrations 0001–0003 yet): missing tables read as empty, missing columns as defaults.
 */
export async function loadCatalogState(db: DbOrTx): Promise<CatalogState> {
  const meta = (await db.execute(sql`
    SELECT
      (SELECT array_agg(column_name::text) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'articles') AS cols,
      (SELECT array_agg(column_name::text) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'article_sizes') AS "sizeCols",
      to_regclass('article_size_ranges') IS NOT NULL AS ranges, to_regclass('catalog_articles') IS NOT NULL AS cats,
      to_regclass('scan_events') IS NOT NULL AS scans, to_regclass('stock_balances') IS NOT NULL AS stock,
      to_regclass('article_scan_links') IS NOT NULL AS links, to_regclass('catalog_review_items') IS NOT NULL AS reviews`)).rows[0] as { cols: string[]; sizeCols: string[]; ranges: boolean; cats: boolean; scans: boolean; stock: boolean; links: boolean; reviews: boolean }
  const col = (name: string, fallback: string) => sql.raw(meta.cols.includes(name) ? `"${name}"` : `${fallback} AS "${name}"`)
  const sizeActive = sql.raw(meta.sizeCols.includes('active') ? 'active' : 'true AS active')
  // Sequential on purpose: inside a transaction all statements share one connection.
  const q = (cond: boolean, s: ReturnType<typeof sql>) => (cond ? db.execute(s) : Promise.resolve({ rows: [] as unknown[] }))
  const variants = await q(true, sql`SELECT id, "artName", "artCode", "colorCode", color, ${col('active', 'true')}, ${col('reviewStatus', `'unverified'`)}, ${col('catalogArticleId', 'NULL::int')}, "minSize", "maxSize", ${col('retiredAt', 'NULL::timestamptz')} FROM articles`)
  const skus = await q(true, sql`SELECT id, "articleId", "sizeLabel", ${sizeActive}, "sortOrder" FROM article_sizes`)
  const ranges = await q(meta.ranges, sql`SELECT id, "articleId", "minSize", "maxSize", active FROM article_size_ranges`)
  const cats = await q(meta.cats, sql`SELECT id, "artCode", "artName", active, "reviewStatus" FROM catalog_articles`)
  const colours = await q(true, sql`SELECT id, "articleId", "colorName" FROM article_colors ORDER BY id`)
  const scans = await q(meta.scans, sql`SELECT "articleId" AS id, count(*) AS n FROM scan_events WHERE "articleId" IS NOT NULL GROUP BY 1`)
  const stock = await q(meta.stock, sql`SELECT s."articleId" AS id, sum(abs(b.quantity)) AS n FROM stock_balances b JOIN article_sizes s ON s.id = b."skuId" GROUP BY 1`)
  const skuStock = await q(meta.stock, sql`SELECT "skuId" AS id, sum(abs(quantity)) AS n FROM stock_balances GROUP BY 1`)
  const links = await q(meta.links, sql`SELECT "articleId" AS id, count(*) AS n FROM article_scan_links GROUP BY 1`)
  const pending = await q(meta.scans, sql`SELECT DISTINCT "articleCode", "colourCode" FROM scan_events WHERE status = 'active' AND resolution <> 'resolved' AND "articleCode" IS NOT NULL`)
  const openSource = await q(meta.reviews, sql`SELECT count(*)::int AS n FROM catalog_review_items WHERE status = 'open' AND kind IN (SELECT json_array_elements_text(${JSON.stringify(SOURCE_ISSUE_KINDS)}::json))`)
  return {
    variants: rows<DbVariant>(variants).map(v => ({ ...v, id: Number(v.id), catalogArticleId: v.catalogArticleId == null ? null : Number(v.catalogArticleId) })),
    skus: rows<DbSku>(skus).map(s => ({ ...s, id: Number(s.id), articleId: Number(s.articleId), sortOrder: Number(s.sortOrder) })),
    ranges: rows<DbRange>(ranges).map(r => ({ ...r, id: Number(r.id), articleId: Number(r.articleId) })),
    catalogArticles: rows<DbCatalogArticle>(cats).map(c => ({ ...c, id: Number(c.id) })),
    colours: rows<DbColour>(colours).map(c => ({ ...c, id: Number(c.id), articleId: Number(c.articleId) })),
    scansByArticle: toMap(rows(scans)),
    stockByArticle: toMap(rows(stock)),
    stockBySku: toMap(rows(skuStock)),
    linksByArticle: toMap(rows(links)),
    pendingScanKeys: new Set(rows<{ articleCode: string; colourCode: string }>(pending).map(p => `${normCode(p.articleCode)}|${normCode(p.colourCode)}`)),
    openSourceIssues: Number(rows<{ n: number }>(openSource)[0]?.n ?? 0),
  }
}

// ── Plan ───────────────────────────────────────────────────────────────────

export interface ReviewItemInput {
  kind: string
  severity: 'info' | 'review' | 'error'
  subjectKey: string
  artCode: string
  colorCode: string | null
  /** Variant key (ART|COLOUR) or a known article id. */
  variantKey?: string
  articleId?: number
  message: string
  details?: Record<string, unknown>
}

export interface VariantWrite {
  key: string
  artName: string
  color: string
  minSize: string
  maxSize: string
  reviewStatus: 'approved' | 'needs_review'
}

export interface ImportPlan {
  articles: {
    upsert: { artCode: string; artName: string; segmentHint: string | null; reviewStatus: 'approved' | 'needs_review' }[]
    created: string[]
    renamed: { artCode: string; from: string; to: string }[]
  }
  variants: {
    create: VariantWrite[]
    update: (VariantWrite & { id: number; before: Partial<DbVariant>; reactivated: boolean })[]
    unchanged: number
    matched: number
  }
  colours: { insert: { key: string; name: string }[]; update: { id: number; from: string; to: string }[] }
  ranges: { upsert: { key: string; min: string; max: string; sizes: string[] }[]; deactivate: number[] }
  skus: {
    create: { key: string; label: string; sortOrder: number }[]
    update: { id: number; label: string; sortOrder: number; active: true; was: { label: string; sortOrder: number; active: boolean } }[]
    deactivate: { id: number; articleId: number; label: string; stock: number }[]
  }
  retire: { id: number; artCode: string; colorCode: string; artName: string; color: string; scans: number; stock: number; links: number }[]
  outOfScope: { variants: number; active: number; byFamily: Record<string, number> }
  possibleMatches: { id: number; artName: string; color: string; candidates: string[] }[]
  reviewItems: ReviewItemInput[]
  pendingToResolve: string[]
  /** trustSource: open source-conflict review items will be closed. */
  closeSourceIssues: boolean
  trustSource: boolean
  isNoop: boolean
}

const family = (name: string) => name.toUpperCase().split('-')[0].trim() || '(blank)'

function variantWrite(v: VariantSpec, artName: string, trust: boolean): VariantWrite {
  return {
    key: v.key, artName, color: v.displayColor,
    minSize: v.sizes[0]?.label ?? '', maxSize: v.sizes[v.sizes.length - 1]?.label ?? '',
    reviewStatus: v.needsReview && !trust ? 'needs_review' : 'approved',
  }
}

function issueSubject(i: CatalogIssue): string {
  const extra = Array.isArray(i.details?.ranges) ? `|${(i.details!.ranges as string[]).join(',')}` : ''
  return `${i.artCode}|${i.colorCode ?? ''}${extra}`
}

export function planCatalogImport(model: WorkbookModel, state: CatalogState, opts: PlanOptions = {}): ImportPlan {
  const trust = Boolean(opts.trustSource)
  const status = (needsReview: boolean): 'approved' | 'needs_review' => (needsReview && !trust ? 'needs_review' : 'approved')
  const artByCode = new Map(model.articles.map(a => [a.artCode, a]))
  const dbByKey = new Map<string, DbVariant>()
  for (const v of state.variants) {
    const code = normCode(v.artCode), colour = normCode(v.colorCode)
    if (code && colour) dbByKey.set(`${code}|${colour}`, v)
  }
  const catByCode = new Map(state.catalogArticles.map(c => [c.artCode, c]))

  // Articles (code level)
  const upsert = model.articles.map(a => ({ artCode: a.artCode, artName: a.artName, segmentHint: a.segmentHint, reviewStatus: status(a.needsReview) }))
  const created = model.articles.filter(a => !catByCode.has(a.artCode)).map(a => a.artCode)
  const renamed = model.articles.flatMap(a => {
    const c = catByCode.get(a.artCode)
    return c && c.artName !== a.artName ? [{ artCode: a.artCode, from: c.artName, to: a.artName }] : []
  })
  const articleChanged = created.length > 0 || renamed.length > 0 || model.articles.some(a => {
    const c = catByCode.get(a.artCode)
    return c && (!c.active || c.reviewStatus !== status(a.needsReview))
  })

  // Variants
  const create: VariantWrite[] = []
  const update: ImportPlan['variants']['update'] = []
  let unchanged = 0
  const matchedIds = new Set<number>()
  for (const v of model.variants) {
    const w = variantWrite(v, artByCode.get(v.artCode)!.artName, trust)
    const db = dbByKey.get(v.key)
    if (!db) { create.push(w); continue }
    matchedIds.add(db.id)
    const catId = catByCode.get(v.artCode)?.id ?? null
    const same = db.artName === w.artName && db.color === w.color && db.minSize === w.minSize && db.maxSize === w.maxSize
      && db.reviewStatus === w.reviewStatus && db.active && db.retiredAt == null && db.catalogArticleId != null && db.catalogArticleId === catId
      && db.artCode === v.artCode && db.colorCode === v.colorCode
    if (same) { unchanged++; continue }
    update.push({ ...w, id: db.id, reactivated: !db.active, before: { artName: db.artName, artCode: db.artCode, colorCode: db.colorCode, color: db.color, minSize: db.minSize, maxSize: db.maxSize, reviewStatus: db.reviewStatus, active: db.active, retiredAt: db.retiredAt } })
  }

  // Colours (article_colors drives the order-booking colour list)
  const coloursByArticle = new Map<number, DbColour[]>()
  for (const c of state.colours) coloursByArticle.set(c.articleId, [...(coloursByArticle.get(c.articleId) ?? []), c])
  const colourInsert: ImportPlan['colours']['insert'] = []
  const colourUpdate: ImportPlan['colours']['update'] = []
  for (const v of model.variants) {
    const db = dbByKey.get(v.key)
    const list = db ? coloursByArticle.get(db.id) ?? [] : []
    if (!list.length) colourInsert.push({ key: v.key, name: v.displayColor })
    else if (list[0].colorName !== v.displayColor) colourUpdate.push({ id: list[0].id, from: list[0].colorName, to: v.displayColor })
  }

  // Ranges
  const rangesByArticle = new Map<number, DbRange[]>()
  for (const r of state.ranges) rangesByArticle.set(r.articleId, [...(rangesByArticle.get(r.articleId) ?? []), r])
  const rangeUpsert: ImportPlan['ranges']['upsert'] = []
  const rangeDeactivate: number[] = []
  for (const v of model.variants) {
    const db = dbByKey.get(v.key)
    const existing = db ? rangesByArticle.get(db.id) ?? [] : []
    for (const r of v.ranges) {
      const e = existing.find(x => x.minSize === r.min && x.maxSize === r.max)
      if (!e || !e.active) rangeUpsert.push({ key: v.key, min: r.min, max: r.max, sizes: r.sizes })
    }
    for (const e of existing) if (e.active && !v.ranges.some(r => r.min === e.minSize && r.max === e.maxSize)) rangeDeactivate.push(e.id)
  }

  // SKUs
  const skusByArticle = new Map<number, DbSku[]>()
  for (const s of state.skus) skusByArticle.set(s.articleId, [...(skusByArticle.get(s.articleId) ?? []), s])
  const skuCreate: ImportPlan['skus']['create'] = []
  const skuUpdate: ImportPlan['skus']['update'] = []
  const skuDeactivate: ImportPlan['skus']['deactivate'] = []
  for (const v of model.variants) {
    const db = dbByKey.get(v.key)
    const existing = db ? skusByArticle.get(db.id) ?? [] : []
    const used = new Set<number>()
    for (const s of v.sizes) {
      const e = existing.find(x => x.sizeLabel === s.label) ?? existing.find(x => !used.has(x.id) && normaliseSizeLabel(x.sizeLabel) === s.label)
      if (!e) { skuCreate.push({ key: v.key, label: s.label, sortOrder: s.sortOrder }); continue }
      used.add(e.id)
      if (e.sizeLabel !== s.label || e.sortOrder !== s.sortOrder || !e.active) {
        skuUpdate.push({ id: e.id, label: s.label, sortOrder: s.sortOrder, active: true, was: { label: e.sizeLabel, sortOrder: e.sortOrder, active: e.active } })
      }
    }
    for (const e of existing) {
      if (!used.has(e.id) && e.active) skuDeactivate.push({ id: e.id, articleId: e.articleId, label: e.sizeLabel, stock: state.stockBySku.get(e.id) ?? 0 })
    }
  }

  // Retire in-scope variants that are not in the catalogue; leave other brands alone.
  const retire: ImportPlan['retire'] = []
  const outOfScope = { variants: 0, active: 0, byFamily: {} as Record<string, number> }
  const namesInCatalogue = new Map<string, VariantSpec[]>()
  for (const v of model.variants) {
    const n = artByCode.get(v.artCode)!.artName.toUpperCase()
    namesInCatalogue.set(n, [...(namesInCatalogue.get(n) ?? []), v])
  }
  const possibleMatches: ImportPlan['possibleMatches'] = []
  const brandCodeMismatch: DbVariant[] = []
  for (const v of state.variants) {
    if (matchedIds.has(v.id)) continue
    if (!isSparxScope(v.artCode, v.artName)) {
      outOfScope.variants++
      if (v.active) outOfScope.active++
      const f = family(v.artName)
      outOfScope.byFamily[f] = (outOfScope.byFamily[f] ?? 0) + 1
      if (v.active && hasSparxCodeOutsideScope(v.artCode, v.artName)) brandCodeMismatch.push(v)
      continue
    }
    if (!v.active) continue
    retire.push({ id: v.id, artCode: v.artCode, colorCode: v.colorCode, artName: v.artName, color: v.color,
      scans: state.scansByArticle.get(v.id) ?? 0, stock: state.stockByArticle.get(v.id) ?? 0, links: state.linksByArticle.get(v.id) ?? 0 })
    // Candidate replacements: same article name AND same colour name. Reported, never merged.
    const cands = (namesInCatalogue.get(v.artName.trim().toUpperCase()) ?? []).filter(c => c.colorNames.some(n => colourKey(n) === colourKey(v.color)))
    if (cands.length) possibleMatches.push({ id: v.id, artName: v.artName, color: v.color, candidates: cands.map(c => c.key) })
  }

  // Review queue
  const reviewItems: ReviewItemInput[] = model.issues
    .filter(i => i.severity !== 'info' && !trust)
    .map(i => ({ kind: i.kind, severity: i.severity, subjectKey: issueSubject(i), artCode: i.artCode, colorCode: i.colorCode,
      variantKey: i.colorCode && !i.colorCode.includes(',') ? `${i.artCode}|${i.colorCode}` : undefined,
      message: i.message, details: { ...i.details, rows: i.rowNumbers } }))
  for (const r of retire) {
    if (r.scans || r.stock || r.links) {
      reviewItems.push({ kind: 'retired_variant_in_use', severity: 'review', subjectKey: `variant:${r.id}`, artCode: r.artCode, colorCode: r.colorCode || null, articleId: r.id,
        message: `"${r.artName} ${r.color}" (${r.artCode || 'no code'} ${r.colorCode || 'no colour code'}) is not in the approved catalogue and was retired, but it has ${r.scans} scan(s), ${r.stock} pair(s) in stock and ${r.links} scan link(s). History is kept; decide whether to re-activate it or move its stock.`,
        details: { scans: r.scans, stock: r.stock, links: r.links } })
    }
  }
  for (const v of brandCodeMismatch) {
    reviewItems.push({ kind: 'brand_code_mismatch', severity: 'review', subjectKey: `variant:${v.id}`, artCode: normCode(v.artCode), colorCode: normCode(v.colorCode) || null, articleId: v.id,
      message: `"${v.artName} ${v.color}" is not a Sparx article but has the Sparx-format code ${normCode(v.artCode)}${v.colorCode ? ` ${normCode(v.colorCode)}` : ''}. Left unchanged; check the code.` })
  }
  for (const s of skuDeactivate) {
    if (s.stock) {
      reviewItems.push({ kind: 'retired_size_in_use', severity: 'review', subjectKey: `sku:${s.id}`, artCode: '', colorCode: null, articleId: s.articleId,
        message: `Size ${s.label} of variant ${s.articleId} is not in the approved catalogue and was deactivated, but ${s.stock} pair(s) are in stock.`, details: { skuId: s.id, stock: s.stock } })
    }
  }

  const pendingToResolve = model.variants.map(v => v.key).filter(k => state.pendingScanKeys.has(k))

  const closeSourceIssues = trust && state.openSourceIssues > 0
  const isNoop = !closeSourceIssues && !articleChanged && !create.length && !update.length && !colourInsert.length && !colourUpdate.length
    && !rangeUpsert.length && !rangeDeactivate.length && !skuCreate.length && !skuUpdate.length && !skuDeactivate.length && !retire.length

  return {
    articles: { upsert, created, renamed },
    variants: { create, update, unchanged, matched: matchedIds.size },
    colours: { insert: colourInsert, update: colourUpdate },
    ranges: { upsert: rangeUpsert, deactivate: rangeDeactivate },
    skus: { create: skuCreate, update: skuUpdate, deactivate: skuDeactivate },
    retire, outOfScope, possibleMatches, reviewItems, pendingToResolve, closeSourceIssues, trustSource: trust, isNoop,
  }
}

// ── Apply ──────────────────────────────────────────────────────────────────

export interface ApplyInput {
  source: string
  fileName: string
  fileSha256: string
  sheetName: string
  brand: string
  trustSource?: boolean
}

export interface ApplyResult {
  batchId: number | null
  noop: boolean
  counts: Record<string, number>
  scansResolved: number
}

const J = (v: unknown) => JSON.stringify(v)

export async function applyCatalogImport(db: Db, actor: Actor, model: WorkbookModel, input: ApplyInput): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    // Serialise catalogue imports and keep the plan consistent with what we write.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('catalog_import'))`)
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`)
    const state = await loadCatalogState(tx)
    const plan = planCatalogImport(model, state, { trustSource: input.trustSource })
    if (plan.isNoop) return { batchId: null, noop: true, counts: {}, scansResolved: 0 }

    const [batch] = rows<{ id: number }>(await tx.execute(sql`
      INSERT INTO catalog_import_batches (source, "fileName", "fileSha256", "sheetName", "rowCount", "appliedBy", "appliedByName")
      VALUES (${input.source}, ${input.fileName}, ${input.fileSha256}, ${input.sheetName}, ${model.rows.length}, ${actor.id}, ${actor.name})
      RETURNING id`))
    const batchId = Number(batch.id)

    // 1. Articles (code level): upsert all codes in the catalogue.
    const catRows = rows<{ id: number; artCode: string }>(await tx.execute(sql`
      INSERT INTO catalog_articles ("artCode", "artName", brand, "segmentHint", "reviewStatus", source, active)
      SELECT x."artCode", x."artName", ${input.brand}, x."segmentHint", x."reviewStatus", 'import', true
      FROM json_to_recordset(${J(plan.articles.upsert)}::json) AS x("artCode" text, "artName" text, "segmentHint" text, "reviewStatus" text)
      ON CONFLICT ("artCode") DO UPDATE SET "artName" = excluded."artName", brand = excluded.brand, "segmentHint" = excluded."segmentHint",
        "reviewStatus" = excluded."reviewStatus", active = true, "updatedAt" = now()
      RETURNING id, "artCode"`))
    const catId = new Map(catRows.map(r => [r.artCode, Number(r.id)]))
    const withCat = (key: string) => catId.get(key.split('|')[0]) ?? null

    // 2. Variants: update matched rows in place (ids kept), insert new ones.
    if (plan.variants.update.length) {
      await tx.execute(sql`
        UPDATE articles a SET "artName" = x."artName", "artCode" = split_part(x.key, '|', 1), "colorCode" = split_part(x.key, '|', 2),
          color = x.color, "minSize" = x."minSize", "maxSize" = x."maxSize", "reviewStatus" = x."reviewStatus",
          "catalogArticleId" = x."catalogArticleId", active = true, "retiredAt" = NULL, "retiredReason" = NULL
        FROM json_to_recordset(${J(plan.variants.update.map(u => ({ ...u, before: undefined, catalogArticleId: withCat(u.key) })))}::json)
          AS x(id int, key text, "artName" text, color text, "minSize" text, "maxSize" text, "reviewStatus" text, "catalogArticleId" int)
        WHERE a.id = x.id`)
    }
    // (Matched rows without catalogArticleId are always in plan.variants.update, so only
    // catalogue variants are ever linked. Other-brand rows that merely share a code are not.)
    if (plan.variants.create.length) {
      await tx.execute(sql`
        INSERT INTO articles ("artName", "artCode", "colorCode", color, "minSize", "maxSize", "reviewStatus", source, active, "catalogArticleId")
        SELECT x."artName", split_part(x.key, '|', 1), split_part(x.key, '|', 2), x.color, x."minSize", x."maxSize", x."reviewStatus", 'import', true, x."catalogArticleId"
        FROM json_to_recordset(${J(plan.variants.create.map(c => ({ ...c, catalogArticleId: withCat(c.key) })))}::json)
          AS x(key text, "artName" text, color text, "minSize" text, "maxSize" text, "reviewStatus" text, "catalogArticleId" int)`)
    }
    const keys = model.variants.map(v => v.key)
    const idRows = rows<{ id: number; key: string }>(await tx.execute(sql`
      SELECT id, upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')) || '|' || upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g')) AS key
      FROM articles
      WHERE btrim("artCode") <> '' AND btrim("colorCode") <> ''
        AND upper(regexp_replace(btrim("artCode"), '\s+', ' ', 'g')) || '|' || upper(regexp_replace(btrim("colorCode"), '\s+', ' ', 'g')) IN (SELECT json_array_elements_text(${J(keys)}::json))`))
    const idOf = new Map(idRows.map(r => [r.key, Number(r.id)]))
    if (idOf.size !== keys.length) throw new Error(`Catalogue import: expected ${keys.length} variants after writing, found ${idOf.size}.`)

    // 3. Colours
    if (plan.colours.insert.length) {
      await tx.execute(sql`
        INSERT INTO article_colors ("articleId", "colorName")
        SELECT x.id, x.name FROM json_to_recordset(${J(plan.colours.insert.map(c => ({ id: idOf.get(c.key), name: c.name })))}::json) AS x(id int, name text)`)
    }
    if (plan.colours.update.length) {
      await tx.execute(sql`
        UPDATE article_colors c SET "colorName" = x.name
        FROM json_to_recordset(${J(plan.colours.update.map(u => ({ id: u.id, name: u.to })))}::json) AS x(id int, name text)
        WHERE c.id = x.id`)
    }

    // 4. Ranges
    if (plan.ranges.upsert.length) {
      await tx.execute(sql`
        INSERT INTO article_size_ranges ("articleId", "minSize", "maxSize", sizes, active, "sourceBatchId")
        SELECT x.id, x.min, x.max, ARRAY(SELECT json_array_elements_text(x.sizes)), true, ${batchId}
        FROM json_to_recordset(${J(plan.ranges.upsert.map(r => ({ id: idOf.get(r.key), min: r.min, max: r.max, sizes: r.sizes })))}::json)
          AS x(id int, min text, max text, sizes json)
        ON CONFLICT ("articleId", "minSize", "maxSize") DO UPDATE SET active = true, sizes = excluded.sizes, "sourceBatchId" = excluded."sourceBatchId"`)
    }
    if (plan.ranges.deactivate.length) {
      await tx.execute(sql`UPDATE article_size_ranges SET active = false WHERE id IN (SELECT json_array_elements_text(${J(plan.ranges.deactivate)}::json)::int)`)
    }

    // 5. SKUs (never deleted)
    if (plan.skus.deactivate.length) {
      await tx.execute(sql`UPDATE article_sizes SET active = false WHERE id IN (SELECT json_array_elements_text(${J(plan.skus.deactivate.map(s => s.id))}::json)::int)`)
    }
    if (plan.skus.update.length) {
      await tx.execute(sql`
        UPDATE article_sizes s SET "sizeLabel" = x.label, "sortOrder" = x."sortOrder", active = true
        FROM json_to_recordset(${J(plan.skus.update.map(u => ({ id: u.id, label: u.label, sortOrder: u.sortOrder })))}::json) AS x(id int, label text, "sortOrder" int)
        WHERE s.id = x.id`)
    }
    if (plan.skus.create.length) {
      await tx.execute(sql`
        INSERT INTO article_sizes ("articleId", "sizeLabel", "sortOrder", active)
        SELECT x.id, x.label, x."sortOrder", true
        FROM json_to_recordset(${J(plan.skus.create.map(s => ({ id: idOf.get(s.key), label: s.label, sortOrder: s.sortOrder })))}::json) AS x(id int, label text, "sortOrder" int)`)
    }

    // 6. Retire in-scope variants absent from the catalogue (inactive, never deleted).
    const retireReason = `Not in approved catalogue (${input.fileName}, batch ${batchId})`
    if (plan.retire.length) {
      await tx.execute(sql`
        UPDATE articles SET active = false, "retiredAt" = now(), "retiredReason" = ${retireReason}
        WHERE id IN (SELECT json_array_elements_text(${J(plan.retire.map(r => r.id))}::json)::int) AND active`)
    }

    // 7. Source rows, verbatim
    const src = model.rows.map(r => {
      const o = model.rowOutcome.get(r.rowNumber)
      return { rowNumber: r.rowNumber, raw: r.raw, artName: r.artName, artCode: r.artCode, color: r.color, colorCode: r.colorCode,
        minSize: r.minSize, maxSize: r.maxSize, articleId: o?.variantKey ? idOf.get(o.variantKey) ?? null : null, outcome: o?.outcome ?? 'rejected' }
    })
    await tx.execute(sql`
      INSERT INTO catalog_source_rows ("batchId", "rowNumber", raw, "artName", "artCode", color, "colorCode", "minSize", "maxSize", "articleId", outcome)
      SELECT ${batchId}, x."rowNumber", x.raw, x."artName", x."artCode", x.color, x."colorCode", x."minSize", x."maxSize", x."articleId", x.outcome
      FROM json_to_recordset(${J(src)}::json)
        AS x("rowNumber" int, raw jsonb, "artName" text, "artCode" text, color text, "colorCode" text, "minSize" text, "maxSize" text, "articleId" int, outcome text)`)

    // 8. Review queue (an item an admin already dismissed or resolved keeps that status).
    if (plan.reviewItems.length) {
      const items = plan.reviewItems.map(i => ({ ...i, articleId: i.articleId ?? (i.variantKey ? idOf.get(i.variantKey) ?? null : null), details: i.details ?? null }))
      await tx.execute(sql`
        INSERT INTO catalog_review_items (kind, severity, "subjectKey", "artCode", "colorCode", "articleId", message, details, "firstBatchId", "lastBatchId")
        SELECT x.kind, x.severity, x."subjectKey", x."artCode", x."colorCode", x."articleId", x.message, x.details, ${batchId}, ${batchId}
        FROM json_to_recordset(${J(items)}::json)
          AS x(kind text, severity text, "subjectKey" text, "artCode" text, "colorCode" text, "articleId" int, message text, details jsonb)
        ON CONFLICT (kind, "subjectKey") DO UPDATE SET severity = excluded.severity, message = excluded.message, details = excluded.details,
          "articleId" = COALESCE(excluded."articleId", catalog_review_items."articleId"), "lastBatchId" = excluded."lastBatchId"`)
    }

    // 8b. Owner declared the source correct: close open source-conflict items with that reason.
    let sourceIssuesClosed = 0
    if (plan.closeSourceIssues) {
      const closed = rows<{ id: number }>(await tx.execute(sql`
        UPDATE catalog_review_items SET status = 'dismissed', "resolvedAt" = now(), "resolvedBy" = ${actor.id},
          resolution = 'Owner decision 18 Nov 2026: the approved workbook is treated as correct ("assume the article data has no mistakes"); corrected sheets will replace it.',
          "lastBatchId" = ${batchId}
        WHERE status = 'open' AND kind IN (SELECT json_array_elements_text(${J(SOURCE_ISSUE_KINDS)}::json))
        RETURNING id`))
      sourceIssuesClosed = closed.length
    }

    // 9. Audit: one row per changed or retired variant (with before/after), plus a batch summary.
    const auditRows = [
      ...plan.variants.update.map(u => ({ action: u.reactivated ? 'article.catalog_reactivate' : 'article.catalog_update', entityId: String(u.id), before: u.before,
        after: { artName: u.artName, color: u.color, minSize: u.minSize, maxSize: u.maxSize, reviewStatus: u.reviewStatus, active: true } })),
      ...plan.retire.map(r => ({ action: 'article.retire', entityId: String(r.id), before: { active: true, artName: r.artName, artCode: r.artCode, colorCode: r.colorCode, color: r.color },
        after: { active: false, retiredReason: retireReason } })),
      ...plan.skus.deactivate.map(s => ({ action: 'sku.deactivate', entityId: String(s.id), before: { active: true, sizeLabel: s.label }, after: { active: false } })),
    ]
    if (auditRows.length) {
      await tx.execute(sql`
        INSERT INTO audit_events ("actorUserId", "actorName", action, "entityType", "entityId", before, after, reason, metadata)
        SELECT ${actor.id}, ${actor.name}, x.action, CASE WHEN x.action LIKE 'sku.%' THEN 'sku' ELSE 'article' END, x."entityId", x.before, x.after,
          ${`Catalogue import batch ${batchId}`}, ${J({ batchId })}::jsonb
        FROM json_to_recordset(${J(auditRows)}::json) AS x(action text, "entityId" text, before jsonb, after jsonb)`)
    }
    const counts = {
      articlesCreated: plan.articles.created.length, articlesRenamed: plan.articles.renamed.length,
      variantsCreated: plan.variants.create.length, variantsUpdated: plan.variants.update.length, variantsUnchanged: plan.variants.unchanged,
      variantsRetired: plan.retire.length, skusCreated: plan.skus.create.length, skusUpdated: plan.skus.update.length, skusDeactivated: plan.skus.deactivate.length,
      rangesWritten: plan.ranges.upsert.length, coloursInserted: plan.colours.insert.length, rangesDeactivated: plan.ranges.deactivate.length, reviewItems: plan.reviewItems.length,
      outOfScopeUntouched: plan.outOfScope.variants, sourceIssuesClosed, trustSource: plan.trustSource ? 1 : 0,
    }
    await tx.execute(sql`
      INSERT INTO audit_events ("actorUserId", "actorName", action, "entityType", "entityId", after, metadata)
      VALUES (${actor.id}, ${actor.name}, 'catalog.import', 'catalog_import_batch', ${String(batchId)}, ${J(counts)}::jsonb,
        ${J({ fileName: input.fileName, fileSha256: input.fileSha256, stats: model.stats })}::jsonb)`)

    // 10. Scans waiting for one of these variants are resolved and posted to stock now.
    let scansResolved = 0
    for (const key of plan.pendingToResolve) {
      const [code, colour] = key.split('|')
      scansResolved += (await resolvePendingScans(tx, actor, code, colour)).resolved
    }

    await tx.execute(sql`UPDATE catalog_import_batches SET summary = ${J({ ...counts, scansResolved, stats: model.stats })}::jsonb WHERE id = ${batchId}`)
    await bumpCatalogueVersion(tx) // Orders screens download the list again
    return { batchId, noop: false, counts, scansResolved }
  })
}
