import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan, voidScanEvent } from '../../lib/inventory/scan-service'
import { correctStock, undoCorrection } from '../../lib/inventory/adjust'
import { listMovements, listStock, stockSummary } from '../../lib/inventory/stock-queries'
import type { Actor } from '../../lib/db/types'

// Two real box labels of one SKU (PUG-N42 White size 6, MRP 339.50).
const BOX = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722'
const BOX_2 = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-LE69Q-1006101721'

describe('inventory screen: stock, value, movements, corrections (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  let articleId = 0, sku6 = 0, sku7 = 0, unrelatedId = 0
  const correct = (skuId: number, delta: number, reason = 'counted shelf', requestId = randomUUID()) => correctStock(h.db, admin, { skuId, delta, reason, requestId })

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-admin','Admin','a@test.local','admin')`)
    articleId = Number((await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode","minSize","maxSize",division) VALUES ('PUG-N42','PUGN42G','White','WHWH','6','7','Flite PU') RETURNING id`)).rows[0].id)
    const s = await h.db.execute<{ id: number; sizeLabel: string }>(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES (${articleId},'6',1),(${articleId},'7',2) RETURNING id, "sizeLabel"`)
    sku6 = Number(s.rows.find((r) => r.sizeLabel === '6')!.id)
    sku7 = Number(s.rows.find((r) => r.sizeLabel === '7')!.id)
    unrelatedId = Number((await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode") VALUES ('SS-1','SS0001G','Black','BKBK') RETURNING id`)).rows[0].id)
    await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES (${unrelatedId},'8',1)`)
  })
  after(async () => { await h?.close() })

  test('stock list and value at MRP from scanned boxes', async () => {
    assert.equal((await recordBoxScan(h.db, admin, { clientEventId: randomUUID(), rawInput: BOX })).status, 'saved')
    assert.equal((await recordBoxScan(h.db, admin, { clientEventId: randomUUID(), rawInput: BOX_2 })).status, 'saved')
    const { rows, total } = await listStock(h.db, {})
    assert.equal(total, 1) // only the variant with stock
    const v = rows[0]
    assert.equal(v.articleId, articleId)
    assert.equal(v.division, 'Flite PU')
    assert.equal(v.pairs, 2)
    assert.equal(v.value, 679)
    assert.deepEqual(v.sizes.map((s) => [s.size, s.pairs]), [['6', 2], ['7', 0]])
    assert.equal((await listStock(h.db, { inStockOnly: false })).total, 2)
    assert.equal((await listStock(h.db, { search: 'n42' })).total, 1)
    assert.equal((await listStock(h.db, { division: 'Sparx' })).total, 0)
  })

  test('correction adds unscanned pairs, valued at the size\'s average MRP; retry posts once', async () => {
    const requestId = randomUUID()
    assert.deepEqual(await correct(sku6, 3, 'found in back room', requestId), { posted: true, pairsNow: 5 })
    assert.deepEqual(await correct(sku6, 3, 'found in back room', requestId), { posted: false, pairsNow: 5 })
    const v = (await listStock(h.db, { articleId })).rows[0]
    assert.equal(v.pairs, 5)
    assert.equal(v.value, 1697.5)
    // Size 7 was never scanned: its pairs have no MRP.
    await correct(sku7, 2)
    const v2 = (await listStock(h.db, { articleId })).rows[0]
    assert.equal(v2.unvaluedPairs, 2)
    const sum = await stockSummary(h.db)
    assert.equal(sum.pairs, 7)
    assert.equal(sum.unvaluedPairs, 2)
    assert.equal(sum.variantsInStock, 1)
  })

  test('removal never goes below zero and takes unscanned pairs first', async () => {
    await assert.rejects(correct(sku7, -3), /Only 2 pairs in stock/)
    await correct(sku6, -4, 'damaged') // 3 unscanned + 1 scanned
    const b = await h.db.execute<{ provenance: string; quantity: number }>(sql`SELECT provenance, quantity FROM stock_balances WHERE "skuId" = ${sku6} ORDER BY provenance`)
    assert.deepEqual(b.rows.map((r) => [r.provenance, Number(r.quantity)]), [['scanned', 1], ['unscanned', 0]])
    await assert.rejects(correct(sku6, 1, 'x'), /reason/)
    await assert.rejects(correct(sku6, 0), /whole number/)
  })

  test('movements list kinds, filters and undo of corrections', async () => {
    const all = await listMovements(h.db, {})
    assert.ok(all.rows.length >= 6)
    assert.ok(all.rows.every((m, i) => i === 0 || m.id < all.rows[i - 1].id))
    const scans = await listMovements(h.db, { kind: 'scan' })
    assert.equal(scans.rows.length, 2)
    assert.equal(scans.rows[0].mrp, 339.5)
    const corrections = await listMovements(h.db, { kind: 'correction', articleId })
    assert.ok(corrections.rows.every((m) => m.canUndo && m.kind === 'correction'))
    // Undo the +3 on size 6: unscanned is 0 now, so it would go negative → refused.
    const plus3 = corrections.rows.find((m) => m.quantity === 3)!
    await assert.rejects(undoCorrection(h.db, admin, plus3.id, 'mistake'), /would leave -3/)
    // Undo the removal of 3 unscanned: allowed, once.
    const minus3 = corrections.rows.find((m) => m.quantity === -3)!
    await undoCorrection(h.db, admin, minus3.id, 'entered twice')
    await assert.rejects(undoCorrection(h.db, admin, minus3.id, 'again'), /already undone/)
    const after = await listMovements(h.db, { kind: 'undo' })
    assert.equal(after.rows[0].quantity, 3)
    assert.equal((await listMovements(h.db, { kind: 'correction' })).rows.find((m) => m.id === minus3.id)!.canUndo, false)
    // Scans are undone from the scanner, not here.
    await assert.rejects(undoCorrection(h.db, admin, scans.rows[0].id, 'not allowed'), /Only hand corrections/)
    // Keyset paging.
    const p1 = await listMovements(h.db, { limit: 2 })
    const p2 = await listMovements(h.db, { limit: 2, before: p1.rows[1].id })
    assert.equal(p1.hasMore, true)
    assert.ok(p2.rows[0].id < p1.rows[1].id)
    // Date filter (India time): everything happened today.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    assert.equal((await listMovements(h.db, { from: today, to: today })).rows.length, all.rows.length + 1)
    assert.equal((await listMovements(h.db, { to: '2000-01-01' })).rows.length, 0)
  })

  test('voiding a scan lowers value at MRP; ledger and balances agree', async () => {
    const before = (await listStock(h.db, { articleId })).rows[0]
    const ev = await h.db.execute<{ id: number }>(sql`SELECT id FROM scan_events WHERE status = 'active' ORDER BY id LIMIT 1`)
    await voidScanEvent(h.db, admin, { eventId: Number(ev.rows[0].id), reason: 'test undo', canVoidAny: true })
    const v = (await listStock(h.db, { articleId })).rows[0]
    assert.equal(v.pairs, before.pairs - 1)
    const mism = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM stock_balance_mismatches`)
    assert.equal(Number(mism.rows[0].n), 0)
  })
})
