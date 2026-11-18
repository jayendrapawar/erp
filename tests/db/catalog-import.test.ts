import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan } from '../../lib/inventory/scan-service'
import { applyCatalogImport } from '../../lib/catalog/import'
import { buildWorkbookModel, type WorkbookRow } from '../../lib/catalog/sparx-workbook'
import type { Actor } from '../../lib/db/types'

// Real box labels from the regression corpus.
const KNOWN_BOX = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722' // not Sparx scope by name below
const SS0703_BOX = 'A1SS0703G-NBOR0007-1026R05MA0-649.00-1005-44GSY-1020602214'

const row = (n: number, artName: string, artCode: string, color: string, colorCode: string, min: number, max: number): WorkbookRow =>
  ({ rowNumber: n, artName, artCode, color, colorCode, minSize: String(min), maxSize: String(max), raw: { artName, artCode, color, colorCode, minSize: min, maxSize: max } })

const input = { source: 'sparx_workbook', fileName: 'test.xlsx', fileSha256: 'x'.repeat(64), sheetName: 'Articles', brand: 'SPARX' }

describe('catalogue import (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  let matchedId = 0, codelessId = 0, otherBrandId = 0, flCodeId = 0, puSharedCodeId = 0, matchedSku7 = 0, matchedSku12 = 0
  const q = async <T>(s: ReturnType<typeof sql>) => (await h.db.execute(s)).rows as T[]

  const model = buildWorkbookModel([
    row(2, 'SM-950', 'SX0950G', 'Black Gold', 'BKGO', 6, 10),
    row(3, 'SM-950', 'SX0950G', 'Black Gold', 'BKGO', 11, 12),
    row(4, 'SS-703', 'SS0703G', 'N.Blue Orange', 'NBOR', 6, 10),
    row(5, 'SK-1016', 'SD1016B', 'Pearl White D.Green', 'PWNG', 11, 13),
    row(6, 'SK-1016', 'SD1016B', 'Pearl White D.Green', 'PWNG', 1, 1),
    row(7, 'SK-1016', 'SD1016B', 'Pearl White D.Green', 'PWNG', 2, 5),
    row(8, 'SM-323', 'SD0323G', 'White Black', 'BKWH', 4, 5),
    row(9, 'SM-323', 'SD0323G', 'Black White', 'BKWH', 4, 5),
  ])

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-admin','Admin','a@test.local','admin')`)
    const ins = async (name: string, code: string, colour: string, colourName: string, min: string, max: string) =>
      Number((await q<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode","minSize","maxSize") VALUES (${name},${code},${colourName},${colour},${min},${max}) RETURNING id`))[0].id)
    matchedId = await ins('SM-950 old name', 'SX0950G', 'BKGO', 'Blk Gold', '6', '12')
    codelessId = await ins('SM-950', '', '', 'Black Gold', '6', '10')
    otherBrandId = await ins('PUG-N42', 'PUGN42G', 'WHWH', 'White', '6', '7')
    flCodeId = await ins('FL-561', 'SF0561G', 'BKBK', 'Black', '3', '8')
    puSharedCodeId = await ins('PUG-950', 'SX0950G', 'BKBK', 'Black', '6', '10') // other brand, code shared with a catalogue article
    const sk = await q<{ id: number; sizeLabel: string }>(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES
      (${matchedId},'06',0),(${matchedId},'7',1),(${matchedId},'8',2),(${matchedId},'9',3),(${matchedId},'10',4),(${matchedId},'11',5),(${matchedId},'12',6),(${matchedId},'13',7),
      (${otherBrandId},'6',0),(${otherBrandId},'7',1) RETURNING id, "sizeLabel"`)
    matchedSku7 = Number(sk.find(s => s.sizeLabel === '7')!.id)
    matchedSku12 = Number(sk.find(s => s.sizeLabel === '12')!.id)
    await h.db.execute(sql`INSERT INTO article_colors ("articleId","colorName") VALUES (${matchedId},'Blk Gold')`)
    // Stock on the matched variant (size 7) via a manual ledger entry, and a scan on the other brand.
    await h.db.execute(sql`SELECT set_config('shayona.ledger','on',false)`)
    const loc = Number((await q<{ id: number }>(sql`SELECT id FROM locations WHERE code = 'MAIN'`))[0].id)
    await h.db.execute(sql`INSERT INTO stock_movements ("skuId","locationId",provenance,quantity,"movementType","sourceType","sourceId","idempotencyKey")
      VALUES (${matchedSku7}, ${loc}, 'unscanned', 3, 'adjustment', 'test', '1', 'test:1')`)
    assert.equal((await recordBoxScan(h.db, admin, { clientEventId: randomUUID(), rawInput: KNOWN_BOX })).status, 'saved')
    // A scan for SS0703G waits as a missing article until the catalogue contains it.
    const waiting = await recordBoxScan(h.db, admin, { clientEventId: randomUUID(), rawInput: SS0703_BOX })
    assert.equal(waiting.status === 'saved' && waiting.event.resolution, 'missing_article')
  })
  after(async () => { await h?.close() })

  test('first apply writes the catalogue', async () => {
    const res = await applyCatalogImport(h.db, admin, model, input)
    assert.equal(res.noop, false)
    assert.equal(res.scansResolved, 1)
    assert.equal(res.counts.variantsCreated, 3)
    assert.equal(res.counts.variantsUpdated, 1)
    assert.equal(res.counts.variantsRetired, 1)
  })

  test('matched variant keeps its id, SKU ids and stock', async () => {
    const [a] = await q<{ artName: string; color: string; active: boolean; reviewStatus: string; catalogArticleId: number | null }>(sql`SELECT "artName", color, active, "reviewStatus", "catalogArticleId" FROM articles WHERE id = ${matchedId}`)
    assert.equal(a.artName, 'SM-950')
    assert.equal(a.color, 'Black Gold')
    assert.equal(a.reviewStatus, 'approved')
    assert.ok(a.catalogArticleId)
    const sizes = await q<{ id: number; sizeLabel: string; active: boolean; sortOrder: number }>(sql`SELECT id, "sizeLabel", active, "sortOrder" FROM article_sizes WHERE "articleId" = ${matchedId} ORDER BY "sortOrder"`)
    assert.deepEqual(sizes.filter(s => s.active).map(s => s.sizeLabel), ['6', '7', '8', '9', '10', '11', '12'])
    assert.equal(sizes.find(s => s.sizeLabel === '13')!.active, false) // not deleted
    assert.equal(Number(sizes.find(s => s.sizeLabel === '7')!.id), matchedSku7)
    assert.equal(Number(sizes.find(s => s.sizeLabel === '12')!.id), matchedSku12)
    const [b] = await q<{ q: number }>(sql`SELECT coalesce(sum(quantity),0)::int q FROM stock_balances WHERE "skuId" = ${matchedSku7}`)
    assert.equal(Number(b.q), 3)
    const ranges = await q<{ minSize: string; maxSize: string }>(sql`SELECT "minSize","maxSize" FROM article_size_ranges WHERE "articleId" = ${matchedId} ORDER BY id`)
    assert.deepEqual(ranges.map(r => `${r.minSize}-${r.maxSize}`), ['6-10', '11-12'])
    const [c] = await q<{ colorName: string }>(sql`SELECT "colorName" FROM article_colors WHERE "articleId" = ${matchedId}`)
    assert.equal(c.colorName, 'Black Gold')
  })

  test('in-scope leftovers are retired, not deleted; other brands untouched', async () => {
    const rows = await q<{ id: number; active: boolean; retiredReason: string | null }>(sql`SELECT id, active, "retiredReason" FROM articles WHERE id IN (${codelessId}, ${otherBrandId}, ${flCodeId})`)
    const by = new Map(rows.map(r => [Number(r.id), r]))
    assert.equal(by.get(codelessId)!.active, false)
    assert.match(by.get(codelessId)!.retiredReason ?? '', /Not in approved catalogue/)
    assert.equal(by.get(otherBrandId)!.active, true)
    assert.equal(by.get(flCodeId)!.active, true)
    const [pu] = await q<{ active: boolean; catalogArticleId: number | null }>(sql`SELECT active, "catalogArticleId" FROM articles WHERE id = ${puSharedCodeId}`)
    assert.equal(pu.active, true)
    assert.equal(pu.catalogArticleId, null) // never linked to the Sparx article just because the code matches
    const items = await q<{ kind: string; articleId: number }>(sql`SELECT kind, "articleId" FROM catalog_review_items`)
    assert.ok(items.some(i => i.kind === 'brand_code_mismatch' && Number(i.articleId) === flCodeId))
    assert.ok(items.some(i => i.kind === 'colour_name_conflict'))
  })

  test('children’s multi-range variant and waiting scan', async () => {
    const [v] = await q<{ id: number; minSize: string; maxSize: string }>(sql`SELECT id, "minSize", "maxSize" FROM articles WHERE "artCode" = 'SD1016B'`)
    assert.equal(`${v.minSize}-${v.maxSize}`, '11-5')
    const s = await q<{ sizeLabel: string }>(sql`SELECT "sizeLabel" FROM article_sizes WHERE "articleId" = ${v.id} AND active ORDER BY "sortOrder"`)
    assert.deepEqual(s.map(x => x.sizeLabel), ['11', '12', '13', '1', '2', '3', '4', '5'])
    const [ev] = await q<{ resolution: string; skuId: number | null }>(sql`SELECT resolution, "skuId" FROM scan_events WHERE "articleCode" = 'SS0703G'`)
    assert.equal(ev.resolution, 'resolved')
    const [bal] = await q<{ q: number }>(sql`SELECT coalesce(sum(quantity),0)::int q FROM stock_balances WHERE "skuId" = ${ev.skuId}`)
    assert.equal(Number(bal.q), 1)
  })

  test('traceability: source rows, batch and audit', async () => {
    const [n] = await q<{ n: number; dup: number }>(sql`SELECT count(*)::int n, count(*) FILTER (WHERE outcome = 'duplicate')::int dup FROM catalog_source_rows`)
    assert.equal(Number(n.n), 8)
    const audits = await q<{ action: string }>(sql`SELECT action FROM audit_events WHERE action LIKE 'article.%' OR action = 'catalog.import'`)
    assert.ok(audits.some(a => a.action === 'catalog.import'))
    assert.ok(audits.some(a => a.action === 'article.retire'))
    assert.ok(audits.some(a => a.action === 'article.catalog_update'))
    const [m] = await q<{ n: number }>(sql`SELECT count(*)::int n FROM stock_balance_mismatches`)
    assert.equal(Number(m.n), 0)
  })

  test('re-applying the same workbook changes nothing', async () => {
    const before = await q<{ n: number }>(sql`SELECT (SELECT count(*) FROM articles) + (SELECT count(*) FROM article_sizes) + (SELECT count(*) FROM catalog_import_batches) + (SELECT count(*) FROM audit_events) AS n`)
    const res = await applyCatalogImport(h.db, admin, model, input)
    assert.equal(res.noop, true)
    const afterN = await q<{ n: number }>(sql`SELECT (SELECT count(*) FROM articles) + (SELECT count(*) FROM article_sizes) + (SELECT count(*) FROM catalog_import_batches) + (SELECT count(*) FROM audit_events) AS n`)
    assert.equal(Number(afterN[0].n), Number(before[0].n))
  })

  test('trust-source run approves conflicting variants and closes source items only', async () => {
    const res = await applyCatalogImport(h.db, admin, model, { ...input, trustSource: true })
    assert.equal(res.noop, false)
    assert.ok(Number(res.counts.sourceIssuesClosed) >= 1)
    const open = await q<{ kind: string }>(sql`SELECT kind FROM catalog_review_items WHERE status = 'open'`)
    assert.ok(open.every(o => ['brand_code_mismatch', 'retired_variant_in_use', 'retired_size_in_use'].includes(o.kind)))
    assert.ok(open.some(o => o.kind === 'brand_code_mismatch'))
    const [v] = await q<{ reviewStatus: string; color: string }>(sql`SELECT "reviewStatus", color FROM articles WHERE "artCode" = 'SD0323G'`)
    assert.equal(v.reviewStatus, 'approved')
    assert.equal(v.color, 'White Black / Black White')
    const again = await applyCatalogImport(h.db, admin, model, { ...input, trustSource: true })
    assert.equal(again.noop, true)
  })
})
