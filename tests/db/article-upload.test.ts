import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { recordBoxScan } from '../../lib/inventory/scan-service'
import { applyArticleUpload, csvToCells, parseArticleSheet, planArticleUpload, summarise } from '../../lib/catalog/article-upload'
import type { Actor } from '../../lib/db/types'

const HEADER = ['id', 'artName', 'artCode', 'color', 'colorCode', 'maxSize', 'minSize', 'Stock source', 'Segment']
const sheet = (rows: unknown[][]) => [HEADER, ...rows].map((values, i) => ({ rowNumber: i + 1, values }))
// SS0703G / NBOR size 7: scanned before the article is in the master.
const WAITING_BOX = 'A1SS0703G-NBOR0007-1026R05MA0-649.00-1005-44GSY-1020602214'

describe('article list upload (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  const variant = async (code: string, colourName: string) => (await h.db.execute<{ id: number; colorCode: string; division: string | null; minSize: string; maxSize: string }>(sql`
    SELECT id, "colorCode", division, "minSize", "maxSize" FROM articles WHERE "artCode" = ${code} AND color = ${colourName}`)).rows

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-admin','Admin','a@test.local','admin')`)
    await h.db.execute(sql`INSERT INTO articles ("artName","artCode",color,"colorCode","minSize","maxSize") VALUES ('SS-702','SS0702B','Black Red','BKRD','11','5')`)
    assert.equal((await recordBoxScan(h.db, admin, { clientEventId: randomUUID(), rawInput: WAITING_BOX })).status, 'saved')
  })
  after(async () => { await h?.close() })

  test('reads the owner layout and reports unreadable rows and missing columns', () => {
    const parsed = parseArticleSheet(sheet([
      [null, 'PXL-05', 'pxl005l', 'Black', 'bkbk', 8, 3, 'PU'],
      [null, 'PXL-05', 'PXL005L', 'D. Pink', null, 8, 3, 'PU'],
      [null, 'PXL-05', 'PXL005L', 'Bad', 'BDBD', 20, 3, 'PU'],
    ]))
    assert.equal(parsed.rows.length, 2)
    assert.deepEqual(parsed.rows[0], { rowNumber: 2, artName: 'PXL-05', artCode: 'PXL005L', color: 'Black', colorCode: 'BKBK', sizes: ['3', '4', '5', '6', '7', '8'], division: 'Flite PU' })
    assert.equal(parsed.problems.length, 1)
    assert.deepEqual(parseArticleSheet(csvToCells('artName,color\nA,B\n')).missingColumns, ['artCode', 'minSize', 'maxSize'])
  })

  test('adds new colours, keeps code-less colours by name, skips what is there, posts waiting scans', async () => {
    const parsed = parseArticleSheet(sheet([
      [null, 'SS-702', 'SS0702B', 'Black Red', 'BKRD', 5, 1, 'Sparx'], // already there
      [null, 'SS-702', 'SS0702B', 'black  red', null, 5, 1, 'Sparx'], // same colour name, no code: there
      [null, 'SS-703', 'SS0703G', 'Navy Orange', 'NBOR', 10, 6, 'Sparx'], // new; a box is waiting
      [null, 'FL-48', 'FL0048G', 'Black Black', null, 10, 6, 'Flite'], // new, code pending
      [null, 'SFK-1', 'SF0001K', 'Red', 'RDRD', 13, 11, 'Sparx'], // two size runs, one variant
      [null, 'SFK-1', 'SF0001K', 'Red', 'RDRD', 5, 1, 'Sparx'],
    ]))
    const plan = await planArticleUpload(h.db, parsed.rows)
    const s = summarise(parsed, plan)
    assert.deepEqual([s.added, s.addedPending, s.filled, s.alreadyThere], [2, 1, 0, 2])
    const res = await applyArticleUpload(h.db, admin, plan, { fileName: 'test.xlsx', rowsRead: s.rowsRead })
    assert.equal(res.resolvedScans, 1)
    const [fl] = await variant('FL0048G', 'Black Black')
    assert.deepEqual([fl.colorCode, fl.division, fl.minSize, fl.maxSize], ['', 'Flite EVA', '6', '10'])
    const [kids] = await variant('SF0001K', 'Red')
    assert.deepEqual([kids.minSize, kids.maxSize], ['11', '5'])
    const sizes = (await h.db.execute<{ s: string }>(sql`SELECT "sizeLabel" s FROM article_sizes WHERE "articleId" = ${kids.id} ORDER BY "sortOrder"`)).rows.map(r => r.s)
    assert.deepEqual(sizes, ['11', '12', '13', '1', '2', '3', '4', '5'])
    // Same file again: nothing to do.
    const again = summarise(parsed, await planArticleUpload(h.db, parsed.rows))
    assert.deepEqual([again.added, again.addedPending, again.filled, again.alreadyThere], [0, 0, 0, 5])
  })

  test('a later upload with the colour code fills the pending colour (same id)', async () => {
    const [before] = await variant('FL0048G', 'Black Black')
    const parsed = parseArticleSheet(sheet([[null, 'FL-48', 'FL0048G', 'BLACK BLACK', 'BKBK', 10, 6, 'Flite']]))
    const plan = await planArticleUpload(h.db, parsed.rows)
    assert.deepEqual([plan.add.length, plan.fill.length], [0, 1])
    await applyArticleUpload(h.db, admin, plan, { fileName: 'fix.xlsx', rowsRead: 1 })
    const rows = await variant('FL0048G', 'Black Black')
    assert.deepEqual(rows.map(r => [r.id, r.colorCode]), [[before.id, 'BKBK']])
  })
})
