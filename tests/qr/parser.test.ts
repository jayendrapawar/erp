import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQr, isValidEan13, normaliseQrInput } from '../../lib/qr/parser'
import { BOX_SAMPLES, CARTON_SAMPLES, URL_WRAPPED, LEGACY_DEV_SAMPLES, MALFORMED } from './corpus'

test('every individual-box sample parses to the hand-derived values', () => {
  for (const s of BOX_SAMPLES) {
    const r = parseQr(s.raw)
    assert.equal(r.kind, 'box', s.raw)
    assert.equal(r.status, 'parsed', `${s.raw}: ${JSON.stringify(r.issues)}`)
    assert.equal(r.formatId, s.format, s.raw)
    assert.equal(r.fields.articleCode?.value, s.art, s.raw)
    assert.equal(r.fields.colourCode?.value, s.colour, s.raw)
    assert.equal(r.fields.size?.value, s.size, s.raw)
    assert.equal(r.fields.mrp?.value, s.mrp, s.raw)
    assert.equal(`${String(r.fields.mfgMonth?.value).padStart(2, '0')}/${r.fields.mfgYear?.value}`, s.mfg, s.raw)
    assert.equal(r.fields.serial?.value, s.serial, s.raw)
    assert.equal(r.hasUniqueId, true, s.raw)
    assert.equal(r.dedupeKey, `box:${s.raw}`, s.raw)
    assert.equal(r.raw, s.raw, 'raw input must be preserved unchanged')
  }
})

test('every box label in the corpus is distinct, so every duplicate key is distinct', () => {
  const keys = BOX_SAMPLES.map((s) => parseQr(s.raw).dedupeKey)
  assert.equal(new Set(keys).size, keys.length)
})

test('boxes with identical product details still have different keys', () => {
  const same = BOX_SAMPLES.filter((s) => s.art === 'PUGN42G' && s.size === '6' && s.mfg === '07/2026')
  assert.ok(same.length >= 4)
  assert.equal(new Set(same.map((s) => parseQr(s.raw).dedupeKey)).size, same.length)
})

test('URL-wrapped scans keep their raw text but share the plain label key', () => {
  for (const w of URL_WRAPPED) {
    const wrapped = parseQr(w.raw)
    const plain = parseQr(w.samePlainLabel)
    assert.equal(wrapped.wrapper, 'url')
    assert.equal(wrapped.raw, w.raw)
    assert.equal(wrapped.payload, w.samePlainLabel)
    assert.equal(wrapped.status, 'parsed')
    assert.equal(wrapped.dedupeKey, plain.dedupeKey, 'a wrapped rescan must be caught as a duplicate')
  }
})

test('every outer-carton sample parses as a carton, never as a box', () => {
  for (const s of CARTON_SAMPLES) {
    const r = parseQr(s.raw)
    assert.equal(r.kind, 'carton', s.raw)
    assert.equal(r.status, 'parsed', `${s.raw}: ${JSON.stringify(r.issues)}`)
    assert.equal(r.formatId, s.format, s.raw)
    assert.equal(r.fields.articleCode?.value, s.art, s.raw)
    assert.equal(r.fields.colourCode?.value, s.colour, s.raw)
    assert.equal(r.fields.sizeFrom?.value, s.sizeFrom, s.raw)
    assert.equal(r.fields.sizeTo?.value, s.sizeTo, s.raw)
    assert.equal(r.fields.mrp?.value, s.mrp, s.raw)
    assert.equal(r.fields.cartonDate?.value, s.date, s.raw)
    assert.equal(r.fields.serial?.value, s.serial, s.raw)
    assert.equal(r.fields.size, undefined, 'a carton must not produce a single box size')
  }
})

test('the duplicated SF0204G carton sample normalises to one key', () => {
  const a = parseQr('SF0204G-GYBK0610339.50211020261SQ7T1027217173')
  const b = parseQr(' SF0204G-GYBK0610339.50211020261SQ7T1027217173\n')
  assert.equal(a.dedupeKey, b.dedupeKey)
})

