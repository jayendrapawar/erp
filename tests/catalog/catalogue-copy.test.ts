import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asSavedCatalogue, MAX_COPY_AGE_MS, needsDownload, type SavedCatalogue } from '../../lib/catalog/catalogue-copy'

const now = 1_800_000_000_000
const saved = (version: string, ageMs = 0): SavedCatalogue => ({ version, savedAt: now - ageMs, data: { version, vendors: [], articles: [] } })

test('no saved copy: download', () => {
  assert.equal(needsDownload(null, 'a', now), true)
  assert.equal(needsDownload(null, undefined, now), true)
})

test('same version: keep the copy (no download)', () => {
  assert.equal(needsDownload(saved('a', 60_000), 'a', now), false)
})

test('a Master change (new version): download at once, however new the copy', () => {
  assert.equal(needsDownload(saved('a', 0), 'b', now), true)
})

test('version not known: keep a recent copy', () => {
  assert.equal(needsDownload(saved('a', 60_000), undefined, now), false)
})

test('safety net: a copy older than the limit is downloaded again even with the same version', () => {
  assert.equal(needsDownload(saved('a', MAX_COPY_AGE_MS - 1), 'a', now), false)
  assert.equal(needsDownload(saved('a', MAX_COPY_AGE_MS), 'a', now), true)
})

test('old-format or corrupt saved copies are ignored', () => {
  assert.equal(asSavedCatalogue(null), null)
  assert.equal(asSavedCatalogue({ vendors: [], articles: [] }), null) // the pre-24 Nov format (no version)
  assert.equal(asSavedCatalogue({ version: 'a', savedAt: 1, data: { vendors: [], articles: [] } }), null)
  assert.deepEqual(asSavedCatalogue(saved('a')), saved('a'))
})
