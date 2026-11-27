// Reconcile / import the approved Sparx article workbook.
//
//   Dry run (read-only; writes the reconciliation report):
//     npx tsx scripts/catalog/import-sparx.ts --file <workbook.xlsx> --env-file .env.local
//   --schema <name> runs against another schema (release rehearsals).
//   --trust-source: the owner declared the workbook correct; conflicts are reported but approved,
//     and open source-conflict review items are closed with that decision as the reason.
//   Apply (one transaction; needs a backup from the last 2 hours):
//     npx tsx scripts/catalog/import-sparx.ts --file <workbook.xlsx> --env-file .env.local --apply --confirm <endpoint> [--actor <user email>]
//
// Report: docs/catalog/sparx-reconciliation.md (+ CSV detail files next to it). Override with --report-dir.
// Re-running with the same workbook after an apply reports "no changes" and writes nothing.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import ExcelJS from 'exceljs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../../lib/db/schema'
import type { Actor, Db } from '../../lib/db/types'
import { buildWorkbookModel, rowsFromSheet, type WorkbookModel } from '../../lib/catalog/sparx-workbook'
import { applyCatalogImport, loadCatalogState, planCatalogImport, type ImportPlan } from '../../lib/catalog/import'
import { arg, flag, log, poolConfig, recentBackupExists, requireWriteConfirmation, resolveTarget } from '../db/_connect'

const EXPECTED = { rows: 714, articleCodes: 267, artNames: 230, repeatedCodeColour: 47, exactDuplicateRows: 3 }

async function readWorkbook(file: string, sheetName: string) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.getWorksheet(sheetName)
  if (!ws) throw new Error(`Sheet "${sheetName}" not found. Sheets: ${wb.worksheets.map(w => w.name).join(', ')}`)
  const cells: { rowNumber: number; values: unknown[] }[] = []
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const values: unknown[] = []
    row.eachCell({ includeEmpty: true }, (c, col) => {
      let v = c.value as unknown
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        if ('result' in o) v = o.result
        else if ('richText' in o) v = (o.richText as { text: string }[]).map(r => r.text).join('')
        else if ('text' in o) v = o.text
      }
      values[col - 1] = v ?? null
    })
    cells.push({ rowNumber: n, values })
  })
  return cells
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n'

function repeatedCodeColourRaw(model: WorkbookModel) {
  const n = new Map<string, number>()
  for (const r of model.rows) n.set(`${r.artCode}|${r.colorCode}`, (n.get(`${r.artCode}|${r.colorCode}`) ?? 0) + 1)
  return [...n.values()].filter(c => c > 1).length
}

