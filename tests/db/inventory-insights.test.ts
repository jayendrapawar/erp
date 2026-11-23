import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan } from '../../lib/inventory/scan-service'
import { addDraftScan, createDraft, generateDirectBill } from '../../lib/billing/bill-stock'
import { inventoryInsights } from '../../lib/inventory/insights'
import type { Actor } from '../../lib/db/types'

// Box label: article(…) colour(4) size(4) - MMYY + plant/line - MRP - … - serial. MMYY = manufacturing month.
const box = (art: string, col: string, size: number, mmyy: string, serial: number) =>
  `A1${art}-${col}${String(size).padStart(4, '0')}-${mmyy}R10MA0-339.50-1010-Z${String(serial).padStart(4, '0')}-10061${String(serial).padStart(5, '0')}`

describe('inventory overview: old, cut size, idle, movers, reorder (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const wh: Actor = { id: 'u-wh', name: 'Warehouse' }
  let serial = 1
  const scan = async (raw: string) => assert.equal((await recordBoxScan(h.db, wh, { clientEventId: randomUUID(), rawInput: raw })).status, 'saved')

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName") VALUES ('V901', 'Test Shop')`) // billing needs a master retailer
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-wh','Warehouse','w@test.local','admin')`)
    for (const [name, code, col, seg] of [['PUG-105', 'PUG105G', 'BRBR', 'Gents'], ['PUG-200', 'PUG200G', 'BKBK', 'Gents'], ['PUG-300', 'PUG300G', 'TNTN', null]] as const) {
      const a = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode",segment) VALUES (${name}, ${code}, ${col === 'BRBR' ? 'Brown' : col === 'BKBK' ? 'Black' : 'Tan'}, ${col}, ${seg}) RETURNING id`)
      await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") SELECT ${a.rows[0].id}, x::text, x FROM generate_series(6, 9) x`)
    }
    // PUG105G: 4 pairs of each size 6–9, made Jul 2026 (new). Sizes 8 and 9 then sell 3 each.
    for (const s of [6, 7, 8, 9]) for (let i = 0; i < 4; i++) await scan(box('PUG105G', 'BRBR', s, '0726', serial++))
    // PUG200G: old stock (made Jul 2024): size 6 ×4, size 7 ×1 (cut size), sizes 8–9 none.
    for (let i = 0; i < 4; i++) await scan(box('PUG200G', 'BKBK', 6, '0724', serial++))
    await scan(box('PUG200G', 'BKBK', 7, '0724', serial++))
    // PUG300G: 2 pairs each size, never sold; its history is moved back 200 days below (dead).
    for (const s of [6, 7, 8, 9]) for (let i = 0; i < 2; i++) await scan(box('PUG300G', 'TNTN', s, '0726', serial++))
    // Test-only back-dating: the ledger is append-only, so its guard is switched off for this one update.
    await h.db.execute(sql`ALTER TABLE stock_movements DISABLE TRIGGER USER`)
    await h.db.execute(sql`UPDATE stock_movements m SET "createdAt" = now() - interval '200 days'
      FROM article_sizes s JOIN articles a ON a.id = s."articleId" WHERE m."skuId" = s.id AND a."artCode" = 'PUG300G'`)
    await h.db.execute(sql`ALTER TABLE stock_movements ENABLE TRIGGER USER`)
    // Sell 3 pairs each of PUG105G sizes 8 and 9.
    const draft = await createDraft(h.db, wh)
    const sold = (await h.db.execute<{ raw: string }>(sql`SELECT "rawInput" AS raw FROM scan_events WHERE "articleCode" = 'PUG105G' AND "sizeLabel" IN ('8','9') ORDER BY id`)).rows
    for (const r of [...sold.filter((x) => x.raw.includes('BRBR0008')).slice(0, 3), ...sold.filter((x) => x.raw.includes('BRBR0009')).slice(0, 3)]) {
      assert.equal((await addDraftScan(h.db, wh, draft, r.raw, randomUUID())).status, 'added')
    }
    await generateDirectBill(h.db, wh, draft, { shopkeeperName: 'Test Shop' })
  })
  after(async () => { await h?.close() })

  test('sections follow the owner\'s rules', async () => {
    const x = await inventoryInsights(h.db)
    // Old stock: 5 pairs of PUG200G made Jul 2024; sold boxes are not counted.
    assert.equal(x.old.totals.old, 5)
    assert.deepEqual(x.old.rows.map((r) => [r.artCode, r.bands.old]), [['PUG200G', 5]])
    assert.equal(x.old.totals.lt6, 16 - 6 + 8)
    // Cut size: PUG105G sizes 8/9 have 1 left vs 4 (≤ half); PUG200G has 7 at 1 of 4 and 8/9 missing.
    const cut = new Map(x.cut.rows.map((r) => [r.artCode, r]))
    assert.deepEqual(cut.get('PUG105G')?.short, ['8', '9'])
    assert.deepEqual(cut.get('PUG200G')?.missing, ['8', '9'])
    assert.equal(cut.has('PUG300G'), false)
    // Dead: PUG300G unsold for 200 days.
    assert.deepEqual(x.idle.rows.map((r) => [r.artCode, r.idleDays >= 180]), [['PUG300G', true]])
    assert.deepEqual([x.idle.dead.count, x.idle.dead.pairs, x.idle.nonMoving.count], [1, 8, 0])
    // Movers: 6 pairs of PUG105G in 7 / 30 / 90 days.
    assert.deepEqual(x.movers[30].rows.map((r) => [r.artCode, r.sold]), [['PUG105G', 6]])
    // Reorder: sizes 8 and 9 sold 3 in 30 days with 1 left → 10 days of cover → order 5 (60 days at 0.1/day = 6, minus 1).
    assert.deepEqual(x.reorder.rows.map((r) => [r.size, r.pairs, r.coverDays, r.suggest]), [['8', 1, 10, 5], ['9', 1, 10, 5]])
    // Size mix: 8 and 9 are all the sales but a small share of stock → selling ahead.
    assert.deepEqual(x.sizes.filter((s) => s.ahead).map((s) => s.key), ['8', '9'])
  })
})
