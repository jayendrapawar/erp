import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { applyUpload, listActiveAssortments, previewUpload, retireAssortment, saveAssortment } from '../../lib/catalog/assortment-store'
import type { SheetRow } from '../../lib/catalog/assortments'
import type { Actor } from '../../lib/db/types'

const sizes = (o: Record<string, number>) => Object.entries(o).map(([size, pairs]) => ({ size, pairs }))
const sheetRow = (row: number, segment: string, packing: number, code: string, s: Record<string, number>): SheetRow =>
  ({ row, total: null, input: { division: 'Flite EVA', segment, packing, code, sizes: sizes(s) } })

describe('carton assortments (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-admin','Admin','a@test.local','admin')`)
  })
  after(async () => { await h?.close() })

  test('add, edit = new version (old kept), unchanged edit is a no-op, remove keeps history', async () => {
    const a = await saveAssortment(h.db, admin, { division: 'Flite EVA', segment: 'Gents', packing: 30, code: '608', sizes: sizes({ 6: 12, 7: 10, 8: 8 }) })
    assert.equal(a.changed, true)
    await assert.rejects(saveAssortment(h.db, admin, { division: 'Flite EVA', segment: 'Gents', packing: 30, code: '608', sizes: sizes({ 6: 10, 7: 10, 8: 10 }) }), /already exists/)
    assert.equal((await saveAssortment(h.db, admin, { id: a.id, division: 'Flite EVA', segment: 'Gents', packing: 30, code: '608', sizes: sizes({ 6: 12, 7: 10, 8: 8 }) })).changed, false)
    const b = await saveAssortment(h.db, admin, { id: a.id, division: 'Flite EVA', segment: 'Gents', packing: 30, code: '608', sizes: sizes({ 6: 10, 7: 10, 8: 10 }) })
    assert.notEqual(b.id, a.id)
    await assert.rejects(saveAssortment(h.db, admin, { id: b.id, division: 'Flite EVA', segment: 'Gents', packing: 24, code: '608', sizes: sizes({ 6: 8, 7: 8, 8: 8 }) }), /cannot be changed/)
    const rows = (await h.db.execute(sql`SELECT id, version, active, "replacedById" FROM carton_assortments ORDER BY id`)).rows as { id: number; version: number; active: boolean; replacedById: number | null }[]
    assert.deepEqual(rows.map(r => [r.version, r.active, r.replacedById]), [[1, false, b.id], [2, true, null]])
    await retireAssortment(h.db, admin, b.id, 'test')
    assert.equal((await listActiveAssortments(h.db)).length, 0)
    assert.equal(Number((await h.db.execute(sql`SELECT count(*) AS n FROM carton_assortments`)).rows[0].n), 2)
    assert.ok(Number((await h.db.execute(sql`SELECT count(*) AS n FROM audit_events WHERE "entityType" = 'carton_assortment'`)).rows[0].n) >= 3)
  })

  test('upload: new, changed (new version), same; any error rejects everything', async () => {
    const first = [sheetRow(2, 'Gents', 24, '607', { 6: 12, 7: 12 }), sheetRow(3, 'Ladies', 30, '608', { 6: 10, 7: 10, 8: 10 })]
    assert.deepEqual(await applyUpload(h.db, admin, first, 'a.xlsx'), { created: 2, updated: 0, unchanged: 0 })
    const second = [sheetRow(2, 'Gents', 24, '607', { 6: 12, 7: 12 }), sheetRow(3, 'Ladies', 30, '608', { 6: 8, 7: 12, 8: 10 }), sheetRow(4, 'Kids', 36, '1101', { 11: 9, 12: 9, 13: 9, 1: 9 })]
    const plan = await previewUpload(h.db, second)
    assert.deepEqual(plan.map(l => l.status), ['same', 'changed', 'new'])
    assert.deepEqual(await applyUpload(h.db, admin, second, 'b.xlsx'), { created: 1, updated: 1, unchanged: 1 })
    const ladies = (await listActiveAssortments(h.db)).find(a => a.segment === 'Ladies')!
    assert.equal(ladies.version, 2)
    const before = (await listActiveAssortments(h.db)).length
    await assert.rejects(applyUpload(h.db, admin, [sheetRow(2, 'Gents', 30, '810', { 8: 10, 9: 10, 10: 10 }), sheetRow(3, 'Gents', 30, '609', { 6: 30, 11: 1 })], 'c.xlsx'), /Nothing was saved/)
    assert.equal((await listActiveAssortments(h.db)).length, before)
  })
})
