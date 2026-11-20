// Read-only check: in New Order, can two different article codes' sizes merge? (owner, 20 Nov 2026)
//   npx tsx scripts/catalog/check-order-sizes.ts --env-file .env.local
// Runs the same grouping New Order uses (lib/catalog/order-catalogue.ts) over every active article and
// reports (1) collisions — must be 0 — and (2) names whose colours span several codes with the same
// size labels (shown as separate code blocks, like SS-101).

import pg from 'pg'
import { groupArticles, type ColourRow, type SizeRow } from '../../lib/catalog/order-catalogue'
import { connect, resolveTarget, log } from '../db/_connect'

async function main() {
  const t = resolveTarget()
  const c = await connect(t, { readOnly: true })
  try {
    const arts = (await c.query<{ id: number; artName: string; artCode: string }>(`SELECT id, "artName", "artCode" FROM articles WHERE active ORDER BY "artName", "artCode", id`)).rows
    const cols = (await c.query<ColourRow>(`SELECT id, "articleId", "colorName", "colorHex" FROM article_colors ORDER BY "articleId", id`)).rows
    const sizes = (await c.query<SizeRow>(`SELECT id, "articleId", "sizeLabel", "sortOrder" FROM article_sizes WHERE active ORDER BY "articleId", "sortOrder"`)).rows
    const byArt = <T extends { articleId: number }>(rows: T[]) => {
      const m = new Map<number, T[]>()
      for (const r of rows) { const k = Number(r.articleId); if (!m.has(k)) m.set(k, []); m.get(k)!.push({ ...r, articleId: k }) }
      return m
    }
    const details = groupArticles(arts.map(a => ({ ...a, id: Number(a.id) })), byArt(cols), byArt(sizes))
    let collisions = 0
    const blocks: string[] = []
    for (const d of details.values()) {
      for (const colour of d.colors) {
        const rows = d.sizes.filter(s => s.articleId === colour.articleId)
        const pairs = new Set(rows.map(s => `${s.artCode}|${s.sizeLabel}`))
        const keys = new Set(rows.map(s => s.key))
        if (keys.size !== pairs.size) { collisions++; log(`COLLISION ${d.artNumber} ${colour.colorName}`) }
        const codes = new Set(rows.map(s => s.artCode))
        const labels = rows.map(s => s.sizeLabel)
        if (codes.size > 1 && new Set(labels).size < labels.length) blocks.push(`${d.artNumber} ${colour.colorName}: ${[...codes].join(', ')}`)
      }
    }
    log(`Target ${t.endpoint}: ${details.size} article names, ${arts.length} active variants.`)
    log(`Collisions (sizes of different codes merging): ${collisions}`)
    log(`Colours shown as separate code blocks because sizes overlap: ${blocks.length}`)
    for (const b of blocks.slice(0, 40)) log(`  ${b}`)
    if (collisions) process.exitCode = 1
  } finally {
    await c.end()
  }
}

void pg
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
