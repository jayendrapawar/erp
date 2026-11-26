import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { checkStocktakeCarton, countStocktakeCarton, recentStocktakeCartons, undoStocktakeCarton } from '../../lib/inventory/stocktake-carton'
import { recordBoxScan } from '../../lib/inventory/scan-service'
import { receiveCarton, saveBill } from '../../lib/purchases/store'
import type { ParsedBill } from '../../lib/purchases/relaxo-bill'
import type { Actor } from '../../lib/db/types'

// Outer carton labels (compact layout): article(7) colour(4) from(2) to(2) pack, MRP, date, code, serial.
const CARTON_1 = 'PUG105GBRBR0610A339.500109202610101000000011'
const CARTON_2 = 'PUG105GBRBR0610A339.500109202610101000000012'
const CARTON_3 = 'PUG105GBRBR0610A339.500109202610101000000013'
const CARTON_SINGLE = 'SF0192GGFSL0007A199.000109202610101000000021'
const CARTON_UNKNOWN = 'PXZ999GBKBK0610A299.000109202610101000000031'
const BOX_7 = 'A1PUG105G-BRBR0007-0726R10MA0-339.50-1010-Z76BB-1006101799'

const bill: ParsedBill = {
  docType: 'proforma', supplier: 'Relaxo Footwears Limited', refNo: '0520777777/1062', invoiceNo: 'RV0000000009', billDate: '2026-09-01',
  soNo: null, soDate: null, poNo: null, customerCode: null, totalCartons: 1, totalPairs: 30, grossAmount: 6000,
  lines: [{ lineNo: 1, hsn: '64029990', articleCode: 'PUG105G', colourCode: 'BRBR', sizeFrom: '6', sizeTo: '10', packLetter: 'A', description: 'PUG 105', cartons: 1, pairsPerCarton: 30, pairs: 30, mrp: 339.5, rate: 200, amount: 6000 }],
}

