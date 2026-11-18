import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { expandSizeRange, normaliseSizeLabel, sortSizes } from '../../lib/catalog/sizes'
import { buildWorkbookModel, hasSparxCodeOutsideScope, isSparxScope, rowsFromSheet, type WorkbookRow } from '../../lib/catalog/sparx-workbook'
import { planCatalogImport, type CatalogState } from '../../lib/catalog/import'

describe('size ranges', () => {
  test('ascending ranges expand to every size', () => {
    assert.deepEqual(expandSizeRange(6, 10), { ok: true, min: '6', max: '10', sizes: ['6', '7', '8', '9', '10'], wraps: false })
    assert.deepEqual(expandSizeRange('2', '5').ok && expandSizeRange('2', '5'), { ok: true, min: '2', max: '5', sizes: ['2', '3', '4', '5'], wraps: false })
    assert.deepEqual((expandSizeRange(1, 1) as { sizes: string[] }).sizes, ['1'])
  })
  test('children’s ranges wrap from 13 to 1', () => {
    const r = expandSizeRange(11, 1)
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.sizes, ['11', '12', '13', '1'])
    assert.deepEqual((expandSizeRange(11, 5) as { sizes: string[] }).sizes, ['11', '12', '13', '1', '2', '3', '4', '5'])
  })
  test('invalid ranges are rejected, not guessed', () => {
    assert.equal(expandSizeRange(10, 6).ok, false)
    assert.equal(expandSizeRange('', 6).ok, false)
    assert.equal(expandSizeRange(6, 14).ok, false)
    assert.equal(expandSizeRange('6.5', 8).ok, false)
  })
  test('labels normalise and sort by chart', () => {
    assert.equal(normaliseSizeLabel('06'), '6')
    assert.deepEqual(sortSizes(['1', '13', '2', '11', '12']), ['11', '12', '13', '1', '2']) // children's chart
    assert.deepEqual(sortSizes(['11', '6', '12', '10']), ['6', '10', '11', '12']) // adult chart
  })
})

const row = (n: number, artName: string, artCode: string, color: string, colorCode: string, min: number | string, max: number | string): WorkbookRow =>
  ({ rowNumber: n, artName, artCode, color, colorCode, minSize: String(min), maxSize: String(max), raw: {} })

describe('workbook model', () => {
  test('header mapping ignores the empty id columns and keeps raw cells', () => {
    const rows = rowsFromSheet([
      { rowNumber: 1, values: ['id', null, 'artName', 'artCode', 'color', 'colorCode', 'maxSize', 'minSize'] },
      { rowNumber: 2, values: [null, null, 'SS-856', 'ss0856g ', 'Brown Rust', 'BRRT', 10, 6] },
      { rowNumber: 3, values: [null, null, null, null, null, null, null, null] },
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].artCode, 'SS0856G')
    assert.equal(rows[0].minSize, '6')
    assert.equal(rows[0].maxSize, '10')
    assert.deepEqual(rows[0].raw, { artname: 'SS-856', artcode: 'ss0856g ', color: 'Brown Rust', colorcode: 'BRRT', maxsize: 10, minsize: 6 })
  })

  test('several size ranges of one variant stay one variant with separate ranges', () => {
    const m = buildWorkbookModel([
      row(2, 'SK-1016', 'SD1016B', 'Pearl White D.Green', 'PWNG', 11, 13),
      row(3, 'SK-1016', 'SD1016B', 'Pearl White D.Green', 'PWNG', 1, 1),
      row(4, 'SK-1016', 'SD1016B', 'Pearl White D.Green', 'PWNG', 2, 5),
    ])
    assert.equal(m.variants.length, 1)
    const v = m.variants[0]
    assert.deepEqual(v.ranges.map(r => `${r.min}-${r.max}`), ['11-13', '1-1', '2-5'])
    assert.deepEqual(v.sizes.map(s => s.label), ['11', '12', '13', '1', '2', '3', '4', '5'])
    assert.equal(v.needsReview, false)
    assert.equal(m.issues.filter(i => i.severity !== 'info').length, 0)
  })

  test('adult 6–10 and 11–12 ranges combine without inventing a range', () => {
    const m = buildWorkbookModel([row(2, 'SFG-48', 'SF0048G', 'Olive', 'OLOL', 6, 10), row(3, 'SFG-48', 'SF0048G', 'Olive', 'OLOL', 11, 12)])
    assert.deepEqual(m.variants[0].ranges.map(r => `${r.min}-${r.max}`), ['6-10', '11-12'])
    assert.deepEqual(m.variants[0].sizes.map(s => s.label), ['6', '7', '8', '9', '10', '11', '12'])
  })

  test('conflicting colour names are kept and flagged, not chosen', () => {
    const m = buildWorkbookModel([
      row(2, 'SM-323', 'SD0323G', 'White Black', 'BKWH', 4, 5),
      row(3, 'SM-323', 'SD0323G', 'Black White', 'BKWH', 4, 5),
    ])
    const v = m.variants[0]
    assert.deepEqual(v.colorNames, ['White Black', 'Black White'])
    assert.equal(v.displayColor, 'White Black / Black White')
    assert.equal(v.needsReview, true)
    assert.ok(m.issues.some(i => i.kind === 'colour_name_conflict' && i.severity === 'review'))
    assert.ok(m.issues.some(i => i.kind === 'repeated_range'))
  })

  test('exact duplicate rows count once; overlapping ranges are flagged', () => {
    const m = buildWorkbookModel([
      row(2, 'SM-814', 'SX0814S', 'Black N.Green', 'BKGN', 11, 12),
      row(3, 'SM-814', 'SX0814S', 'Black N.Green', 'BKGN', 11, 12),
      row(4, 'SS-702', 'SS0702B', 'Black Red', 'BKRD', 1, 5),
      row(5, 'SS-702', 'SS0702B', 'Black Red', 'BKRD', 1, 1),
    ])
    assert.equal(m.stats.exactDuplicateRows, 1)
    assert.equal(m.rowOutcome.get(3)?.outcome, 'duplicate')
    assert.ok(m.issues.some(i => i.kind === 'range_overlap' && i.artCode === 'SS0702B'))
    assert.deepEqual(m.variants.find(v => v.artCode === 'SS0702B')!.sizes.map(s => s.label), ['1', '2', '3', '4', '5'])
  })

  test('bad rows are rejected with a reason; similar colour codes are not merged', () => {
    const m = buildWorkbookModel([
      row(2, 'SS-101', 'SS0101C', 'Black', 'BKBK', 11, 13),
      row(3, 'SS-101', 'SS0101C', 'Black', 'BLAK', 11, 13),
      row(4, 'SS-1', 'BAD', 'Black', 'BKBK', 6, 10),
      row(5, 'SS-2', 'SS0002G', 'Black', 'BKBK', 10, 6),
    ])
    assert.equal(m.variants.length, 2)
    assert.ok(m.issues.some(i => i.kind === 'same_colour_name_different_code'))
    assert.equal(m.rowOutcome.get(4)?.outcome, 'rejected')
    assert.equal(m.rowOutcome.get(5)?.outcome, 'rejected')
  })

  test('scope follows the article name family, then the code', () => {
    assert.equal(isSparxScope('', 'SM-1079'), true)
    assert.equal(isSparxScope('SX0991G', 'SM990'), true)
    assert.equal(isSparxScope('SF0561G', 'FL-561'), false)
    assert.equal(hasSparxCodeOutsideScope('SF0561G', 'FL-561'), true)
    assert.equal(isSparxScope('', 'PUG-198'), false)
    assert.equal(isSparxScope('TT-2026', 'Test Article'), false)
  })
})

