// Article list upload (Master → Articles → Upload, and scripts/catalog/upload-articles.ts).
//
// ADD-ONLY: an upload never deletes, retires or edits an existing variant. It
//   • adds variants (article code + colour code) that are not in the master yet;
//   • adds rows WITHOUT a colour code as "colour code pending" variants, keyed by
//     article code + colour name. The code is filled later — by the New Article form when
//     the first box of that colour is scanned, by editing the article, or by a later
//     upload that has the code (same article code + same colour name);
//   • skips everything already present and reports rows it cannot read.
//
// Database work per upload (any number of rows): 1 read for a preview; about 8–15
// statements in one transaction for an apply (bulk inserts, sizes in 1,000-row batches).

import { sql } from 'drizzle-orm'
import { articleColors, articles, articleSizes } from '@/lib/db/schema'
import type { Actor, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { normalizeArticleName, normalizeArticleValue, parseSizeText } from '@/lib/article-utils'
import { resolvePendingScans } from '@/lib/inventory/scan-service'
import { expandSizeRange, normaliseSizeLabel, sizeSortOrders, sortSizes } from './sizes'
import { SEGMENTS } from './assortments'

export { ARTICLE_UPLOAD_COLUMNS, articleTemplateCsv } from './article-upload-columns'

const DIVISION_BY_SOURCE: Record<string, string> = {
  SPARX: 'Sparx', PU: 'Flite PU', 'FLITE PU': 'Flite PU', FLITE: 'Flite EVA', EVA: 'Flite EVA', 'FLITE EVA': 'Flite EVA', BAHAMAS: 'Bahamas',
}

/** Colour-name key: case, spacing and "D . Pink" style dots do not matter. */
export const colourNameKey = (v: unknown) => normalizeArticleValue(String(v ?? '')).replace(/\s*\.\s*/g, '.')

const headerKey = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '')
const HEADER_ALIASES: Record<string, string[]> = {
  artName: ['artname', 'articlename', 'name'],
  artCode: ['artcode', 'articlecode', 'code'],
  color: ['color', 'colour', 'colorname', 'colourname'],
  colorCode: ['colorcode', 'colourcode'],
  minSize: ['minsize', 'min'],
  maxSize: ['maxsize', 'max'],
  sizes: ['sizes'],
  source: ['stocksource', 'division', 'source'],
  segment: ['segment'],
}

export type UploadRow = {
  rowNumber: number
  artName: string
  artCode: string
  color: string
  colorCode: string
  sizes: string[]
  division: string | null
  segment: string | null
}
export type UploadProblem = { rowNumber: number; message: string }
export type ParsedUpload = { rows: UploadRow[]; problems: UploadProblem[]; missingColumns: string[] }

/** Cells as a 2-D array, header row first (row numbers are 1-based sheet rows). */
export function parseArticleSheet(cells: { rowNumber: number; values: unknown[] }[]): ParsedUpload {
  if (!cells.length) return { rows: [], problems: [], missingColumns: ['artName', 'artCode', 'color', 'minSize', 'maxSize'] }
  const header = cells[0].values.map(headerKey)
  const col = (k: string) => header.findIndex((h) => HEADER_ALIASES[k].includes(h))
  const idx = Object.fromEntries(Object.keys(HEADER_ALIASES).map((k) => [k, col(k)])) as Record<string, number>
  const missingColumns = ['artName', 'artCode', 'color'].filter((k) => idx[k] < 0)
  if (idx.sizes < 0) for (const k of ['minSize', 'maxSize']) if (idx[k] < 0) missingColumns.push(k)
  if (missingColumns.length) return { rows: [], problems: [], missingColumns }

  const text = (v: unknown[], k: string) => (idx[k] < 0 ? '' : String(v[idx[k]] ?? '').trim())
  const rows: UploadRow[] = []
  const problems: UploadProblem[] = []
  for (const { rowNumber, values } of cells.slice(1)) {
    if (values.every((v) => v == null || String(v).trim() === '')) continue
    const artName = normalizeArticleName(text(values, 'artName'))
    const artCode = normalizeArticleValue(text(values, 'artCode'))
    const color = text(values, 'color').replace(/\s+/g, ' ')
    const colorCode = normalizeArticleValue(text(values, 'colorCode'))
    if (!artName || !artCode || !color) {
      problems.push({ rowNumber, message: `Row ${rowNumber}: artName, artCode and color are all required.` })
      continue
    }
    let sizes: string[]
    const sizeText = text(values, 'sizes')
    if (sizeText) sizes = parseSizeText(sizeText).map(normaliseSizeLabel)
    else {
      const r = expandSizeRange(text(values, 'minSize'), text(values, 'maxSize'))
      if (!r.ok) { problems.push({ rowNumber, message: `Row ${rowNumber} (${artCode} ${color}): ${r.reason}` }); continue }
      sizes = r.sizes
    }
    if (!sizes.length) { problems.push({ rowNumber, message: `Row ${rowNumber} (${artCode} ${color}): no sizes.` }); continue }
    const source = normalizeArticleValue(text(values, 'source'))
    const segmentText = text(values, 'segment')
    const segment = segmentText ? SEGMENTS.find((sg) => sg.toLowerCase() === segmentText.toLowerCase()) ?? null : null
    if (segmentText && !segment) { problems.push({ rowNumber, message: `Row ${rowNumber} (${artCode} ${color}): segment "${segmentText}" is not one of ${SEGMENTS.join(', ')}.` }); continue }
    rows.push({ rowNumber, artName, artCode, color, colorCode, sizes, division: DIVISION_BY_SOURCE[source] ?? null, segment })
  }
  return { rows, problems, missingColumns: [] }
}