describe('stocktake cartons (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const wh: Actor = { id: 'u-wh', name: 'Warehouse' }
  const other: Actor = { id: 'u-other', name: 'Other' }
  const bal = async (code: string, size: string, provenance: string) => Number((await h.db.execute<{ q: number }>(sql`
    SELECT coalesce(sum(b.quantity),0)::int q FROM stock_balances b JOIN article_sizes s ON s.id = b."skuId" JOIN articles a ON a.id = s."articleId"
     WHERE a."artCode" = ${code} AND s."sizeLabel" = ${size} AND b.provenance = ${provenance}`)).rows[0].q)
  const count = (raw: string, answer: Parameters<typeof countStocktakeCarton>[2]['answer'], id = randomUUID(), who = wh) =>
    countStocktakeCarton(h.db, who, { rawInput: raw, clientEventId: id, flag: 'Rack A', answer })

  let gentsId = 0
  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-wh','Warehouse','w@test.local','warehouse'), ('u-other','Other','o@test.local','warehouse')`)
    for (const [name, code, colour, from, to, division, segment] of [['PUG-105', 'PUG105G', 'BRBR', 6, 10, 'Flite PU', 'Gents'], ['SF-192', 'SF0192G', 'GFSL', 6, 10, 'Sparx', 'Gents']] as const) {
      const a = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode",division,segment) VALUES (${name}, ${code}, 'x', ${colour}, ${division}, ${segment}) RETURNING id`)
      await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") SELECT ${a.rows[0].id}, x::text, x FROM generate_series(${from}::int, ${to}::int) x`)
    }
    const g = await h.db.execute<{ id: number }>(sql`INSERT INTO carton_assortments (division, segment, packing, code, sizes) VALUES
      ('Flite PU', 'Gents', 30, '610', '[{"size":"6","pairs":6},{"size":"7","pairs":6},{"size":"8","pairs":6},{"size":"9","pairs":6},{"size":"10","pairs":6}]') RETURNING id`)
    gentsId = Number(g.rows[0].id)
    await h.db.execute(sql`INSERT INTO carton_assortments (division, segment, packing, code, sizes) VALUES
      ('Flite PU', 'Ladies', 20, '610', '[{"size":"6","pairs":4},{"size":"7","pairs":4},{"size":"8","pairs":4},{"size":"9","pairs":4},{"size":"10","pairs":4}]')`)
  })
  after(async () => { await h?.close() })

  test('a carton label proposes the assortment for the article segment; nothing is saved', async () => {
    const c = await checkStocktakeCarton(h.db, CARTON_1)
    assert.equal(c.status, 'confirm')
    if (c.status !== 'confirm') return
    assert.deepEqual(c.sizes, ['6', '7', '8', '9', '10'])
    assert.equal(c.division, 'Flite PU')
    assert.equal(c.options.length, 2)
    assert.equal(c.proposal?.id, gentsId)
    assert.equal(c.invoicePairs, null)
    assert.equal(c.mrp, 339.5)
    assert.equal(Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM carton_receipts`)).rows[0].n), 0)
  })

  test('box labels and unknown articles are refused', async () => {
    const box = await checkStocktakeCarton(h.db, BOX_7)
    assert.ok(box.status === 'rejected' && /box label/.test(box.message))
    const unknown = await checkStocktakeCarton(h.db, CARTON_UNKNOWN)
    assert.ok(unknown.status === 'rejected' && /not in the article master/.test(unknown.message))
  })

  test('counting posts carton stock per size; the same label cannot be counted or received again; a retry replays', async () => {
    const id = randomUUID()
    const r = await count(CARTON_1, { assortmentId: gentsId }, id)
    assert.equal(r.status, 'counted')
    if (r.status !== 'counted') return
    assert.equal(r.pairs, 30)
    assert.equal(await bal('PUG105G', '7', 'carton'), 6)
    const row = (await h.db.execute<{ match: string; flag: string; postedPairs: number; assortmentId: number }>(sql`
      SELECT match, flag, "postedPairs", "assortmentId" FROM carton_receipts WHERE id = ${r.receiptId}`)).rows[0]
    assert.deepEqual([row.match, row.flag, Number(row.postedPairs), Number(row.assortmentId)], ['stocktake', 'Rack A', 30, gentsId])
    const types = (await h.db.execute<{ t: string }>(sql`SELECT DISTINCT "movementType" t FROM stock_movements WHERE "sourceId" = ${String(r.receiptId)}`)).rows
    assert.deepEqual(types.map((x) => x.t), ['stocktake_carton'])

    const replay = await count(CARTON_1, { assortmentId: gentsId }, id)
    assert.ok(replay.status === 'counted' && replay.replay && replay.receiptId === r.receiptId)
    assert.equal(await bal('PUG105G', '7', 'carton'), 6)

    const again = await checkStocktakeCarton(h.db, CARTON_1)
    assert.ok(again.status === 'duplicate' && /counted in stocktake by Warehouse/.test(again.message))
    const twice = await count(CARTON_1, { assortmentId: gentsId })
    assert.equal(twice.status, 'duplicate')
    const recv = await receiveCarton(h.db, wh, { rawInput: CARTON_1, clientEventId: randomUUID() })
    assert.ok(recv.status === 'duplicate' && /counted in stocktake/.test(recv.message))

    const recent = await recentStocktakeCartons(h.db, 'u-wh')
    assert.equal(recent[0].id, r.receiptId)
    assert.equal(recent[0].sizes.length, 5)
  })

  test('a box scanned from a counted carton moves carton → scanned (no double count); undo is then refused', async () => {
    const before7 = await bal('PUG105G', '7', 'carton')
    const s = await recordBoxScan(h.db, wh, { clientEventId: randomUUID(), rawInput: BOX_7 })
    assert.equal(s.status, 'saved')
    assert.equal(await bal('PUG105G', '7', 'carton'), before7 - 1)
    assert.equal(await bal('PUG105G', '7', 'scanned'), 1)
    const [first] = await recentStocktakeCartons(h.db, 'u-wh')
    // Carton stock of size 7 is now 5 < 6: the carton cannot be taken back out.
    const u = await undoStocktakeCarton(h.db, wh, { receiptId: first.id, reason: 'wrong carton', canVoidAny: false })
    assert.ok(!u.ok && /already scanned or billed/.test(u.message))
  })

  test('undo: own carton reverses its stock; someone else needs scan.void.any', async () => {
    const r = await count(CARTON_2, { assortmentId: gentsId })
    assert.equal(r.status, 'counted')
    if (r.status !== 'counted') return
    const was = await bal('PUG105G', '8', 'carton')
    const notMine = await undoStocktakeCarton(h.db, other, { receiptId: r.receiptId, reason: 'test', canVoidAny: false })
    assert.ok(!notMine.ok)
    const ok = await undoStocktakeCarton(h.db, wh, { receiptId: r.receiptId, reason: 'scanned by mistake', canVoidAny: false })
    assert.ok(ok.ok)
    assert.equal(await bal('PUG105G', '8', 'carton'), was - 6)
    // The label is free again.
    assert.equal((await checkStocktakeCarton(h.db, CARTON_2)).status, 'confirm')
  })

  test('typed pairs: must add up to the invoice pairs when known; saved to the master; single-size cartons need no assortment', async () => {
    await saveBill(h.db, wh, bill, { name: 'b.pdf', sha256: 'e'.repeat(64) }, 'Flite PU')
    const c = await checkStocktakeCarton(h.db, CARTON_3)
    assert.ok(c.status === 'confirm')
    if (c.status !== 'confirm') return
    assert.equal(c.invoicePairs, 30)
    assert.ok(c.warnings.some((w) => /open bill 0520777777\/1062/.test(w)))
    assert.equal(c.proposal?.id, gentsId) // the 20-pair Ladies one does not match the invoice's 30

    const wrong = await count(CARTON_3, { newAssortment: { segment: 'Gents', sizes: [{ size: '6', pairs: 10 }, { size: '7', pairs: 10 }] } })
    assert.ok(wrong.status === 'rejected' && /30 pairs/.test(wrong.message))
    const typed = await count(CARTON_3, { newAssortment: { segment: 'Gents', sizes: [{ size: '6', pairs: 10 }, { size: '7', pairs: 10 }, { size: '8', pairs: 10 }] } })
    assert.ok(typed.status === 'counted' && typed.pairs === 30)
    const saved = (await h.db.execute<{ onlyFor: string }>(sql`SELECT "onlyFor" FROM carton_assortments WHERE active AND packing = 30 AND code = '610' AND sizes @> '[{"size":"6","pairs":10}]'`)).rows
    assert.deepEqual(saved.map((x) => x.onlyFor), ['PUG105G'])

    const single = await checkStocktakeCarton(h.db, CARTON_SINGLE)
    assert.ok(single.status === 'confirm' && single.sizes.length === 1 && single.sizes[0] === '7')
    const s = await count(CARTON_SINGLE, { newAssortment: { segment: '', sizes: [{ size: '7', pairs: 24 }] } })
    assert.ok(s.status === 'counted' && s.pairs === 24)
    assert.equal(await bal('SF0192G', '7', 'carton'), 24)
    const outside = await count(CARTON_SINGLE.replace(/21$/, '22'), { newAssortment: { segment: '', sizes: [{ size: '8', pairs: 24 }] } })
    assert.ok(outside.status === 'rejected' && /Only sizes 7/.test(outside.message))
  })
})
