import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan } from '../../lib/inventory/scan-service'
import { correctStock } from '../../lib/inventory/adjust'
import {
  addDraftScan, createDraft, discardDraft, generateDirectBill, listOpenDrafts, loadDraft, recordOrderScans,
  releaseOrderScans, removeDraftScans, saveDraftHeader,
} from '../../lib/billing/bill-stock'
import { listUnscannedDispatch, stockSummary } from '../../lib/inventory/stock-queries'
import { listMissingArticles } from '../../lib/catalog/missing-articles'
import type { Actor } from '../../lib/db/types'

// Real labels (regression corpus). BOX and BOX_2: PUG-N42 White size 6, MRP 339.50.
const BOX = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722'
const BOX_2 = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-LE69Q-1006101721'
const BOX_SIZE_8 = 'A1PUGN42G-WHWH0008-0726R10MA0-339.50-1010-CJASC-1006106444' // size 8 not in the master
const UNKNOWN_BOX = 'A1SS0703G-NBOR0007-1026R05MA0-649.00-1005-44GSY-1020602214' // article not in the master
const CARTON = 'PUGN42GWHWH0608A339.500109202610101004961646'

describe('billing takes stock out (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const biller: Actor = { id: 'u-biller', name: 'Biller' }
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  let sku6 = 0
  const bal = async (provenance: string) => Number((await h.db.execute<{ q: number }>(sql`SELECT coalesce(sum(quantity),0)::int q FROM stock_balances WHERE "skuId" = ${sku6} AND provenance = ${provenance}`)).rows[0].q)
  const add = (draftId: number, raw: string, id = randomUUID()) => addDraftScan(h.db, biller, draftId, raw, id)
  const mismatches = async () => Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM stock_balance_mismatches`)).rows[0].n)

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-biller','Biller','b@test.local','biller'), ('u-admin','Admin','a@test.local','admin')`)
    const art = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode") VALUES ('PUG-N42','PUGN42G','White','WHWH') RETURNING id`)
    const s = await h.db.execute<{ id: number }>(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES (${art.rows[0].id},'6',1),(${art.rows[0].id},'7',2) RETURNING id`)
    sku6 = Number(s.rows[0].id)
    // Warehouse: BOX scanned into stock; one more pair of size 6 counted by hand (unscanned).
    assert.equal((await recordBoxScan(h.db, admin, { clientEventId: randomUUID(), rawInput: BOX })).status, 'saved')
    await correctStock(h.db, admin, { skuId: sku6, delta: 1, reason: 'counted by hand', requestId: randomUUID() })
  })
  after(async () => { await h?.close() })

  let draftId = 0
  let orderId = 0

  test('a draft saves every scan; a box can be on one bill only', async () => {
    draftId = await createDraft(h.db, biller)
    const id1 = randomUUID()
    const a = await add(draftId, BOX, id1)
    assert.deepEqual([a.status, a.status === 'added' && a.inStock], ['added', true])
    const replay = await add(draftId, BOX, id1)
    assert.equal(replay.status, 'added')
    const again = await add(draftId, BOX)
    assert.equal(again.status, 'on_other_bill')
    assert.match((again as { message: string }).message, /this bill/)
    const b = await add(draftId, BOX_2)
    assert.deepEqual([b.status, b.status === 'added' && b.inStock], ['added', false])
    assert.equal((await add(draftId, UNKNOWN_BOX)).status, 'added')
    assert.equal((await add(draftId, CARTON)).status, 'rejected')
    // Another draft cannot take a reserved box.
    const other = await createDraft(h.db, biller)
    const o = await add(other, BOX)
    assert.equal(o.status, 'on_other_bill')
    assert.match((o as { message: string }).message, /another draft/)
    await discardDraft(h.db, biller, other)
    // Remove and re-add a box.
    assert.equal(await removeDraftScans(h.db, draftId, [UNKNOWN_BOX], 'test'), 1)
    assert.equal((await add(draftId, UNKNOWN_BOX)).status, 'added')
    await saveDraftHeader(h.db, draftId, { shopkeeperName: 'Test Shop', lineDiscPct: 25, manualLines: [{ artNumber: 'fl-20', mrp: 239.5, qty: 2 }] })
    const d = await loadDraft(h.db, draftId)
    assert.equal(d.scans.length, 3)
    assert.deepEqual(d.manualLines, [{ artNumber: 'FL-20', mrp: 239.5, qty: 2 }])
    const open = await listOpenDrafts(h.db)
    assert.deepEqual(open.map((x) => [x.id, x.boxes, x.manualPairs]), [[draftId, 3, 2]])
    // Nothing has left stock yet.
    assert.deepEqual([await bal('scanned'), await bal('unscanned')], [1, 1])
  })

  test('generating takes boxes out: exact box → scanned, else hand-counted → unscanned, else Unscanned dispatch', async () => {
    await assert.rejects(generateDirectBill(h.db, biller, draftId, { shopkeeperName: '' }), /retailer/)
    const bill = await generateDirectBill(h.db, biller, draftId, { shopkeeperName: 'Test Shop', lineDiscPct: 25, manualLines: [{ artNumber: 'FL-20', mrp: 239.5, qty: 2 }] })
    orderId = bill.id
    assert.deepEqual(bill.stock, { scanned: 1, carton: 0, unscanned: 1, unscanned_dispatch: 1 })
    assert.deepEqual(bill.lines.map((l) => [l.artNumber, l.mrp, l.qty]).sort(), [['FL-20', 239.5, 2], ['PUGN42G', 339.5, 2], ['SS0703G', 649, 1]])
    assert.deepEqual([await bal('scanned'), await bal('unscanned')], [0, 0])
    const o = (await h.db.execute<{ status: string; isEmergency: boolean }>(sql`SELECT status, "isEmergency" FROM orders WHERE id = ${orderId}`)).rows[0]
    assert.deepEqual([o.status, o.isEmergency], ['billed', true])
    await assert.rejects(generateDirectBill(h.db, biller, draftId, { shopkeeperName: 'Test Shop' }), /already generated/)
    assert.equal((await listOpenDrafts(h.db)).length, 0)
    const disp = await listUnscannedDispatch(h.db)
    assert.deepEqual(disp.rows.map((r) => [r.articleCode, r.size, r.artName]), [['SS0703G', '7', null]])
    assert.equal((await stockSummary(h.db)).unscannedDispatch, 1)
    assert.equal(await mismatches(), 0)
  })

  test('deleting the bill puts its boxes back and frees them', async () => {
    await h.db.transaction(async (tx) => {
      assert.equal(await releaseOrderScans(tx, admin, orderId, 'Direct Bill deleted'), 3)
      await tx.execute(sql`DELETE FROM orders WHERE id = ${orderId}`)
    })
    assert.deepEqual([await bal('scanned'), await bal('unscanned')], [1, 1])
    assert.equal((await listUnscannedDispatch(h.db)).rows.length, 0)
    const d2 = await createDraft(h.db, biller)
    assert.equal((await add(d2, BOX)).status, 'added')
    await discardDraft(h.db, biller, d2)
    assert.equal(await mismatches(), 0)
  })

  test('order invoices: boxes leave stock; a box on another bill refuses the whole invoice; re-billing is clean', async () => {
    const mk = async (n: string) => Number((await h.db.execute<{ id: number }>(sql`INSERT INTO orders ("orderNumber","shopkeeperName",status) VALUES (${n},'Shop','packed') RETURNING id`)).rows[0].id)
    const o1 = await mk('ORD-T-1')
    const o2 = await mk('ORD-T-2')
    const r1 = await h.db.transaction((tx) => recordOrderScans(tx, biller, o1, 'ORD-T-1', [BOX, BOX, BOX_SIZE_8, 'garbage']))
    assert.deepEqual(r1, { scanned: 1, carton: 0, unscanned: 0, unscanned_dispatch: 1, skipped: 2 })
    assert.equal(await bal('scanned'), 0)
    await assert.rejects(h.db.transaction((tx) => recordOrderScans(tx, biller, o2, 'ORD-T-2', [BOX_2, BOX])), /already on another bill: PUGN42G size 6 \(bill ORD-T-1\)/)
    assert.equal(await bal('unscanned'), 1) // rolled back: BOX_2 did not leave stock
    // Billing order 1 again (e.g. after edits) releases and re-posts: no double count.
    const r2 = await h.db.transaction((tx) => recordOrderScans(tx, biller, o1, 'ORD-T-1', [BOX]))
    assert.deepEqual(r2, { scanned: 1, carton: 0, unscanned: 0, unscanned_dispatch: 0, skipped: 0 })
    assert.deepEqual([await bal('scanned'), await bal('unscanned')], [0, 1])
    const active = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM bill_scans WHERE "orderId" = ${o1} AND status = 'active'`)
    assert.equal(Number(active.rows[0].n), 1)
    // An order with boxes cannot be deleted before they are released.
    await assert.rejects(h.db.execute(sql`DELETE FROM orders WHERE id = ${o1}`))
    assert.equal(await mismatches(), 0)
  })

  test('Direct Billing tells whether each box\'s article is in the master (new article detection)', async () => {
    const d = await createDraft(h.db, biller)
    const master = async (raw: string) => {
      const out = await add(d, raw)
      assert.equal(out.status, 'added', raw)
      return out.status === 'added' ? out.master : null
    }
    // PUG-N42 White (in the master), size 7.
    assert.deepEqual(await master('A1PUGN42G-WHWH0007-0726R10MA0-339.50-1010-QQ7AA-1006109001'), { status: 'known' })
    // Same article code, colour BKBK not in the master.
    assert.deepEqual(await master('A1PUGN42G-BKBK0006-0726R10MA0-339.50-1010-QQ7AB-1006109002'), { status: 'new_colour', artName: 'PUG-N42' })
    // Article code not in the master.
    assert.deepEqual(await master('A1SS0999G-NBOR0007-1026R05MA0-649.00-1005-QQ7AC-1020609003'), { status: 'unknown' })
    // A retired article counts as not in the master.
    await h.db.execute(sql`INSERT INTO articles ("artName","artCode",color,"colorCode",active) VALUES ('OLD-1','OLD0001','Black','BKBK',false)`)
    assert.deepEqual(await master('A1OLD0001-BKBK0006-0726R10MA0-339.50-1010-QQ7AD-1006109004'), { status: 'unknown' })
    // Billed boxes of unknown articles/colours appear in Master → Articles → Missing articles.
    const missing = new Map((await listMissingArticles(h.db)).map((m) => [`${m.artCode}|${m.colorCode}`, m]))
    assert.ok(missing.has('SS0999G|NBOR'))
    assert.ok(missing.has('PUGN42G|BKBK'))
    assert.ok(missing.has('OLD0001|BKBK'))
    assert.equal(missing.get('SS0999G|NBOR')?.kind, 'missing_article')
    assert.deepEqual(missing.get('SS0999G|NBOR')?.scannedBy, ['Biller'])
    assert.ok(!missing.has('PUGN42G|WHWH'), 'a known article is not listed')
    // Discarding the draft frees its boxes; they leave the list.
    await discardDraft(h.db, biller, d)
    const after = new Set((await listMissingArticles(h.db)).map((m) => `${m.artCode}|${m.colorCode}`))
    assert.ok(!after.has('SS0999G|NBOR'))
  })
})
