import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { saveBill, voidCartonReceipt } from '../../lib/purchases/store'
import { manualCartonOptions, receiveManualCarton } from '../../lib/purchases/manual-carton'
import type { ParsedBill } from '../../lib/purchases/relaxo-bill'
import type { Actor } from '../../lib/db/types'

// Pair boxes (inside cartons whose labels are damaged).
const BOX_PUG_7 = 'A1PUG105G-BRBR0007-0726R10MA0-339.50-1010-Z76BB-1006101799'
const BOX_PUG_8 = 'A1PUG105G-BRBR0008-0726R10MA0-339.50-1010-Z76BC-1006101798'
const BOX_NEW_4 = 'A1PXL005L-BKBK0004-0826R10MA0-299.00-1010-Z76BD-1006101797'
const BOX_NEW_5 = 'A1PXL005L-BKBK0005-0826R10MA0-299.00-1010-Z76BE-1006101796'
const CARTON = 'PUG105GBRBR0610A339.50010920261010100000001'

const bill: ParsedBill = {
  docType: 'proforma', supplier: 'Relaxo Footwears Limited', refNo: '0520888888/1062', invoiceNo: 'RV0000000008', billDate: '2026-09-01',
  soNo: null, soDate: null, poNo: null, customerCode: null, totalCartons: 4, totalPairs: 108, grossAmount: 25000,
  lines: [
    { lineNo: 1, hsn: '64029990', articleCode: 'PUG105G', colourCode: 'BRBR', sizeFrom: '6', sizeTo: '10', packLetter: 'A', description: 'PUG 105', cartons: 2, pairsPerCarton: 30, pairs: 60, mrp: 339.5, rate: 226.35, amount: 13581 },
    { lineNo: 2, hsn: '64029990', articleCode: 'PXL005L', colourCode: 'BKBK', sizeFrom: '3', sizeTo: '8', packLetter: 'A', description: 'PXL 05', cartons: 2, pairsPerCarton: 24, pairs: 48, mrp: 299, rate: 199, amount: 9552 },
  ],
}