function report(model: WorkbookModel, plan: ImportPlan, meta: { file: string; sha: string; endpoint: string; sheet: string; generatedAt: string }) {
  const s = model.stats
  const rep = repeatedCodeColourRaw(model)
  const L: string[] = []
  const issueCount = (sev: string) => model.issues.filter(i => i.severity === sev).length
  L.push('# Sparx article workbook — reconciliation report', '')
  L.push(`Generated ${meta.generatedAt} against database endpoint \`${meta.endpoint}\` (read-only comparison).`, '')
  L.push(`Source: \`${path.basename(meta.file)}\`, sheet \`${meta.sheet}\`, SHA-256 \`${meta.sha}\`.`, '')
  L.push('## 1. Workbook', '')
  L.push('| Check | Expected (brief) | Found |', '|---|---:|---:|')
  L.push(`| Populated rows | ${EXPECTED.rows} | ${s.rows} |`)
  L.push(`| Unique article codes | ${EXPECTED.articleCodes} | ${s.articleCodes} |`)
  L.push(`| Distinct article names | ${EXPECTED.artNames} | ${s.artNames} |`)
  L.push(`| Repeated code + colour combinations | ${EXPECTED.repeatedCodeColour} | ${rep} (${s.repeatedVariants} after removing exact duplicates) |`)
  L.push(`| Exact duplicate rows | ${EXPECTED.exactDuplicateRows} | ${s.exactDuplicateRows} |`)
  L.push(`| Variants (code + colour) | — | ${s.variants} |`)
  L.push(`| Size ranges kept | — | ${s.ranges} |`)
  L.push(`| SKUs (variant + size) | — | ${s.skus} |`)
  L.push(`| Rows rejected | — | ${s.rows - s.usableRows} |`, '')
  L.push('Repeated code + colour rows are **not** errors in general: most are separate size ranges of one variant (kids 11–13, 1 and 2–5; adult 6–10 and 11–12). They are stored as one variant with several ranges.', '')
  L.push(`Issues: ${issueCount('error')} error, ${issueCount('review')} for admin review, ${issueCount('info')} informational.`, '')
  const kinds = [...new Set(model.issues.map(i => i.kind))]
  for (const k of kinds) {
    const list = model.issues.filter(i => i.kind === k)
    L.push(`### ${k.replace(/_/g, ' ')} (${list.length}, ${list[0].severity})`, '')
    for (const i of list) L.push(`- ${i.message} _(rows ${i.rowNumbers.join(', ')})_`)
    L.push('')
  }
  L.push('## 2. Comparison with the database', '')
  L.push('| Outcome | Count |', '|---|---:|')
  L.push(`| Article codes: new | ${plan.articles.created.length} |`)
  L.push(`| Article codes: display name changed | ${plan.articles.renamed.length} |`)
  L.push(`| Variants matched on code + colour (id kept) | ${plan.variants.matched} |`)
  L.push(`| … of which updated (name, colour name, sizes, status) | ${plan.variants.update.length} |`)
  L.push(`| … of which re-activated | ${plan.variants.update.filter(u => u.reactivated).length} |`)
  L.push(`| Variants to create | ${plan.variants.create.length} |`)
  L.push(`| Sparx-scope variants to retire (inactive, not deleted) | ${plan.retire.length} |`)
  L.push(`| … retired variants with scans, stock or scan links | ${plan.retire.filter(r => r.scans || r.stock || r.links).length} |`)
  L.push(`| SKUs to create | ${plan.skus.create.length} |`)
  L.push(`| SKUs updated (label normalised, order, re-activated) | ${plan.skus.update.length} |`)
  L.push(`| SKUs deactivated (size not in workbook) | ${plan.skus.deactivate.length} |`)
  L.push(`| Size ranges written | ${plan.ranges.upsert.length} |`)
  L.push(`| Other-brand variants left untouched | ${plan.outOfScope.variants} (${plan.outOfScope.active} active) |`)
  L.push(`| Retired rows with a same-name same-colour workbook candidate (report only) | ${plan.possibleMatches.length} |`)
  L.push(`| Review items | ${plan.reviewItems.length} |`)
  L.push(`| Waiting scans that will resolve | ${plan.pendingToResolve.length} variant(s) |`, '')
  L.push(plan.isNoop ? '**The database already matches this workbook: an apply would change nothing.**' : '', '')
  if (plan.articles.renamed.length) {
    L.push('### Article display names that change', '')
    for (const r of plan.articles.renamed) L.push(`- ${r.artCode}: "${r.from}" → "${r.to}"`)
    L.push('')
  }
  const renamedVariants = plan.variants.update.filter(u => u.before.artName !== u.artName)
  if (renamedVariants.length) {
    L.push(`### Matched variants whose article name changes (${renamedVariants.length})`, '')
    L.push('Old orders keep the name they were booked with (order lines store text).', '')
    for (const u of renamedVariants.slice(0, 60)) L.push(`- #${u.id} ${u.key}: "${u.before.artName}" → "${u.artName}"`)
    if (renamedVariants.length > 60) L.push(`- … ${renamedVariants.length - 60} more in variants-updated.csv`)
    L.push('')
  }
  L.push('### Other brands (not in the Sparx workbook; untouched)', '')
  L.push(Object.entries(plan.outOfScope.byFamily).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', '), '')
  const inUse = plan.retire.filter(r => r.scans || r.stock || r.links)
  if (inUse.length) {
    L.push('### Retired variants that have history', '')
    L.push('| Id | Name | Code | Colour | Scans | Pairs in stock | Scan links |', '|---:|---|---|---|---:|---:|---:|')
    for (const r of inUse) L.push(`| ${r.id} | ${r.artName} | ${r.artCode} | ${r.colorCode} ${r.color} | ${r.scans} | ${r.stock} | ${r.links} |`)
    L.push('', 'Their scans, stock movements and links stay attached to the same ids. Each has a review item.', '')
  }
  L.push('## 3. Files', '')
  L.push('- `retired.csv` — every variant that will be retired, with its references.')
  L.push('- `possible-matches.csv` — retired legacy rows whose name and colour name equal a workbook variant (for an admin to confirm; never merged automatically).')
  L.push('- `variants-updated.csv` — matched variants and what changes.')
  L.push('- `review-items.csv` — the admin review queue the import creates.', '')
  return L.join('\n')
}

