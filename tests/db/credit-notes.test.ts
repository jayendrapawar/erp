// Credit notes (migration 0018; docs/architecture/payments.md): money notes with GST at the bill's
// rates, notes without a bill, goods returns back into stock, cancel, numbering, ledger health.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan } from '../../lib/inventory/scan-service'
import { addDraftScan, createDraft, generateDirectBill } from '../../lib/billing/bill-stock'
import { cancelCreditNote, checkReturnBox, createCreditNote, creditNoteForPrint, listCreditNotes, listPartyBills, moneyNoteTotals } from '../../lib/payments/credit-notes'
import { partySummary } from '../../lib/payments/payments'
import type { Actor } from '../../lib/db/types'

// Real labels (same corpus as billing-stock). BOX and BOX_2: PUG-N42 White size 6, MRP 339.50.
const BOX = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722'
const BOX_2 = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-LE69Q-1006101721'

describe('credit notes (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  let sku6 = 0
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  const num = async (s: ReturnType<typeof sql>) => Number(Object.values((await h.db.execute(s)).rows[0] ?? { x: 0 })[0])
  const bal = (provenance: string) => num(sql`SELECT coalesce(sum(quantity),0)::int FROM stock_balances WHERE "skuId" = ${sku6} AND provenance = ${provenance}`)
  const healthy = async () => {
    assert.equal(await num(sql`SELECT count(*) FROM party_balance_mismatches`), 0, 'balance = sum of entries')
    assert.equal(await num(sql`SELECT count(*) FROM party_open_item_mismatches`), 0, 'unpaid − advance = balance')
  }
  const note = (input: Record<string, unknown>) => h.db.transaction((tx) => createCreditNote(tx, admin, { clientId: randomUUID(), noteDate: '2026-11-24', reason: 'test', ...input }))
  let bill: { id: number; saleBillId: number; billNo: string; total: number }

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-admin','Admin','a@test.local','admin')`)
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName", "taxType") VALUES ('R1', 'Om Shoes', 'intra_state'), ('R2', 'Far Traders', 'inter_state')`)
    const art = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode") VALUES ('PUG-N42','PUGN42G','White','WHWH') RETURNING id`)
    const s = await h.db.execute<{ id: number }>(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES (${art.rows[0].id},'6',1) RETURNING id`)
    sku6 = Number(s.rows[0].id)
    for (const raw of [BOX, BOX_2]) assert.equal((await recordBoxScan(h.db, admin, { clientEventId: randomUUID(), rawInput: raw })).status, 'saved')
    // A Direct bill of both boxes to Om Shoes (within the state).
    const d = await createDraft(h.db, admin)
    for (const raw of [BOX, BOX_2]) await addDraftScan(h.db, admin, d, raw, randomUUID())
    const b = await generateDirectBill(h.db, admin, d, { shopkeeperName: 'Om Shoes', lineDiscPct: 30 }, { pickerId: 'u-admin' })
    bill = { id: b.id, saleBillId: await num(sql`SELECT id FROM sale_bills WHERE "orderId" = ${b.id} AND status = 'active'`), billNo: b.billNo, total: b.totals.grandTotalPaise }
    assert.equal(await bal('scanned'), 0) // both boxes went out
  })
  after(async () => { await h?.close() })

  test('money note against a bill: GST at the bill\'s rates, set against that bill, CN numbers', async () => {
    const t = moneyNoteTotals(100000, 'intra_state', { discountPct: 4.75, cgstPct: 2.5, sgstPct: 2.5, igstPct: 5 })
    assert.deepEqual([t.cgstPaise, t.sgstPaise, t.totalPaise], [2500, 2500, 105000])
    await assert.rejects(note({ retailerId: 'R1', kind: 'money', saleBillId: bill.saleBillId, taxablePaise: 0 }), /amount before GST/)
    await assert.rejects(note({ retailerId: 'R1', kind: 'money', saleBillId: bill.saleBillId, taxablePaise: 1000, reason: ' ' }), /reason/)
    await assert.rejects(note({ retailerId: 'R2', kind: 'money', saleBillId: bill.saleBillId, taxablePaise: 1000 }), /not this party/)
    const clientId = randomUUID()
    const n = await note({ clientId, retailerId: 'R1', kind: 'money', saleBillId: bill.saleBillId, taxablePaise: 10000, reason: 'rate difference' })
    assert.equal(n.noteNo, 'CN1')
    assert.deepEqual([n.totals.cgstPaise, n.totals.sgstPaise, n.totals.totalPaise], [250, 250, 10500])
    assert.equal(n.party.balancePaise, bill.total - 10500)
    const bills = await listPartyBills(h.db, 'R1')
    assert.equal(bills[0].unpaidPaise, bill.total - 10500) // set against its own bill
    // A retry with the same clientId saves nothing new.
    const again = await note({ clientId, retailerId: 'R1', kind: 'money', saleBillId: bill.saleBillId, taxablePaise: 10000 })
    assert.deepEqual([again.repeated, again.noteNo], [true, 'CN1'])
    // Cancel: the bill is owed in full again.
    await assert.rejects(h.db.transaction((tx) => cancelCreditNote(tx, admin, n.creditNoteId, '')), /reason/)
    const c = await h.db.transaction((tx) => cancelCreditNote(tx, admin, n.creditNoteId, 'typed wrong'))
    assert.equal(c.party.balancePaise, bill.total)
    await assert.rejects(h.db.execute(sql`UPDATE credit_notes SET "totalPaise" = 1 WHERE id = ${n.creditNoteId}`), (e: Error) => /frozen/.test(String((e as { cause?: Error }).cause?.message ?? e.message)))
    await healthy()
  })

  test('money note without a bill: chosen bill type, IGST outside the state; becomes advance when nothing is owed', async () => {
    await assert.rejects(note({ retailerId: 'R2', kind: 'money', taxablePaise: 10000 }), /bill type/)
    const n = await note({ retailerId: 'R2', kind: 'money', taxType: 'inter_state', taxablePaise: 10000, reason: 'year-end discount' })
    assert.deepEqual([n.totals.igstPaise, n.totals.cgstPaise, n.totals.totalPaise], [500, 0, 10500])
    assert.deepEqual(await partySummary(h.db, 'R2'), { retailerId: 'R2', balancePaise: -10500, unpaidPaise: 0, advancePaise: 10500 })
    await healthy()
  })

  test('goods return: boxes of the bill back into stock, marked returned; a box only once; cannot be cancelled', async () => {
    await assert.rejects(note({ retailerId: 'R1', kind: 'return', boxes: [BOX] }), /need the bill/)
    const box = await checkReturnBox(h.db, bill.saleBillId, BOX)
    assert.equal(box.articleCode, 'PUGN42G')
    const before = (await partySummary(h.db, 'R1')).balancePaise
    const n = await note({ retailerId: 'R1', kind: 'return', saleBillId: bill.saleBillId, boxes: [BOX], reason: 'damaged' })
    assert.equal(n.totals.totalQty, 1)
    assert.equal(n.totals.totalPaise, Math.round(bill.total / 2 / 100) * 100) // one of two equal boxes, at the bill's rates
    assert.equal(await bal('scanned'), 1) // back in stock
    assert.equal(await num(sql`SELECT count(*) FROM bill_scans WHERE status = 'returned' AND "creditNoteId" = ${n.creditNoteId}`), 1)
    assert.equal((await partySummary(h.db, 'R1')).balancePaise, before - n.totals.totalPaise)
    await assert.rejects(checkReturnBox(h.db, bill.saleBillId, BOX), /already returned/)
    await assert.rejects(note({ retailerId: 'R1', kind: 'return', saleBillId: bill.saleBillId, boxes: [BOX_2, BOX_2] }), /twice/)
    await assert.rejects(h.db.transaction((tx) => cancelCreditNote(tx, admin, n.creditNoteId, 'oops')), /cannot be cancelled/)
    const p = await creditNoteForPrint(h.db, n.creditNoteId)
    assert.deepEqual([p?.kind, p?.bill?.billNo, p?.lines[0].qty, p?.party.partyName], ['return', bill.billNo, 1, 'Om Shoes'])
    assert.equal((await listCreditNotes(h.db, 'om')).length, 2)
    await healthy()
  })
})
