import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan, voidScanEvent } from '../../lib/inventory/scan-service'
import { addDraftScan, createDraft, generateDirectBill } from '../../lib/billing/bill-stock'
import { billDetail, cancelBill, expectedStock, listBills, purchaseSummary, receiveCarton, saveBill, setLineAssortment, voidCartonReceipt } from '../../lib/purchases/store'
import type { ParsedBill } from '../../lib/purchases/relaxo-bill'
import type { Actor } from '../../lib/db/types'

// Compact carton labels: article(7) colour(4) from(2) to(2) pack, MRP, DDMMYYYY, 4-digit code, serial.
const carton = (art: string, col: string, range: string, serial: string, mrp = '339.50') => `${art}${col}${range}A${mrp}010920261010${serial}`
const BOX_7 = 'A1PUG105G-BRBR0007-0726R10MA0-339.50-1010-Z76BB-1006101799'
const BOX_8 = 'A1PUG105G-BRBR0008-0726R10MA0-339.50-1010-Z76BC-1006101798'

const bill: ParsedBill = {
  docType: 'proforma', supplier: 'Relaxo Footwears Limited', refNo: '0520999999/1062', invoiceNo: 'RV0000000009', billDate: '2026-09-01',
  soNo: null, soDate: null, poNo: null, customerCode: null, totalCartons: 3, totalPairs: 84, grossAmount: 25000,
  lines: [
    { lineNo: 1, hsn: '64029990', articleCode: 'PUG105G', colourCode: 'BRBR', sizeFrom: '6', sizeTo: '10', packLetter: 'A', description: 'PUG 105 GENTS', cartons: 2, pairsPerCarton: 30, pairs: 60, mrp: 339.5, rate: 226.35, amount: 13581 },
    { lineNo: 2, hsn: '64029990', articleCode: 'PUG999G', colourCode: 'BKBK', sizeFrom: '6', sizeTo: '8', packLetter: 'A', description: 'PUG 999 GENTS', cartons: 1, pairsPerCarton: 24, pairs: 24, mrp: 299.5, rate: 199.65, amount: 4791.6 },
  ],
}