describe('import plan', () => {
  const empty = (): CatalogState => ({
    variants: [], skus: [], ranges: [], catalogArticles: [], colours: [],
    scansByArticle: new Map(), stockByArticle: new Map(), stockBySku: new Map(), linksByArticle: new Map(), pendingScanKeys: new Set(), openSourceIssues: 0,
  })

  test('matches on code + colour only, keeps ids, retires in-scope leftovers, leaves other brands', () => {
    const m = buildWorkbookModel([row(2, 'SM-950', 'SX0950G', 'Black Gold', 'BKGO', 6, 10)])
    const s = empty()
    const base = { active: true, reviewStatus: 'unverified', catalogArticleId: null, retiredAt: null }
    s.variants = [
      { ...base, id: 10, artName: 'SM-950 old', artCode: 'sx0950g', colorCode: 'bkgo', color: 'Blk Gold', minSize: '6', maxSize: '12' },
      { ...base, id: 11, artName: 'SM-950', artCode: '', colorCode: '', color: 'Black Gold', minSize: '6', maxSize: '10' },
      { ...base, id: 12, artName: 'FL-561', artCode: 'SF0561G', colorCode: 'BKBK', color: 'Black', minSize: '3', maxSize: '8' },
      { ...base, id: 13, artName: 'PUG-198', artCode: '', colorCode: '', color: 'Tan', minSize: '6', maxSize: '10' },
    ]
    s.skus = ['06', '7', '8', '9', '10', '11', '12'].map((l, i) => ({ id: 100 + i, articleId: 10, sizeLabel: l, active: true, sortOrder: i }))
    s.stockBySku.set(106, 2)
    const p = planCatalogImport(m, s)
    assert.equal(p.variants.matched, 1)
    assert.equal(p.variants.update[0].id, 10)
    assert.equal(p.variants.create.length, 0)
    assert.deepEqual(p.retire.map(r => r.id), [11]) // codeless Sparx row retired, not merged
    assert.deepEqual(p.possibleMatches.map(x => x.id), [11]) // …but reported as a candidate
    assert.equal(p.outOfScope.variants, 2) // FL-561 and PUG-198 untouched
    assert.ok(p.reviewItems.some(i => i.kind === 'brand_code_mismatch' && i.articleId === 12))
    assert.deepEqual(p.skus.update.map(u => [u.id, u.label]).find(([id]) => id === 100), [100, '6']) // "06" normalised, same id
    assert.deepEqual(p.skus.deactivate.map(d => d.label).sort(), ['11', '12'])
    assert.ok(p.reviewItems.some(i => i.kind === 'retired_size_in_use')) // size 12 holds stock
    assert.equal(p.isNoop, false)
  })

  test('trustSource: source conflicts are reported but approved, and open ones get closed', () => {
    const m = buildWorkbookModel([row(2, 'SM-323', 'SD0323G', 'White Black', 'BKWH', 4, 5), row(3, 'SM-323', 'SD0323G', 'Black White', 'BKWH', 4, 5)])
    assert.ok(m.issues.some(i => i.kind === 'colour_name_conflict'))
    const normal = planCatalogImport(m, empty())
    assert.equal(normal.variants.create[0].reviewStatus, 'needs_review')
    assert.ok(normal.reviewItems.some(i => i.kind === 'colour_name_conflict'))
    const s = { ...empty(), openSourceIssues: 3 }
    const trusted = planCatalogImport(m, s, { trustSource: true })
    assert.equal(trusted.variants.create[0].reviewStatus, 'approved')
    assert.equal(trusted.variants.create[0].color, 'White Black / Black White') // no name chosen
    assert.equal(trusted.reviewItems.filter(i => i.kind === 'colour_name_conflict').length, 0)
    assert.equal(trusted.closeSourceIssues, true)
  })
})
