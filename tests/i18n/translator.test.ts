import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTranslator } from '../../lib/i18n/translator'

const book: Record<string, string> = JSON.parse(readFileSync(new URL('../../lib/i18n/hi.json', import.meta.url), 'utf8'))
const tr = createTranslator(book)

describe('Hindi phrase book (lib/i18n)', () => {
  test('exact text, keeping the spaces around it', () => {
    assert.equal(tr.translate('Cancel'), 'रद्द करें')
    assert.equal(tr.translate('  Pairs in stock '), '  स्टॉक में जोड़ी ')
  })

  test('changing numbers inside a phrase', () => {
    assert.equal(tr.translate('Show more (37 left)'), 'और दिखाएं (37 बाकी)')
    assert.equal(tr.translate('12 articles'), '12 आर्टिकल')
    assert.equal(tr.translate('1 article · updating…'), '1 आर्टिकल · अपडेट हो रहा है…')
  })

  test('status words straight from the database, and lists of roles', () => {
    assert.equal(tr.translate('pending'), 'बाकी')
    assert.equal(tr.translate('Admin, Picker'), 'एडमिन, पिकर')
  })

  test('names, codes and numbers are left alone', () => {
    assert.equal(tr.translate('SX0375G'), null)
    assert.equal(tr.translate('Ramesh Footwear'), null)
    assert.equal(tr.translate('1,250'), null)
    assert.equal(tr.translate('Admin, Ramesh'), null)
  })

  test('every entry is filled in and uses only the placeholders of its English text', () => {
    for (const [en, hi] of Object.entries(book)) {
      assert.ok(hi.trim(), `empty Hindi for "${en}"`)
      const allowed = new Set(en.match(/\{\d+\}/g) ?? [])
      for (const p of hi.match(/\{\d+\}/g) ?? []) assert.ok(allowed.has(p), `"${hi}" uses ${p}, not in "${en}"`)
    }
  })
})