describe('purchases: expected stock, carton receiving (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const wh: Actor = { id: 'u-wh', name: 'Warehouse' }
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  let billId = 0
  const sku: Record<string, number> = {}
  const bal = async (size: string, provenance: string) => Number((await h.db.execute<{ q: number }>(sql`SELECT coalesce(sum(quantity),0)::int q FROM stock_balances WHERE "skuId" = ${sku[size]} AND provenance = ${provenance}`)).rows[0].q)
  const receive = (raw: string, billFilter?: number) => receiveCarton(h.db, wh, { rawInput: raw, clientEventId: randomUUID(), billId: billFilter ?? null })
  const mismatches = async () => Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM stock_balance_mismatches`)).rows[0].n)

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-wh','Warehouse','w@test.local','warehouse'), ('u-admin','Admin','a@test.local','admin')`)
    const a = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode") VALUES ('PUG-105','PUG105G','Brown','BRBR') RETURNING id`)
    const s = await h.db.execute<{ id: number; sizeLabel: string }>(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder")
      SELECT ${a.rows[0].id}, x::text, x FROM generate_series(6, 10) x RETURNING id, "sizeLabel"`)
    for (const r of s.rows) sku[r.sizeLabel] = Number(r.id)
    await h.db.execute(sql`INSERT INTO carton_assortments (division, segment, packing, code, sizes) VALUES
      ('Flite PU', 'Gents', 30, '610', '[{"size":"6","pairs":6},{"size":"7","pairs":6},{"size":"8","pairs":6},{"size":"9","pairs":6},{"size":"10","pairs":6}]')`)
  })
  after(async () => { await h?.close() })

  test('a bill becomes expected stock; the single fitting assortment is chosen; duplicates are skipped', async () => {
    const r = await saveBill(h.db, admin, bill, { name: '0520999999.PDF', sha256: 'a'.repeat(64) }, 'Flite PU')
    assert.equal(r.status, 'saved')
    if (r.status !== 'saved') return
    billId = r.id
    assert.equal(r.assortmentsFound, 1)
    assert.equal((await saveBill(h.db, admin, bill, { name: 'copy.pdf', sha256: 'b'.repeat(64) }, 'Flite PU')).status, 'duplicate')
    const [b] = await listBills(h.db)
    assert.deepEqual([b.status, b.expectedOn, b.totalCartons, b.receivedCartons], ['expected', '2026-09-06', 3, 0])
    assert.equal(b.overdue, true) // 6 Sep 2026 is before today
    const exp = await expectedStock(h.db)
    assert.deepEqual(exp.map((e) => [e.articleCode, e.cartons, e.pairs, e.articleName]), [['PUG105G', 2, 60, 'PUG-105'], ['PUG999G', 1, 24, null]])
  })

  test('receiving: matched carton → +assortment pairs as carton stock; duplicate, box label and unknown cartons handled', async () => {
    const r1 = await receive(carton('PUG105G', 'BRBR', '0610', '1000000001'))
    assert.equal(r1.status, 'received')
    assert.ok(r1.status === 'received' && r1.match === 'matched' && r1.posted && r1.postedPairs === 30 && r1.lineReceived === 1)
    assert.deepEqual(await Promise.all(['6', '7', '10'].map((s) => bal(s, 'carton'))), [6, 6, 6])
    assert.equal((await receive(carton('PUG105G', 'BRBR', '0610', '1000000001'))).status, 'duplicate')
    assert.equal((await receive(BOX_7)).status, 'rejected')
    const unknown = await receive(carton('PUG105G', 'TNTN', '0610', '1000000002'))
    assert.ok(unknown.status === 'received' && unknown.match === 'unexpected')
    // Line 2: article not in the master and no assortment → recorded, not in stock.
    const r2 = await receive(carton('PUG999G', 'BKBK', '0608', '1000000003', '299.50'))
    assert.ok(r2.status === 'received' && r2.match === 'matched' && !r2.posted && /assortment/.test(r2.pendingReason ?? ''))
    const sum = await purchaseSummary(h.db)
    assert.deepEqual([sum.unexpectedCartons, sum.cartonsWaitingForStock, sum.cartonsExpected], [1, 1, 1])
    // Line 1 second carton, then a third one is more than the bill lists → unexpected.
    assert.ok((await receive(carton('PUG105G', 'BRBR', '0610', '1000000004'))).status === 'received')
    const over = await receive(carton('PUG105G', 'BRBR', '0610', '1000000005'))
    assert.ok(over.status === 'received' && over.match === 'unexpected')
    const d = await billDetail(h.db, billId)
    assert.equal(d!.bill.status, 'received')
    assert.deepEqual(d!.lines.map((l) => [l.receivedCartons, l.postedCartons]), [[2, 2], [1, 0]])
    assert.equal((await expectedStock(h.db)).length, 0)
    await assert.rejects(cancelBill(h.db, admin, billId, 'not coming'), /already received/)
    assert.equal(await mismatches(), 0)
  })

  test('a box scanned from a received carton moves carton → scanned; undo moves it back', async () => {
    const before7 = await bal('7', 'carton')
    const r = await recordBoxScan(h.db, wh, { clientEventId: randomUUID(), rawInput: BOX_7 })
    assert.equal(r.status, 'saved')
    assert.deepEqual([await bal('7', 'carton'), await bal('7', 'scanned')], [before7 - 1, 1])
    if (r.status === 'saved') await voidScanEvent(h.db, admin, { eventId: r.event.id, reason: 'test undo', canVoidAny: true })
    assert.deepEqual([await bal('7', 'carton'), await bal('7', 'scanned')], [before7, 0])
    assert.equal(await mismatches(), 0)
  })

  test('billing a box with carton stock takes it from carton stock', async () => {
    const before8 = await bal('8', 'carton')
    const draft = await createDraft(h.db, admin)
    assert.equal((await addDraftScan(h.db, admin, draft, BOX_8, randomUUID())).status, 'added')
    const out = await generateDirectBill(h.db, admin, draft, { shopkeeperName: 'Shop' })
    assert.deepEqual(out.stock, { scanned: 0, carton: 1, unscanned: 0, unscanned_dispatch: 0 })
    assert.equal(await bal('8', 'carton'), before8 - 1)
  })

  test('choosing an assortment later posts waiting cartons once the article exists; undoing a carton reverses its stock', async () => {
    const lineId = Number((await h.db.execute<{ id: number }>(sql`SELECT id FROM purchase_bill_lines WHERE "billId" = ${billId} AND "lineNo" = 2`)).rows[0].id)
    const asg = await h.db.execute<{ id: number }>(sql`INSERT INTO carton_assortments (division, segment, packing, code, sizes) VALUES
      ('Flite PU', 'Gents', 24, '608', '[{"size":"6","pairs":8},{"size":"7","pairs":8},{"size":"8","pairs":8}]') RETURNING id`)
    await assert.rejects(setLineAssortment(h.db, admin, lineId, 999999), /does not fit/)
    assert.deepEqual(await setLineAssortment(h.db, admin, lineId, Number(asg.rows[0].id)), { posted: 0 }) // article still missing
    // Undo the first carton of line 1: 6 pairs per size go back out of carton stock.
    const first = Number((await h.db.execute<{ id: number }>(sql`SELECT id FROM carton_receipts WHERE "billId" = ${billId} AND "articleCode" = 'PUG105G' AND status = 'active' ORDER BY id LIMIT 1`)).rows[0].id)
    const c6 = await bal('6', 'carton')
    await voidCartonReceipt(h.db, admin, first, 'scanned wrong carton')
    assert.equal(await bal('6', 'carton'), c6 - 6)
    const [b] = await listBills(h.db)
    assert.deepEqual([b.status, b.receivedCartons], ['partial', 2])
    await assert.rejects(voidCartonReceipt(h.db, admin, first, 'again'), /already undone/)
    assert.equal(await mismatches(), 0)
  })
})