test('sample groups: carton and boxes share product details but no common identifier', () => {
  const groups = new Set(CARTON_SAMPLES.filter((c) => c.group).map((c) => c.group!))
  assert.equal(groups.size, 7)
  for (const g of groups) {
    const carton = parseQr(CARTON_SAMPLES.find((c) => c.group === g)!.raw)
    const boxes = BOX_SAMPLES.filter((b) => b.group === g).map((b) => parseQr(b.raw))
    assert.ok(boxes.length > 0, g)
    for (const box of boxes) {
      assert.equal(box.fields.articleCode?.value, carton.fields.articleCode?.value, g)
      assert.equal(box.fields.colourCode?.value, carton.fields.colourCode?.value, g)
      assert.equal(box.fields.mrp?.value, carton.fields.mrp?.value, g)
      const size = Number(box.fields.size?.value)
      assert.ok(size >= Number(carton.fields.sizeFrom?.value) && size <= Number(carton.fields.sizeTo?.value), `${g} size inside range`)
      // No shared identifier: the box serial never equals or contains the carton serial and vice versa.
      assert.notEqual(box.fields.serial?.value, carton.fields.serial?.value)
      assert.ok(!box.payload.includes(carton.fields.serial!.value), `${g}: carton serial must not appear in box label`)
    }
  }
})

test('EAN-13 values on 2024/2025 labels have valid check digits', () => {
  const eanSamples = BOX_SAMPLES.filter((s) => s.format !== 'relaxo.box.a1.short')
  assert.equal(eanSamples.length, 5)
  for (const s of eanSamples) {
    const r = parseQr(s.raw)
    assert.ok(r.fields.ean, s.raw)
    assert.equal(isValidEan13(r.fields.ean!.value), true, `${r.fields.ean!.value} check digit`)
    assert.equal(r.fields.ean!.confidence, 'verified')
  }
  assert.equal(isValidEan13('8905495614035'), false)
})

test('division is never inferred from the article code prefix', () => {
  for (const s of BOX_SAMPLES) {
    const r = parseQr(s.raw) as unknown as Record<string, unknown>
    assert.equal('division' in r, false)
    assert.equal('division' in (r.fields as object), false)
  }
  // RH0005G has none of the letters the old parser required, and must still parse.
  assert.equal(parseQr('A1RH0005G-OLBK0007-0125R01MA0-169.50-8905495614034-1001-201328063-5XR97-0660847619').status, 'parsed')
})

test('the R-code is cross-checked against the 4-digit code and is preserved', () => {
  const r = parseQr('A1SS0703G-NBOR0007-1026R05MA0-649.00-1005-44GSY-1020602214')
  assert.equal(r.fields.plantCode?.value, '1005')
  assert.deepEqual(r.unknown, [{ position: 'field 2 (R-code)', value: 'R05' }])
  const mismatch = parseQr('A1SS0703G-NBOR0007-1026R05MA0-649.00-1010-44GSY-1020602214')
  assert.ok(mismatch.issues.some((i) => i.code === 'plant_mismatch'))
  assert.equal(mismatch.status, 'parsed', 'a mismatch is a warning, not a rejection')
})

test('legacy development test labels parse as partial with no unique id', () => {
  for (const raw of LEGACY_DEV_SAMPLES) {
    const r = parseQr(raw)
    assert.equal(r.formatId, 'legacy.box.4field')
    assert.equal(r.status, 'partial')
    assert.equal(r.hasUniqueId, false)
    assert.equal(r.dedupeKey, null)
  }
})

test('malformed and incomplete input is classified, never thrown away', () => {
  for (const m of MALFORMED) {
    const r = parseQr(m.raw)
    assert.equal(r.status, m.expectStatus, `${m.name}: ${JSON.stringify(r.issues)}`)
    assert.equal(r.raw, m.raw)
    assert.equal(r.dedupeKey, null, `${m.name} must not be accepted as a unique label`)
    if (r.status !== 'invalid' || m.name !== 'empty') assert.ok(r.issues.length > 0, m.name)
  }
  const cut = parseQr('A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722-XYZ')
  assert.deepEqual(cut.unknown.map((u) => u.value), ['1010', 'Z76BA', '1006101722', 'XYZ'])
  assert.equal(cut.fields.articleCode?.value, 'PUGN42G')
})

test('normalisation strips control characters and stray spaces but reports it', () => {
  const n = normaliseQrInput('﻿a1pugn42g-whwh0006 -0726r10ma0-339.50-1010-z76ba-1006101722\r\n')
  assert.equal(n.payload, 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722')
  assert.ok(n.issues.some((i) => i.code === 'whitespace_removed'))
  assert.ok(n.issues.some((i) => i.code === 'control_chars_removed'))
})
