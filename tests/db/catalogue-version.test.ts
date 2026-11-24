// Catalogue version (24 Nov 2026): every catalogue change gives a new version, in the same
// transaction, so the Orders screens know when to download the article list again.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { bumpCatalogueVersion, getCatalogueVersion } from '../../lib/catalog/version'

describe('catalogue version (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  before(async () => { h = await createHarness() })
  after(async () => { await h?.close() })

  test("'0' before the first change, then a new value on every change", async () => {
    assert.equal(await getCatalogueVersion(h.db), '0')
    await bumpCatalogueVersion(h.db)
    const v1 = await getCatalogueVersion(h.db)
    assert.notEqual(v1, '0')
    await h.db.transaction((tx) => bumpCatalogueVersion(tx))
    const v2 = await getCatalogueVersion(h.db)
    assert.notEqual(v2, v1)
  })

  test('a save that fails leaves the version as it was', async () => {
    const before = await getCatalogueVersion(h.db)
    await assert.rejects(h.db.transaction(async (tx) => { await bumpCatalogueVersion(tx); throw new Error('save failed') }), /save failed/)
    assert.equal(await getCatalogueVersion(h.db), before)
  })
})