/** Parse a CSV text (quoted cells allowed) into sheet cells. */
export function csvToCells(text: string): { rowNumber: number; values: unknown[] }[] {
  const out: { rowNumber: number; values: unknown[] }[] = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (!line.trim()) return
    const cells: string[] = []
    let cell = '', quoted = false
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (ch === '"') { if (quoted && line[j + 1] === '"') { cell += '"'; j++ } else quoted = !quoted }
      else if (ch === ',' && !quoted) { cells.push(cell); cell = '' }
      else cell += ch
    }
    cells.push(cell)
    out.push({ rowNumber: i + 1, values: cells })
  })
  return out
}

/** Read the first sheet of an .xlsx file into cells (server only: exceljs is not sent to phones). */
export async function xlsxToCells(data: ArrayBuffer): Promise<{ rowNumber: number; values: unknown[] }[]> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(data)
  const ws = wb.worksheets[0]
  if (!ws) return []
  const cells: { rowNumber: number; values: unknown[] }[] = []
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values: unknown[] = []
    row.eachCell({ includeEmpty: true }, (c, colNumber) => {
      let v = c.value as unknown
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        if ('result' in o) v = o.result
        else if ('richText' in o) v = (o.richText as { text: string }[]).map((r) => r.text).join('')
        else if ('text' in o) v = o.text
      }
      values[colNumber - 1] = v ?? null
    })
    cells.push({ rowNumber, values })
  })
  return cells
}

type Variant = { key: string; artName: string; artCode: string; color: string; colorCode: string; sizes: Set<string>; division: string | null; segment: string | null; rowNumbers: number[] }
export type UploadPlan = {
  /** New variants with a colour code. */
  add: Variant[]
  /** New variants without a colour code (kept by colour name, code pending). */
  addPending: Variant[]
  /** Existing "colour code pending" variants that this upload gives a colour code. */
  fill: { id: number; artCode: string; colorCode: string; color: string }[]
  alreadyThere: number
  /** Rows that conflict and were left out. */
  conflicts: UploadProblem[]
  /** Existing variants whose blank segment / division this upload fills (never overwrites). */
  attrs: { id: number; segment: string | null; division: string | null }[]
  /** Existing variants whose segment differs from the file: reported, not changed. */
  segmentDiffers: UploadProblem[]
}

export type UploadSummary = {
  rowsRead: number
  added: number
  addedPending: number
  filled: number
  alreadyThere: number
  /** Existing article colours that get a segment from this file. */
  segmentsSet: number
  /** Existing article colours whose segment differs from the file (left as they are). */
  segmentDiffers: UploadProblem[]
  problems: UploadProblem[]
  /** Distinct article codes in the file. */
  articleCodes: number
}

