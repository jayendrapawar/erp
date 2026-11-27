// Read-only validation of the article catalogue against scanning, order booking and reporting.
//
//   npx tsx scripts/catalog/validate.ts --env-file .env.local [--out docs/catalog/catalog-validation.md]
//
// 1. Scanning: every box label in the QR regression corpus is resolved with the scanner's own
//    resolveSku(); every carton label's article, colour and size range is checked against the master.
// 2. Order booking: the same filters as loadCatalogue() (active variants and SKUs, sortOrder).
// 3. Reporting: stock on retired variants is still reachable through its SKU ids.

import fs from 'node:fs'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../../lib/db/schema'
import type { Db } from '../../lib/db/types'
import { parseQr } from '../../lib/qr/parser'
import { resolveSku } from '../../lib/inventory/scan-service'
import { BOX_SAMPLES, CARTON_SAMPLES } from '../../tests/qr/corpus'
import { arg, log, poolConfig, resolveTarget } from '../db/_connect'

type Row = Record<string, unknown>

async function main() {
  const t = resolveTarget()
  const out = arg('out') || 'docs/catalog/catalog-validation.md'
  const pool = new pg.Pool(poolConfig(t, arg('schema') || undefined, 1))
  const db = drizzle(pool, { schema }) as unknown as Db
  await pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY').catch(() => undefined)
  const L: string[] = ['# Article catalogue validation', '', `Database \`${t.endpoint}\`, ${new Date().toISOString()}. Read-only.`, '']
  const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)).rows as Row[]
  try {
    // 1a. Boxes
    const boxes = new Map<string, { art: string; colour: string; size: string; n: number }>()
    for (const b of BOX_SAMPLES) {
      const k = `${b.art}|${b.colour}|${b.size}`
      boxes.set(k, { art: b.art, colour: b.colour, size: b.size, n: (boxes.get(k)?.n ?? 0) + 1 })
    }
    L.push('## 1. Scanning — box labels from the regression corpus', '', '| Article | Colour | Size | Labels | Scanner result |', '|---|---|---|---:|---|')
    const boxResults: Record<string, number> = {}
    for (const b of boxes.values()) {
      const r = await resolveSku(db, b.art, b.colour, b.size)
      boxResults[r.resolution] = (boxResults[r.resolution] ?? 0) + b.n
      L.push(`| ${b.art} | ${b.colour} | ${b.size} | ${b.n} | ${r.resolution}${r.skuId ? ` (SKU ${r.skuId})` : ''} |`)
    }
    L.push('', `Totals: ${Object.entries(boxResults).map(([k, v]) => `${k} ${v}`).join(', ')}. Labels whose article is not in the master are saved as Missing Articles by the scanner (never guessed).`, '')

    // 1b. Cartons
    L.push('## 2. Carton labels vs the master (no stock is posted from cartons)', '', '| Article | Colour | Range | Variant | Range sizes present as SKUs |', '|---|---|---|---|---|')
    const seen = new Set<string>()
    let cartonKnown = 0, cartonTotal = 0
    for (const c of CARTON_SAMPLES) {
      const p = parseQr(c.raw)
      const f = p.fields as Record<string, { value: unknown } | undefined>
      const art = String(f.articleCode?.value ?? ''), col = String(f.colourCode?.value ?? '')
      const from = Number(f.sizeFrom?.value), to = Number(f.sizeTo?.value)
      const k = `${art}|${col}|${from}-${to}`
      if (seen.has(k)) continue
      seen.add(k); cartonTotal++
      const v = await q(sql`SELECT a.id, a.active, array_agg(s."sizeLabel") FILTER (WHERE s.active) AS sizes FROM articles a LEFT JOIN article_sizes s ON s."articleId" = a.id
        WHERE upper(btrim(a."artCode")) = ${art} AND upper(btrim(a."colorCode")) = ${col} GROUP BY a.id, a.active`)
      const want: string[] = []
      for (let s = from; s <= to; s++) want.push(String(s))
      if (!v.length) { L.push(`| ${art} | ${col} | ${from}–${to} | not in master | — |`); continue }
      const sizes = (v[0].sizes as string[] | null) ?? []
      const missing = want.filter(s => !sizes.includes(s))
      if (v[0].active) cartonKnown++
      L.push(`| ${art} | ${col} | ${from}–${to} | #${v[0].id}${v[0].active ? '' : ' (retired)'} | ${missing.length ? `missing ${missing.join(', ')}` : 'all'} |`)
    }
    L.push('', `${cartonKnown} of ${cartonTotal} distinct carton article/colour/range combinations are active catalogue variants.`, '')

    // 2. Order booking
    const [book] = await q(sql`SELECT count(DISTINCT "artName")::int AS names, count(*)::int AS variants FROM articles WHERE active`)
    const [retiredOffered] = await q(sql`SELECT count(DISTINCT a."artName")::int AS n FROM articles a WHERE NOT a.active
      AND NOT EXISTS (SELECT 1 FROM articles b WHERE b.active AND b."artName" = a."artName")`)
    const kids = await q(sql`SELECT a."artName", a."artCode", a."colorCode", string_agg(s."sizeLabel", ' ' ORDER BY s."sortOrder") AS sizes
      FROM articles a JOIN article_sizes s ON s."articleId" = a.id AND s.active WHERE a.active AND a."artCode" IN ('SD1016B', 'SS0702B', 'SF0048G') GROUP BY 1, 2, 3 ORDER BY 2, 3 LIMIT 6`)
    L.push('## 3. Order booking (same filters as the booking catalogue)', '')
    L.push(`- Article names offered: ${book.names} (${book.variants} active variants).`)
    L.push(`- Retired article names no longer offered: ${retiredOffered.n}.`)
    L.push('- Size order as booked (children’s runs 11, 12, 13 before 1):')
    for (const k of kids) L.push(`  - ${k.artName} ${k.artCode} ${k.colorCode}: ${k.sizes}`)
    L.push('')

    // 3. Reporting
    const rep = await q(sql`SELECT a.id, a."artName", a."artCode", a."colorCode", a.active, b.provenance, sum(b.quantity)::int AS qty
      FROM stock_balances b JOIN article_sizes s ON s.id = b."skuId" JOIN articles a ON a.id = s."articleId"
      GROUP BY 1, 2, 3, 4, 5, 6 HAVING sum(b.quantity) <> 0 ORDER BY 1`)
    L.push('## 4. Reporting — stock stays attached to its SKUs', '')
    L.push(`${rep.length} variant/provenance rows hold stock; ${rep.filter(r => !r.active).length} of them are on retired variants and still appear in stock reports (history is never dropped).`, '')
    for (const r of rep.slice(0, 20)) L.push(`- #${r.id} ${r.artName} ${r.artCode} ${r.colorCode}${r.active ? '' : ' (retired)'}: ${r.qty} ${r.provenance}`)
    L.push('')
  } finally {
    await pool.end()
  }
  fs.mkdirSync('docs/catalog', { recursive: true })
  fs.writeFileSync(out, L.join('\n'))
  log(`Validation written to ${out}`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