async function main() {
  const file = arg('file')
  if (!file) throw new Error('Pass --file <path to the Sparx workbook .xlsx>.')
  const sheet = arg('sheet') || 'Articles'
  const reportDir = arg('report-dir') || path.join('docs', 'catalog', 'sparx-reconciliation')
  const t = resolveTarget()
  const dbSchema = arg('schema') || undefined
  const apply = flag('apply')
  if (apply) {
    requireWriteConfirmation(t)
    if (!flag('skip-backup-check') && !recentBackupExists(t.endpoint, dbSchema ?? 'public')) {
      throw new Error('Apply needs a backup taken in the last 2 hours: npm run db:backup -- --env-file <file>')
    }
  }

  const bytes = fs.readFileSync(file)
  const sha = crypto.createHash('sha256').update(bytes).digest('hex')
  const model = buildWorkbookModel(rowsFromSheet(await readWorkbook(file, sheet)))
  log(`Workbook ${path.basename(file)} sha256 ${sha.slice(0, 16)}… — ${model.stats.rows} rows, ${model.stats.articleCodes} codes, ${model.stats.variants} variants, ${model.stats.skus} SKUs`)

  const pool = new pg.Pool(poolConfig(t, dbSchema))
  const db = drizzle(pool, { schema }) as unknown as Db
  try {
    const state = await loadCatalogState(db)
    const trustSource = flag('trust-source')
    const plan = planCatalogImport(model, state, { trustSource })
    fs.mkdirSync(reportDir, { recursive: true })
    const generatedAt = new Date().toISOString()
    fs.writeFileSync(path.join(reportDir, '..', 'sparx-reconciliation.md'), report(model, plan, { file, sha, endpoint: t.endpoint, sheet, generatedAt }))
    fs.writeFileSync(path.join(reportDir, 'retired.csv'), toCsv(['id', 'artName', 'artCode', 'colorCode', 'color', 'scans', 'stockPairs', 'scanLinks'],
      plan.retire.map(r => [r.id, r.artName, r.artCode, r.colorCode, r.color, r.scans, r.stock, r.links])))
    fs.writeFileSync(path.join(reportDir, 'possible-matches.csv'), toCsv(['retiredId', 'artName', 'color', 'workbookVariants'],
      plan.possibleMatches.map(p => [p.id, p.artName, p.color, p.candidates.join(' ')])))
    fs.writeFileSync(path.join(reportDir, 'variants-updated.csv'), toCsv(['id', 'variant', 'nameBefore', 'nameAfter', 'colourBefore', 'colourAfter', 'sizesBefore', 'sizesAfter', 'statusAfter', 'reactivated'],
      plan.variants.update.map(u => [u.id, u.key, u.before.artName, u.artName, u.before.color, u.color, `${u.before.minSize}-${u.before.maxSize}`, `${u.minSize}-${u.maxSize}`, u.reviewStatus, u.reactivated])))
    fs.writeFileSync(path.join(reportDir, 'review-items.csv'), toCsv(['kind', 'severity', 'artCode', 'colorCode', 'message'],
      plan.reviewItems.map(i => [i.kind, i.severity, i.artCode, i.colorCode, i.message])))
    log(`Report written to ${path.join(reportDir, '..', 'sparx-reconciliation.md')}`)
    log(`Plan: ${plan.variants.matched} matched (${plan.variants.update.length} updated), ${plan.variants.create.length} new, ${plan.retire.length} retired, ${plan.outOfScope.variants} other-brand untouched; SKUs +${plan.skus.create.length} ~${plan.skus.update.length} -${plan.skus.deactivate.length}; ${plan.reviewItems.length} review items${plan.isNoop ? ' — NO CHANGES' : ''}`)

    if (!apply) { log('Dry run only. Nothing written.'); return }

    let actor: Actor = { id: null, name: 'Catalogue import (script)' }
    const email = arg('actor')
    if (email) {
      const u = (await db.execute(sql`SELECT id, name FROM "user" WHERE lower(email) = lower(${email}) LIMIT 1`)).rows[0] as { id: string; name: string } | undefined
      if (!u) throw new Error(`No user with email ${email}.`)
      actor = { id: u.id, name: u.name }
    }
    const res = await applyCatalogImport(db, actor, model, { source: 'sparx_workbook', fileName: path.basename(file), fileSha256: sha, sheetName: sheet, brand: 'SPARX', trustSource })
    if (res.noop) log('Database already matches the workbook. Nothing written.')
    else log(`Applied as batch ${res.batchId}: ${JSON.stringify(res.counts)}; scans resolved ${res.scansResolved}`)
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