/** Compare the file with the master (one read). */
export async function planArticleUpload(db: DbOrTx, rows: UploadRow[]): Promise<UploadPlan> {
  const variants = new Map<string, Variant>()
  for (const r of rows) {
    const key = r.colorCode ? `${r.artCode}|${r.colorCode}` : `${r.artCode}|~${colourNameKey(r.color)}`
    const v = variants.get(key)
    if (v) { r.sizes.forEach((s) => v.sizes.add(s)); v.rowNumbers.push(r.rowNumber); v.division ??= r.division; v.segment ??= r.segment }
    else variants.set(key, { key, artName: r.artName, artCode: r.artCode, color: r.color, colorCode: r.colorCode, sizes: new Set(r.sizes), division: r.division, segment: r.segment, rowNumbers: [r.rowNumber] })
  }
  const codes = JSON.stringify([...new Set(rows.map((r) => r.artCode))])
  const existing = (await db.execute<{ id: number; code: string; colour: string; name: string; segment: string | null; division: string | null }>(sql`
    SELECT id, upper(regexp_replace(btrim("artCode"), '\\s+', ' ', 'g')) AS code,
           upper(regexp_replace(btrim("colorCode"), '\\s+', ' ', 'g')) AS colour, color AS name, segment, division
      FROM articles
     WHERE upper(regexp_replace(btrim("artCode"), '\\s+', ' ', 'g')) IN (SELECT json_array_elements_text(${codes}::json))`)).rows

  const byCodeColour = new Set(existing.filter((e) => e.colour).map((e) => `${e.code}|${e.colour}`))
  const namesByCode = new Map<string, Set<string>>()
  const pendingByCodeName = new Map<string, { id: number; name: string }>()
  for (const e of existing) {
    const k = colourNameKey(e.name)
    if (!namesByCode.has(e.code)) namesByCode.set(e.code, new Set())
    namesByCode.get(e.code)!.add(k)
    if (!e.colour) pendingByCodeName.set(`${e.code}|${k}`, { id: e.id, name: e.name })
  }

  // Fill a blank segment / division on existing variants the file covers; report a different segment.
  const attrs = new Map<number, { id: number; segment: string | null; division: string | null }>()
  const segmentDiffers: UploadProblem[] = []
  const touch = (v: Variant, ids: (e: (typeof existing)[number]) => boolean) => {
    for (const e of existing.filter(ids)) {
      const seg = v.segment && !e.segment ? v.segment : null
      const div = v.division && !e.division ? v.division : null
      if (v.segment && e.segment && e.segment !== v.segment) {
        segmentDiffers.push({ rowNumber: v.rowNumbers[0], message: `Row ${v.rowNumbers[0]} (${v.artCode} ${v.color}): segment in the master is ${e.segment}, the file says ${v.segment}. Left as ${e.segment}; change it with Edit if the file is right.` })
      }
      if (seg || div) {
        const cur = attrs.get(e.id) ?? { id: e.id, segment: null, division: null }
        attrs.set(e.id, { id: e.id, segment: cur.segment ?? seg, division: cur.division ?? div })
      }
    }
  }

  const codedInFile = new Set([...variants.values()].filter((v) => v.colorCode).map((v) => `${v.artCode}|${colourNameKey(v.color)}`))
  const plan: UploadPlan = { add: [], addPending: [], fill: [], alreadyThere: 0, conflicts: [], attrs: [], segmentDiffers }
  const filledIds = new Set<number>()
  for (const v of variants.values()) {
    if (v.colorCode) {
      if (byCodeColour.has(v.key)) { plan.alreadyThere++; touch(v, (e) => `${e.code}|${e.colour}` === v.key); continue }
      const pending = pendingByCodeName.get(`${v.artCode}|${colourNameKey(v.color)}`)
      if (pending && !filledIds.has(pending.id)) {
        filledIds.add(pending.id)
        plan.fill.push({ id: pending.id, artCode: v.artCode, colorCode: v.colorCode, color: pending.name })
        touch(v, (e) => e.id === pending.id)
        continue
      }
      plan.add.push(v)
    } else {
      if (namesByCode.get(v.artCode)?.has(colourNameKey(v.color))) { plan.alreadyThere++; touch(v, (e) => e.code === v.artCode && colourNameKey(e.name) === colourNameKey(v.color)); continue }
      // The file itself may give this colour name a code in another row: that row covers it.
      if (codedInFile.has(`${v.artCode}|${colourNameKey(v.color)}`)) { plan.alreadyThere++; continue }
      plan.addPending.push(v)
    }
  }
  plan.attrs = [...attrs.values()]
  return plan
}

export function summarise(parsed: ParsedUpload, plan: UploadPlan): UploadSummary {
  return {
    rowsRead: parsed.rows.length + parsed.problems.length,
    added: plan.add.length,
    addedPending: plan.addPending.length,
    filled: plan.fill.length,
    alreadyThere: plan.alreadyThere,
    segmentsSet: plan.attrs.filter((a) => a.segment).length,
    segmentDiffers: plan.segmentDiffers,
    problems: [...parsed.problems, ...plan.conflicts],
    articleCodes: new Set(parsed.rows.map((r) => r.artCode)).size,
  }
}

