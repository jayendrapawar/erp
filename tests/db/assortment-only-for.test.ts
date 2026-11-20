// "Only for" assortments (Bahamas sheet: "Hawaii only: HC003G, TR002G, …"): used automatically only for
// the listed articles; another article with the same pairs must choose — use it too, or a new one.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { applyUpload, listActiveAssortments, previewUpload } from '../../lib/catalog/assortment-store'
import { parseAssortmentSheet } from '../../lib/catalog/assortments'
import { billDetail, saveBill, setLineAssortment } from '../../lib/purchases/store'
import { manualCartonOptions, receiveManualCarton } from '../../lib/purchases/manual-carton'
import type { ParsedBill } from '../../lib/purchases/relaxo-bill'
import type { Actor } from '../../lib/db/types'

const HEAD = ['Division', 'Segment', 'Pairs per carton', 'Assortment code', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', 'Total', 'Note']
const row = (seg: string, pairs: number, code: number, sizes: Record<string, number>, note: string) =>
  ['Bahamas', seg, pairs, code, ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'].map(s => sizes[s] ?? null), pairs, note]
const sheet = [HEAD,
  row('Gents', 36, 608, { 6: 12, 7: 12, 8: 12 }, 'Bahamas'),
  row('Gents', 42, 608, { 6: 14, 7: 14, 8: 14 }, 'Hawaii only: HC003G, TR002G, SUP001G, ORTH01G, ORTH02G'),
  row('Gents', 30, 610, { 6: 9, 7: 9, 8: 6, 9: 4, 10: 2 }, 'Hawaii only: FIP002G'),
].map((values, i) => ({ rowNumber: i + 1, values }))

const BOX_NEW = 'A1NEW001G-BKBK0007-0826R10MA0-299.00-1010-Z99AA-1006109901'
const line = (lineNo: number, art: string, pairs: number) => ({ lineNo, hsn: '64029990', articleCode: art, colourCode: 'BKBK', sizeFrom: '6', sizeTo: '8', packLetter: 'A', description: art, cartons: 2, pairsPerCarton: pairs, pairs: pairs * 2, mrp: 299, rate: 199, amount: 199 * pairs * 2 })
const bill: ParsedBill = {
  docType: 'proforma', supplier: 'Relaxo Footwears Limited', refNo: '0520777777/1062', invoiceNo: 'RV0000000007', billDate: '2026-11-15',
  soNo: null, soDate: null, poNo: null, customerCode: null, totalCartons: 6, totalPairs: 2 * 42 + 2 * 42 + 2 * 36, grossAmount: 1,
  lines: [line(1, 'HC003G', 42), line(2, 'NEW001G', 42), line(3, 'ABC001G', 36)],
}

describe('"only for" carton assortments (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-admin','Admin','a@test.local','admin')`)
    const a = await h.db.execute<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode") VALUES ('NEW-1','NEW001G','Black','BKBK') RETURNING id`)
    await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") SELECT ${a.rows[0].id}, x::text, x FROM generate_series(6, 8) x`)
  })
  after(async () => { await h?.close() })

  test('the upload reads "only for" from the note', async () => {
    const parsed = parseAssortmentSheet(sheet)
    assert.deepEqual(parsed.rows.map(r => r.input.onlyFor), ['', 'HC003G,ORTH01G,ORTH02G,SUP001G,TR002G', 'FIP002G'])
    const plan = await previewUpload(h.db, parsed.rows)
    assert.deepEqual(plan.map(l => l.status), ['new', 'new', 'new'])
    await applyUpload(h.db, admin, parsed.rows, 'Bahamas_assortment_upload.xlsx')
    assert.equal((await listActiveAssortments(h.db)).length, 3)
  })

  test('a bill uses it automatically only for the listed article; another article must choose', async () => {
    const r = await saveBill(h.db, admin, bill, { name: 'b.pdf', sha256: 'd'.repeat(64) }, 'Bahamas')
    assert.equal(r.status, 'saved')
    if (r.status !== 'saved') return
    const d = (await billDetail(h.db, r.id))!
    const [hc, nw, abc] = d.lines
    assert.equal(hc.assortment?.onlyFor, 'HC003G,ORTH01G,ORTH02G,SUP001G,TR002G') // listed → chosen
    assert.equal(nw.assortment, null)                                         // not listed → not chosen
    assert.deepEqual(nw.options.map(o => [o.covers, o.onlyFor.startsWith('HC003G')]), [[false, true]])
    assert.equal(abc.assortment?.onlyFor, '')                                 // ordinary assortment as before
    // Must confirm before using it for NEW001G; confirming adds the article to the list.
    await assert.rejects(setLineAssortment(h.db, admin, nw.id, nw.options[0].id), /only for other articles/)
    await setLineAssortment(h.db, admin, nw.id, nw.options[0].id, true)
    const after = (await billDetail(h.db, r.id))!.lines[1]
    assert.ok(after.assortment?.onlyFor.split(',').includes('NEW001G'))
  })

  test('manual entry: an "only for" assortment of others is offered, never chosen silently; a new one is kept separate', async () => {
    // A second bill so NEW001G has a line without an assortment again: use a 30-pair line (FIP002G only).
    const b2: ParsedBill = { ...bill, refNo: '0520777778/1062', invoiceNo: 'RV0000000008', totalCartons: 1, totalPairs: 30,
      lines: [{ ...line(1, 'NEW001G', 30), sizeTo: '10', cartons: 1, pairs: 30 }] }
    const r = await saveBill(h.db, admin, b2, { name: 'b2.pdf', sha256: 'e'.repeat(64) }, 'Bahamas')
    assert.equal(r.status, 'saved')
    const o = await manualCartonOptions(h.db, BOX_NEW)
    assert.ok(o.ok)
    if (!o.ok) return
    const l = o.lines.find(x => x.pairsPerCarton === 30)!
    assert.deepEqual(l.options.map(x => [x.onlyFor, x.covers]), [['FIP002G', false]])
    await assert.rejects(receiveManualCarton(h.db, admin, { rawBox: BOX_NEW, clientEventId: randomUUID(), lineId: l.lineId, assortmentId: l.options[0].id }), /only for other articles/)
    // "Enter a new assortment": saved only for NEW001G, next to the FIP002G one (same key, different "only for").
    const res = await receiveManualCarton(h.db, admin, { rawBox: BOX_NEW, clientEventId: randomUUID(), lineId: l.lineId,
      newAssortment: { segment: 'Gents', sizes: [{ size: '6', pairs: 10 }, { size: '7', pairs: 10 }, { size: '8', pairs: 10 }] } })
    assert.equal(res.status, 'received')
    const both = (await listActiveAssortments(h.db)).filter(a => a.packing === 30 && a.code === '610')
    assert.deepEqual(both.map(a => a.onlyFor).sort(), ['FIP002G', 'NEW001G'])
  })
})
