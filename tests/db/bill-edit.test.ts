// Edit a billed bill by scanning boxes on / off (owner, 24 Nov 2026). lib/billing/edit-bill.ts.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan } from '../../lib/inventory/scan-service'
import { recordOrderScans } from '../../lib/billing/bill-stock'
import { freezeSaleBill } from '../../lib/billing/sale-bill'
import { editBillByScan, loadBillForEdit } from '../../lib/billing/edit-bill'
import { readBoxLabel } from '../../lib/billing/box-label'
import { computeBillTotals, ratesBp } from '../../lib/billing/bill-totals'
import type { Actor } from '../../lib/db/types'

// Real labels: PUG-N42 White size 6, MRP 339.50.
const BOX = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722'
const BOX_2 = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-LE69Q-1006101721'
const key = (raw: string) => { const l = readBoxLabel(raw); if (!l.ok) throw new Error(l.message); return l.box.dedupeKey }

describe('edit bill by scanning (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  let sku6 = 0
  let orderId = 0
  let credit = 0
  const biller: Actor = { id: 'u-biller', name: 'Biller' }
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  const q = async <T = Record<string, unknown>>(s: ReturnType<typeof sql>) => (await h.db.execute(s)).rows as T[]
  const num = async (s: ReturnType<typeof sql>) => Number(Object.values((await q(s))[0] ?? { x: 0 })[0])
  const scannedStock = () => num(sql`SELECT coalesce(sum(quantity), 0) FROM stock_balances WHERE "skuId" = ${sku6} AND provenance = 'scanned'`)
  const active = () => q<{ billNo: string; billDate: string; grandTotalPaise: string; id: string }>(sql`
    SELECT id, "billNo", "billDate"::text AS "billDate", "grandTotalPaise" FROM sale_bills WHERE "orderId" = ${orderId} AND status = 'active'`)
  const healthy = async () => {
    assert.equal(await num(sql`SELECT count(*) FROM party_balance_mismatches`), 0)
    assert.equal(await num(sql`SELECT count(*) FROM party_open_item_mismatches`), 0)
    assert.equal(await num(sql`SELECT count(*) FROM stock_balance_mismatches`), 0)
  }
  const creditOpen = () => num(sql`SELECT coalesce((SELECT "openPaise" FROM party_open_items WHERE id = ${credit}), 0)`)
  const lines = [{ artNumber: 'PUG-N42', mrp: 339.5, qty: 1 }, { artNumber: 'X', mrp: 160, qty: 2 }]
  // Not the default 4.75 %: an edit must keep the bill's own rates.
  const rates = { discountPct: 3, cgstPct: 2.5, sgstPct: 2.5, igstPct: 0 }

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-biller','Biller','b@test.local','biller'), ('u-admin','Admin','a@test.local','admin')`)
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName", "taxType") VALUES ('V1', 'Om Shoes', 'intra_state')`)
    const art = await q<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode") VALUES ('PUG-N42','PUGN42G','White','WHWH') RETURNING id`)
    sku6 = Number((await q<{ id: number }>(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES (${art[0].id},'6',1) RETURNING id`))[0].id)
    // Both boxes scanned into stock by the warehouse.
    for (const raw of [BOX, BOX_2]) assert.equal((await recordBoxScan(h.db, admin, { clientEventId: randomUUID(), rawInput: raw })).status, 'saved')
    // An order billed on 1 Nov with BOX (order name PUG-N42) and a typed line.
    orderId = Number((await q<{ id: number }>(sql`INSERT INTO orders ("orderNumber", "shopkeeperName", "retailerId", status) VALUES ('ORD-E-1', 'Om Shoes', 'V1', 'billed') RETURNING id`))[0].id)
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO bill_lines ("orderId", "artNumber", mrp, qty, "lineDiscPct") VALUES (${orderId}, 'PUG-N42', 339.5, 1, 30), (${orderId}, 'X', 160, 2, 30)`)
      await freezeSaleBill(tx, biller, { orderId, source: 'invoice', lines, lineDiscPct: 30, party: { retailerId: 'V1', taxType: 'intra_state' }, billDate: '2026-11-01', rates })
      await recordOrderScans(tx, biller, orderId, 'ORD-E-1', [BOX])
    })
    // The party paid the whole bill (stand-in credit, set against the bill).
    const [bill] = await active()
    credit = Number((await q<{ id: string }>(sql`INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", reason, "idempotencyKey")
      VALUES ('V1', 'adjustment', ${-Number(bill.grandTotalPaise)}, '2026-11-02', 'paid', 'test:paid') RETURNING id`))[0].id)
    await h.db.execute(sql`INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method)
      SELECT 'V1', e.id, ${credit}, ${Number(bill.grandTotalPaise)}, 'manual' FROM party_ledger_entries e WHERE e."saleBillId" = ${bill.id} AND e.kind = 'bill'`)
    assert.equal(await scannedStock(), 1)
  })
  after(async () => { await h?.close() })

  test('the screen gets the lines and boxes of the bill', async () => {
    const b = await loadBillForEdit(h.db, orderId)
    assert.ok(b)
    assert.deepEqual([b!.status, b!.boxes.map((x) => x.dedupeKey), b!.lines.map((l) => [l.artNumber, l.qty])], ['billed', [key(BOX)], [['PUG-N42', 1], ['X', 2]]])
  })

  test('add a box: out of stock, line +1, same number and date, payment stays set against the bill, the rest owed', async () => {
    const [before] = await active()
    const r = await editBillByScan(h.db, biller, orderId, { add: [BOX_2], remove: [] })
    const want = computeBillTotals([{ mrp: 339.5, qty: 2 }, { mrp: 160, qty: 2 }], 30, 'intra_state', ratesBp(rates))
    assert.deepEqual([r.added, r.removed, r.totals.grandTotalPaise, r.stock.scanned], [1, 0, want.grandTotalPaise, 1])
    assert.deepEqual(r.lines.map((l) => [l.artNumber, l.qty]), [['PUG-N42', 2], ['X', 2]])
    const [now] = await active()
    assert.deepEqual([now.billNo, now.billDate], [before.billNo, '2026-11-01'])
    assert.equal(await num(sql`SELECT count(*) FROM sale_bills WHERE id = ${now.id} AND "discountPct" = 3 AND "cgstPct" = 2.5`), 1, 'rates kept')
    assert.equal(await num(sql`SELECT count(*) FROM party_ledger_entries WHERE "saleBillId" = ${now.id} AND kind = 'bill' AND "entryDate" = '2026-11-01'`), 1)
    assert.equal(await scannedStock(), 0)
    // The whole payment is set against the edited bill; the party owes only the difference.
    assert.equal(await creditOpen(), 0)
    assert.equal(r.reattachedPaise, Number(before.grandTotalPaise))
    assert.equal(await num(sql`SELECT "balancePaise" FROM party_balances WHERE "retailerId" = 'V1'`), want.grandTotalPaise - Number(before.grandTotalPaise))
    await healthy()
  })

  test('remove two boxes: back to stock, line gone, payment above the new total becomes advance', async () => {
    const r = await editBillByScan(h.db, admin, orderId, { add: [], remove: [key(BOX), key(BOX_2)] })
    const want = computeBillTotals([{ mrp: 160, qty: 2 }], 30, 'intra_state', ratesBp(rates))
    assert.deepEqual(r.lines.map((l) => [l.artNumber, l.qty]), [['X', 2]])
    assert.equal(r.totals.grandTotalPaise, want.grandTotalPaise)
    assert.equal(await scannedStock(), 2)
    assert.equal(await num(sql`SELECT count(*) FROM bill_scans WHERE "orderId" = ${orderId} AND status = 'active'`), 0)
    const paid = -Number((await q<{ a: string }>(sql`SELECT "amountPaise" AS a FROM party_ledger_entries WHERE id = ${credit}`))[0].a)
    assert.equal(await creditOpen(), paid - want.grandTotalPaise, 'advance')
    assert.equal(await num(sql`SELECT count(*) FROM sale_bills WHERE "orderId" = ${orderId}`), 3)
    assert.equal(await num(sql`SELECT count(*) FROM audit_events WHERE action = 'bill.edited' AND "entityId" = ${String(orderId)}`), 2)
    await healthy()
  })

  test('refused: box not on the bill, box already on it, nothing changed, dispatched bill', async () => {
    await assert.rejects(editBillByScan(h.db, biller, orderId, { add: [], remove: [key(BOX)] }), /no longer on this bill/)
    await editBillByScan(h.db, biller, orderId, { add: [BOX], remove: [] })
    await assert.rejects(editBillByScan(h.db, biller, orderId, { add: [BOX], remove: [] }), /already on this bill/)
    await assert.rejects(editBillByScan(h.db, biller, orderId, { add: [BOX], remove: [key(BOX)] }), /Nothing changed/)
    await assert.rejects(editBillByScan(h.db, biller, orderId, { add: ['not a label'], remove: [] }), /could not be read/)
    await h.db.execute(sql`UPDATE orders SET status = 'dispatched' WHERE id = ${orderId}`)
    await assert.rejects(editBillByScan(h.db, biller, orderId, { add: [BOX_2], remove: [] }), /not yet dispatched/)
    await healthy()
  })
})