/** Write a plan in ONE transaction. Returns how many waiting scans moved into stock. */
export async function applyArticleUpload(db: DbOrTx, actor: Actor, plan: UploadPlan, meta: { fileName: string; rowsRead: number }): Promise<{ resolvedScans: number }> {
  return db.transaction(async (tx) => {
    const fresh = [...plan.add, ...plan.addPending]
    let insertedIds: number[] = []
    if (fresh.length) {
      const inserted = await tx.insert(articles).values(fresh.map((v) => {
        const sizes = sortSizes([...v.sizes])
        return {
          artName: v.artName, artCode: v.artCode, color: v.color, colorCode: v.colorCode,
          minSize: sizes[0] ?? '', maxSize: sizes[sizes.length - 1] ?? '',
          division: v.division, segment: v.segment, source: 'import' as const, reviewStatus: 'unverified' as const,
        }
      })).returning({ id: articles.id })
      insertedIds = inserted.map((r) => r.id)
      await tx.insert(articleColors).values(inserted.map(({ id }, i) => ({ articleId: id, colorName: fresh[i].color, colorHex: fresh[i].colorCode || null })))
      const sizeRows = inserted.flatMap(({ id }, i) => {
        const labels = sortSizes([...fresh[i].sizes])
        const order = sizeSortOrders(labels)
        return labels.map((sizeLabel) => ({ articleId: id, sizeLabel, sortOrder: order.get(sizeLabel)! }))
      })
      for (let i = 0; i < sizeRows.length; i += 1000) await tx.insert(articleSizes).values(sizeRows.slice(i, i + 1000))
      const ids = JSON.stringify(insertedIds)
      await tx.execute(sql`
        INSERT INTO catalog_articles ("artCode", "artName", source)
        SELECT DISTINCT ON (a."artCode") a."artCode", a."artName", 'import' FROM articles a
        WHERE a.id IN (SELECT json_array_elements_text(${ids}::json)::int) AND a."artCode" <> ''
        ORDER BY a."artCode", a.id
        ON CONFLICT ("artCode") DO NOTHING`)
      await tx.execute(sql`
        UPDATE articles a SET "catalogArticleId" = c.id FROM catalog_articles c
        WHERE a.id IN (SELECT json_array_elements_text(${ids}::json)::int) AND c."artCode" = a."artCode"`)
    }
    if (plan.attrs.length) {
      await tx.execute(sql`
        UPDATE articles a SET segment = coalesce(a.segment, x.segment), division = coalesce(a.division, x.division)
          FROM json_to_recordset(${JSON.stringify(plan.attrs)}::json) AS x(id int, segment text, division text)
         WHERE a.id = x.id`)
    }
    if (plan.fill.length) {
      const fills = JSON.stringify(plan.fill.map((f) => ({ id: f.id, cc: f.colorCode })))
      await tx.execute(sql`
        UPDATE articles a SET "colorCode" = f.cc
          FROM json_to_recordset(${fills}::json) AS f(id int, cc text)
         WHERE a.id = f.id AND btrim(a."colorCode") = ''`)
      await tx.execute(sql`
        UPDATE article_colors ac SET "colorHex" = f.cc
          FROM json_to_recordset(${fills}::json) AS f(id int, cc text)
         WHERE ac."articleId" = f.id`)
    }
    await audit(tx, { actor, action: 'article.list_uploaded', entityType: 'article_upload', entityId: new Date().toISOString(),
      after: { file: meta.fileName, rowsRead: meta.rowsRead, segmentsSet: plan.attrs.filter((a) => a.segment).length, added: plan.add.length, addedPending: plan.addPending.length, filled: plan.fill.length, alreadyThere: plan.alreadyThere } })

    // Boxes scanned before their article existed: post them now (only codes that have waiting scans).
    const keys = JSON.stringify([...plan.add.map((v) => `${v.artCode}|${v.colorCode}`), ...plan.fill.map((f) => `${f.artCode}|${f.colorCode}`)])
    let resolvedScans = 0
    if (keys !== '[]') {
      const waiting = (await tx.execute<{ code: string; colour: string }>(sql`
        SELECT DISTINCT "articleCode" AS code, "colourCode" AS colour FROM scan_events
         WHERE status = 'active' AND resolution <> 'resolved'
           AND ("articleCode" || '|' || "colourCode") IN (SELECT json_array_elements_text(${keys}::json))`)).rows
      for (const w of waiting) resolvedScans += (await resolvePendingScans(tx, actor, w.code, w.colour)).resolved
    }
    return { resolvedScans }
  })
}
