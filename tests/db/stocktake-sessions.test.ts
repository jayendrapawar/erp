import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { ensureOpenStocktake, finishSession, listRacks, openStocktakeId, saveRack, sessionFeed, sessionTotals, SessionError } from '../../lib/inventory/stocktake-sessions'
import { scannerScan } from '../../lib/inventory/scanner-scan'
import { recordManualEntry } from '../../lib/inventory/scan-service'
import { countStocktakeCarton } from '../../lib/inventory/stocktake-carton'
import type { Actor } from '../../lib/db/types'

const BOX_7 = 'A1PUG105G-BRBR0007-0726R10MA0-339.50-1010-Z76BB-1006101799'
const BOX_8 = 'A1PUG105G-BRBR0008-0726R10MA0-339.50-1010-Z76BC-1006101798'
const BOX_NEW = 'A1PXZ777G-BKBK0007-0726R10MA0-299.00-1010-Z76BD-1006101797'
const CARTON = 'PUG105GBRBR0610A339.500109202610101000000041'

describe('warehouse scanner: godown stocktake, optional areas (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const ravi: Actor = { id: 'u-ravi', name: 'Ravi' }
  const amit: Actor = { id: 'u-amit', name: 'Amit' }
  let sessionId = 0
  let gentsId = 0

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-ravi','Ravi','r@test.local','warehouse'), ('u-amit','Amit','a@test.local','warehouse')`)
    const a = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode",division,segment) VALUES ('PUG-105','PUG105G','Brown','BRBR','Flite PU','Gents') RETURNING id`)
    await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") SELECT ${a.rows[0].id}, x::text, x FROM generate_series(6, 10) x`)
    const g = await h.db.execute<{ id: number }>(sql`INSERT INTO carton_assortments (division, segment, packing, code, sizes) VALUES
      ('Flite PU', 'Gents', 30, '610', '[{"size":"6","pairs":6},{"size":"7","pairs":6},{"size":"8","pairs":6},{"size":"9","pairs":6},{"size":"10","pairs":6}]') RETURNING id`)
    gentsId = Number(g.rows[0].id)
  })
  after(async () => { await h?.close() })

  test('racks: add, no two with the same name, rename, switch off', async () => {
    const r = await saveRack(h.db, ravi, { name: '  Rack  A ' })
    assert.equal(r.name, 'Rack A')
    await assert.rejects(saveRack(h.db, ravi, { name: 'rack a' }), SessionError)
    const b = await saveRack(h.db, ravi, { name: 'Rack B' })
    await saveRack(h.db, ravi, { id: b.id, name: 'Rack B2', active: false })
    assert.deepEqual((await listRacks(h.db)).map((x) => x.name), ['Rack A'])
    assert.deepEqual((await listRacks(h.db, { all: true })).map((x) => [x.name, x.active]), [['Rack A', true], ['Rack B2', false]])
  })

  test('opening the scanner starts the godown stocktake; everyone else joins the same one', async () => {
    assert.equal(await openStocktakeId(h.db), null)
    const first = await ensureOpenStocktake(h.db, ravi)
    assert.equal(first.started, true)
    sessionId = first.id
    const [a, b] = await Promise.all([ensureOpenStocktake(h.db, amit), ensureOpenStocktake(h.db, ravi)])
    assert.deepEqual([a, b], [{ id: sessionId, started: false }, { id: sessionId, started: false }])
  })

  test('one request per scan: saved with the stocktake and the optional area; duplicates and unknown articles', async () => {
    const id = randomUUID()
    const r = await scannerScan(h.db, ravi, { raw: BOX_7, clientEventId: id, sessionId, flag: 'Rack A', askIfUnknown: true })
    assert.equal(r.kind, 'saved')
    if (r.kind !== 'saved') return
    assert.deepEqual([r.item.articleName, r.item.colourName, r.item.eventId, r.item.resolution], ['PUG-105', 'Brown', id, 'resolved'])
    const row = (await h.db.execute<{ sessionId: number; flag: string }>(sql`SELECT "sessionId", flag FROM scan_events WHERE "clientEventId" = ${id}::uuid`)).rows[0]
    assert.deepEqual([Number(row.sessionId), row.flag], [sessionId, 'Rack A'])

    const again = await scannerScan(h.db, amit, { raw: BOX_7, clientEventId: randomUUID(), sessionId, askIfUnknown: true })
    assert.ok(again.kind === 'duplicate' && again.scannedByName === 'Ravi')

    const unknown = await scannerScan(h.db, ravi, { raw: BOX_NEW, clientEventId: randomUUID(), sessionId, askIfUnknown: true })
    assert.ok(unknown.kind === 'unknown' && unknown.mode === 'unknown')
    assert.equal(Number((await h.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM scan_events WHERE "articleCode" = 'PXZ777G'`)).rows[0].n), 0)
    const saved = await scannerScan(h.db, ravi, { raw: BOX_NEW, clientEventId: randomUUID(), sessionId, askIfUnknown: false })
    assert.ok(saved.kind === 'saved' && saved.item.resolution === 'missing_article')

    const carton = await scannerScan(h.db, ravi, { raw: CARTON, clientEventId: randomUUID(), sessionId })
    assert.ok(carton.kind === 'carton' && carton.check.status === 'confirm')
  })

  test('session totals: boxes + typed pairs + carton pairs, people, missing', async () => {
    const noArea = await scannerScan(h.db, amit, { raw: BOX_8, clientEventId: randomUUID(), sessionId })
    assert.ok(noArea.kind === 'saved')
    if (noArea.kind === 'saved') assert.equal((await h.db.execute<{ flag: string | null }>(sql`SELECT flag FROM scan_events WHERE id = ${noArea.item.id}`)).rows[0].flag, null)
    await recordManualEntry(h.db, amit, { clientEventId: randomUUID(), articleCode: 'PUG105G', colourCode: 'BRBR', sizeLabel: '9', quantity: 3, sessionId })
    const c = await countStocktakeCarton(h.db, ravi, { rawInput: CARTON, clientEventId: randomUUID(), sessionId, flag: 'Rack A', answer: { assortmentId: gentsId } })
    assert.equal(c.status, 'counted')
    const flag = (await h.db.execute<{ flag: string; sessionId: number }>(sql`SELECT flag, "sessionId" FROM carton_receipts WHERE match = 'stocktake'`)).rows[0]
    assert.deepEqual([flag.flag, Number(flag.sessionId)], ['Rack A', sessionId])
    const t = (await sessionTotals(h.db, [sessionId])).get(sessionId)!
    // Boxes: 7, PXZ777G 7 (missing), 8 → 3; typed 3; carton 30.
    assert.deepEqual(t, { pairs: 36, boxes: 3, manualPairs: 3, cartons: 1, cartonPairs: 30, missing: 1, people: 2 })
    const feed = await sessionFeed(h.db, 'u-ravi', sessionId)
    assert.deepEqual(feed.map((f) => f.type), ['carton', 'box', 'box'])
    assert.equal(feed[0].detail, '6×6 7×6 8×6 9×6 10×6')
  })

  test('finishing: admin / supervisor only; the next opening starts a new stocktake', async () => {
    await assert.rejects(finishSession(h.db, ravi, { sessionId, canFinishAny: false }), /Only an admin or supervisor/)
    const done = await finishSession(h.db, amit, { sessionId, canFinishAny: true, note: 'whole godown' })
    assert.ok(done.status === 'finished' && done.finishedByName === 'Amit' && done.rackId === null)
    const next = await ensureOpenStocktake(h.db, ravi)
    assert.ok(next.started && next.id !== sessionId)
    // A scan saved offline during the finished count still joins it when it syncs.
    const late = await scannerScan(h.db, amit, { raw: 'A1PUG105G-BRBR0010-0726R10MA0-339.50-1010-Z76BE-1006101796', clientEventId: randomUUID(), sessionId, offline: true })
    assert.equal(late.kind, 'saved')
    assert.equal((await sessionTotals(h.db, [sessionId])).get(sessionId)!.boxes, 4)
  })
})
