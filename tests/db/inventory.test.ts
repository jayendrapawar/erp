import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan, recordManualEntry, resolvePendingScans, voidScanEvent } from '../../lib/inventory/scan-service'
import { postMovement } from '../../lib/inventory/ledger'
import type { Actor } from '../../lib/db/types'

const BOX = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722'
const BOX_2 = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-LE69Q-1006101721'
const BOX_SIZE_8 = 'A1PUGN42G-WHWH0008-0726R10MA0-339.50-1010-CJASC-1006106444'
const UNKNOWN_BOX = 'A1SS0703G-NBOR0007-1026R05MA0-649.00-1005-44GSY-1020602214'
const CARTON = 'PUGN42GWHWH0608A339.500109202610101004961646'

describe('inventory foundation (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const helper: Actor = { id: 'u-helper', name: 'Helper One' }
  const other: Actor = { id: 'u-other', name: 'Helper Two' }
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  let skuSize6 = 0

  const balance = async (provenance?: string) => {
    const r = await h.db.execute<{ q: number }>(sql`SELECT coalesce(sum(quantity),0)::int q FROM stock_balances ${provenance ? sql`WHERE provenance = ${provenance}` : sql``}`)
    return Number(r.rows[0].q)
  }
  // Drizzle wraps database errors; the trigger message is on the cause.
  const rejectsWith = (promise: Promise<unknown>, re: RegExp) =>
    assert.rejects(promise, (e: Error & { cause?: Error }) => re.test(`${e.message} ${e.cause?.message ?? ''}`))
  const mismatches = async () => Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM stock_balance_mismatches`)).rows[0].n)

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-helper','Helper One','h1@test.local','warehouse'), ('u-other','Helper Two','h2@test.local','warehouse'), ('u-admin','Admin','a@test.local','admin')`)
    const art = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode","minSize","maxSize") VALUES ('PUG-N42','PUGN42G','White','WHWH','6','7') RETURNING id`)
    const articleId = art.rows[0].id
    const s = await h.db.execute<{ id: number; sizeLabel: string }>(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES (${articleId},'6',1),(${articleId},'7',2) RETURNING id, "sizeLabel"`)
    skuSize6 = Number(s.rows.find((r) => r.sizeLabel === '6')!.id)
  })
  after(async () => { await h?.close() })

  test('a known box posts one scanned pair', async () => {
    const r = await recordBoxScan(h.db, helper, { clientEventId: randomUUID(), rawInput: BOX })
    assert.equal(r.status, 'saved')
    if (r.status !== 'saved') return
    assert.equal(r.event.resolution, 'resolved')
    assert.equal(r.event.skuId, skuSize6)
    assert.equal(r.event.formatId, 'relaxo.box.a1.short')
    assert.equal(await balance('scanned'), 1)
  })

  test('retrying the same device event is a no-op (offline retry / lost response)', async () => {
    const id = randomUUID()
    const a = await recordBoxScan(h.db, helper, { clientEventId: id, rawInput: BOX_2 })
    const b = await recordBoxScan(h.db, helper, { clientEventId: id, rawInput: BOX_2 })
    assert.equal(a.status, 'saved'); assert.equal(b.status, 'saved')
    if (a.status === 'saved' && b.status === 'saved') {
      assert.equal(b.replay, true)
      assert.equal(b.event.id, a.event.id)
    }
    assert.equal(await balance('scanned'), 2)
  })

  test('the same label scanned again is refused and names the first scanner', async () => {
    const r = await recordBoxScan(h.db, other, { clientEventId: randomUUID(), rawInput: BOX })
    assert.equal(r.status, 'duplicate')
    if (r.status === 'duplicate') assert.equal(r.original.userName, 'Helper One')
    const audits = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM audit_events WHERE action = 'scan.duplicate_attempt'`)
    assert.equal(Number(audits.rows[0].n), 1, 'duplicate attempts are logged, not silently dropped')
    assert.equal(await balance('scanned'), 2)
  })

  test('a URL-wrapped rescan of the same label is also a duplicate', async () => {
    const wrapped = `https://${BOX.toLowerCase()}/`
    const r = await recordBoxScan(h.db, other, { clientEventId: randomUUID(), rawInput: wrapped })
    assert.equal(r.status, 'duplicate')
  })

  test('two devices scanning one new box at the same moment save it once', async () => {
    const raw = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-E33T4-1006101726'
    const results = await Promise.all([
      recordBoxScan(h.db, helper, { clientEventId: randomUUID(), rawInput: raw }),
      recordBoxScan(h.db, other, { clientEventId: randomUUID(), rawInput: raw }),
    ])
    assert.deepEqual(results.map((r) => r.status).sort(), ['duplicate', 'saved'])
    assert.equal(await balance('scanned'), 3)
  })

  test('carton labels are refused by the box scanner and never add stock', async () => {
    const r = await recordBoxScan(h.db, helper, { clientEventId: randomUUID(), rawInput: CARTON })
    assert.equal(r.status, 'rejected')
    if (r.status === 'rejected') assert.equal(r.reason, 'carton')
    assert.equal(await balance(), 3)
  })

  test('unknown article and unknown size are saved without stock, then posted once linked', async () => {
    const unknown = await recordBoxScan(h.db, helper, { clientEventId: randomUUID(), rawInput: UNKNOWN_BOX })
    const noSize = await recordBoxScan(h.db, helper, { clientEventId: randomUUID(), rawInput: BOX_SIZE_8 })
    assert.equal(unknown.status === 'saved' && unknown.event.resolution, 'missing_article')
    assert.equal(noSize.status === 'saved' && noSize.event.resolution, 'missing_size')
    assert.equal(await balance(), 3)

    // Admin adds size 8 to the article; the waiting scan is posted exactly once.
    await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") SELECT id,'8',3 FROM articles WHERE "artCode"='PUGN42G'`)
    const first = await resolvePendingScans(h.db, admin, 'PUGN42G', 'WHWH')
    const second = await resolvePendingScans(h.db, admin, 'PUGN42G', 'WHWH')
    assert.equal(first.resolved, 1)
    assert.equal(second.resolved, 0)
    assert.equal(await balance('scanned'), 4)
  })

  test('manual entries post unscanned stock and are idempotent', async () => {
    const id = randomUUID()
    const input = { clientEventId: id, articleCode: 'pugn42g ', colourCode: 'whwh', sizeLabel: '07', quantity: 5 }
    const a = await recordManualEntry(h.db, helper, input)
    const b = await recordManualEntry(h.db, helper, input)
    assert.equal(a.event.resolution, 'resolved')
    assert.equal(b.replay, true)
    assert.equal(await balance('unscanned'), 5)
  })

  test('undo reverses the stock, keeps the history, and lets the label be scanned again', async () => {
    const saved = await recordBoxScan(h.db, helper, { clientEventId: randomUUID(), rawInput: 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-HN7BQ-1006101724' })
    assert.equal(saved.status, 'saved')
    if (saved.status !== 'saved') return
    const before = await balance('scanned')
    const denied = await voidScanEvent(h.db, other, { eventId: saved.event.id, reason: 'mistake', canVoidAny: false })
    assert.equal(denied.ok, false, 'a helper cannot undo someone else’s scan')
    const v = await voidScanEvent(h.db, helper, { eventId: saved.event.id, reason: 'scanned wrong shelf', canVoidAny: false })
    assert.equal(v.ok && v.reversed, true)
    const again = await voidScanEvent(h.db, helper, { eventId: saved.event.id, reason: 'double tap', canVoidAny: false })
    assert.equal(again.ok && again.alreadyVoided, true)
    assert.equal(await balance('scanned'), before - 1)
    const rows = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM stock_movements WHERE "sourceId" = ${String(saved.event.id)}`)
    assert.equal(Number(rows.rows[0].n), 2, 'post + reversal both stay in the ledger')
    const rescan = await recordBoxScan(h.db, helper, { clientEventId: randomUUID(), rawInput: 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-HN7BQ-1006101724' })
    assert.equal(rescan.status, 'saved', 'a voided label can be counted again')
  })

  test('the ledger is append-only and balances cannot be written directly', async () => {
    await rejectsWith(h.db.execute(sql`UPDATE stock_movements SET quantity = 99`), /append-only/)
    await rejectsWith(h.db.execute(sql`DELETE FROM stock_movements`), /append-only/)
    await rejectsWith(h.db.execute(sql`UPDATE stock_balances SET quantity = 99`), /maintained from stock_movements/)
    await rejectsWith(h.db.execute(sql`INSERT INTO stock_balances ("skuId","locationId",provenance,quantity) VALUES (${skuSize6}, 1, 'carton', 5)`), /maintained from stock_movements/)
    await rejectsWith(postMovement(h.db, { skuId: skuSize6, locationId: 1, provenance: 'scanned', quantity: 0, movementType: 'adjustment', sourceType: 't', sourceId: 1, idempotencyKey: 'zero', userId: null }), /non-zero/)
  })

  test('balances always equal the sum of the ledger', async () => {
    assert.equal(await mismatches(), 0)
    const rebuilt = await h.db.execute<{ n: number }>(sql`SELECT stock_balances_rebuild() n`)
    assert.ok(Number(rebuilt.rows[0].n) > 0)
    assert.equal(await mismatches(), 0)
  })
})