describe('purchases: manual carton entry (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const wh: Actor = { id: 'u-wh', name: 'Warehouse' }
  const bal = async (code: string, size: string) => Number((await h.db.execute<{ q: number }>(sql`
    SELECT coalesce(sum(b.quantity),0)::int q FROM stock_balances b JOIN article_sizes s ON s.id = b."skuId" JOIN articles a ON a.id = s."articleId"
     WHERE a."artCode" = ${code} AND s."sizeLabel" = ${size} AND b.provenance = 'carton'`)).rows[0].q)

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-wh','Warehouse','w@test.local','warehouse')`)
    for (const [name, code, colour, from, to, segment] of [['PUG-105', 'PUG105G', 'BRBR', 6, 10, null], ['PXL-05', 'PXL005L', 'BKBK', 3, 8, 'Ladies']] as const) {
      const a = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode",segment) VALUES (${name}, ${code}, 'x', ${colour}, ${segment}) RETURNING id`)
      await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") SELECT ${a.rows[0].id}, x::text, x FROM generate_series(${from}::int, ${to}::int) x`)
    }
    await h.db.execute(sql`INSERT INTO carton_assortments (division, segment, packing, code, sizes) VALUES
      ('Flite PU', 'Gents', 30, '610', '[{"size":"6","pairs":6},{"size":"7","pairs":6},{"size":"8","pairs":6},{"size":"9","pairs":6},{"size":"10","pairs":6}]')`)
    const r = await saveBill(h.db, wh, bill, { name: 'b.pdf', sha256: 'c'.repeat(64) }, 'Flite PU')
    assert.equal(r.status, 'saved')
  })
  after(async () => { await h?.close() })

  test('a pair box lists the open invoice lines; pairs per carton come from the invoice', async () => {
    const o = await manualCartonOptions(h.db, BOX_PUG_7)
    assert.ok(o.ok)
    if (!o.ok) return
    assert.deepEqual([o.box.articleCode, o.box.colourCode, o.box.size, o.box.mfg, o.box.articleName], ['PUG105G', 'BRBR', '7', '07/2026', 'PUG-105'])
    assert.deepEqual(o.lines.map((l) => [l.sizeFrom, l.sizeTo, l.pairsPerCarton, l.fitsBox, l.assortment?.segment]), [['6', '10', 30, true, 'Gents']])
    const carton = await manualCartonOptions(h.db, CARTON)
    assert.ok(!carton.ok && /carton label/.test(carton.message))
  })

  test('known assortment: received against the line, stock posted; the same box cannot receive twice; undo works', async () => {
    const [line] = (await manualCartonOptions(h.db, BOX_PUG_7) as { ok: true; lines: { lineId: number }[] }).lines
    const r = await receiveManualCarton(h.db, wh, { rawBox: BOX_PUG_7, clientEventId: randomUUID(), lineId: line.lineId })
    assert.ok(r.status === 'received' && r.match === 'matched' && r.posted && r.postedPairs === 30 && r.lineReceived === 1)
    assert.equal(await bal('PUG105G', '7'), 6)
    const again = await receiveManualCarton(h.db, wh, { rawBox: BOX_PUG_7, clientEventId: randomUUID(), lineId: line.lineId })
    assert.equal(again.status, 'duplicate')
    if (r.status === 'received') await voidCartonReceipt(h.db, wh, r.receiptId, 'test undo')
    assert.equal(await bal('PUG105G', '7'), 0)
    const r2 = await receiveManualCarton(h.db, wh, { rawBox: BOX_PUG_8, clientEventId: randomUUID(), lineId: line.lineId })
    assert.ok(r2.status === 'received' && r2.match === 'matched' && r2.posted)
  })

  test('no assortment in the master: asks, validates the total, saves it to the master and uses it next time', async () => {
    const o = await manualCartonOptions(h.db, BOX_NEW_4)
    assert.ok(o.ok)
    if (!o.ok) return
    const line = o.lines[0]
    assert.deepEqual([line.sizes, line.pairsPerCarton, line.assortment, line.options.length, o.box.segment], [['3', '4', '5', '6', '7', '8'], 24, null, 0, 'Ladies'])
    const ask = await receiveManualCarton(h.db, wh, { rawBox: BOX_NEW_4, clientEventId: randomUUID(), lineId: line.lineId })
    assert.equal(ask.status, 'needs_assortment')
    const sizes = (n: number[]) => line.sizes.map((s, i) => ({ size: s, pairs: n[i] }))
    await assert.rejects(receiveManualCarton(h.db, wh, { rawBox: BOX_NEW_4, clientEventId: randomUUID(), lineId: line.lineId, newAssortment: { segment: 'Ladies', sizes: sizes([4, 4, 4, 4, 4, 2]) } }), /add up to 22 pairs/)
    const r = await receiveManualCarton(h.db, wh, { rawBox: BOX_NEW_4, clientEventId: randomUUID(), lineId: line.lineId, newAssortment: { segment: 'Ladies', sizes: sizes([4, 4, 4, 4, 4, 4]) } })
    assert.ok(r.status === 'received' && r.match === 'matched' && r.posted && r.postedPairs === 24)
    assert.equal(await bal('PXL005L', '3'), 4)
    const saved = (await h.db.execute<{ segment: string; code: string; packing: number }>(sql`SELECT segment, code, packing FROM carton_assortments WHERE code = '308'`)).rows
    assert.deepEqual(saved, [{ segment: 'Ladies', code: '308', packing: 24 }])
    // Next carton of the line: the assortment is on the line now; no question.
    const next = await manualCartonOptions(h.db, BOX_NEW_5)
    assert.ok(next.ok && next.lines[0].assortment?.segment === 'Ladies')
    const r2 = await receiveManualCarton(h.db, wh, { rawBox: BOX_NEW_5, clientEventId: randomUUID(), lineId: line.lineId })
    assert.ok(r2.status === 'received' && r2.match === 'matched' && r2.posted)
    const mism = Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM stock_balance_mismatches`)).rows[0].n)
    assert.equal(mism, 0)
  })
})
