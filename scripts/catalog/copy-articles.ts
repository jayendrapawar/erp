// Copy chosen article-master rows from one database to another (owner, 20 Nov 2026: edits made on the
// development database → production). Only the listed article code + colour code pairs are touched.
//
//   Preview:  npx tsx scripts/catalog/copy-articles.ts --source-env-file .env.local --env-file .env \
//               --codes "SS0101G:CLCL,FL0454G:GYBK" --delete "SS0101C:BLAK" --actor you@example.com
//   Apply:    … --apply --confirm <target endpoint>   (needs a backup of the target from the last 2 hours)
//
// Per listed pair the target is made to match the source:
//   • exists (same code + colour code) → name/segment/division filled when blank, sizes synced
//     (a size is switched off only when it holds no stock);
//   • a "colour code pending" row of the same code + colour name → gets the colour code (same id);
//   • otherwise → inserted with its colour, sizes and catalogue link.
// --delete pairs: deleted when nothing refers to them, else switched off (as Master → Delete does).
// One transaction; an audit row per change; waiting scans of new codes are posted.

import fs from 'node:fs'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../../lib/db/schema'
import type { Actor, Db } from '../../lib/db/types'
import { audit } from '../../lib/audit'
import { normalizeArticleName, normalizeArticleValue } from '../../lib/article-utils'
import { sizeSortOrders, sortSizes } from '../../lib/catalog/sizes'
import { resolvePendingScans } from '../../lib/inventory/scan-service'
import { arg, flag, log, poolConfig, recentBackupExists, requireWriteConfirmation, resolveTarget } from '../db/_connect'

type Src = { artName: string; artCode: string; color: string; colorCode: string; segment: string | null; division: string | null; source: string; sizes: string[] }

function sourceUrl(envFile: string): string {
  const m = fs.readFileSync(envFile, 'utf8').match(/^DATABASE_URL\s*=\s*(.*)$/m)
  if (!m) throw new Error(`${envFile} has no DATABASE_URL.`)
  const u = new URL(m[1].trim().replace(/^["']|["']$/g, '')); u.hostname = u.hostname.replace('-pooler.', '.')
  return u.toString()
}
const pairs = (v: string | undefined) => (v ?? '').split(',').map(p => p.trim()).filter(Boolean).map(p => {
  const [code, colour] = p.split(':'); return { code: normalizeArticleValue(code), colour: normalizeArticleValue(colour) }
})

async function main() {
  const t = resolveTarget()
  const srcFile = arg('source-env-file')
  if (!srcFile) throw new Error('Pass --source-env-file <file>.')
  const codes = pairs(arg('codes')), dels = pairs(arg('delete'))
  const apply = flag('apply')
  if (apply) {
    requireWriteConfirmation(t)
    if (!recentBackupExists(t.endpoint, 'public')) throw new Error(`No backup of ${t.endpoint} from the last 2 hours. Run npm run db:backup first.`)
  }
  const src = new pg.Client({ connectionString: sourceUrl(srcFile), ssl: { rejectUnauthorized: false } })
  await src.connect()
  const rows: Src[] = []
  for (const p of codes) {
    const r = (await src.query(`SELECT a."artName", a."artCode", a.color, a."colorCode", a.segment, a.division, a.source,
        coalesce((SELECT array_agg(s."sizeLabel" ORDER BY s."sortOrder") FROM article_sizes s WHERE s."articleId" = a.id AND s.active), '{}') AS sizes
      FROM articles a WHERE upper(btrim(a."artCode")) = $1 AND upper(btrim(a."colorCode")) = $2 AND a.active LIMIT 1`, [p.code, p.colour])).rows[0]
    if (!r) throw new Error(`Source has no active ${p.code} ${p.colour}.`)
    rows.push({ ...r, artName: normalizeArticleName(r.artName), sizes: r.sizes as string[] })
  }
  await src.end()

  const pool = new pg.Pool(poolConfig(t))
  const db = drizzle(pool, { schema }) as unknown as Db
  let actor: Actor = { id: null, name: 'Article copy (script)' }
  const email = arg('actor')
  if (email) {
    const u = (await db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM "user" WHERE email = ${email}`)).rows[0]
    if (u) actor = { id: u.id, name: u.name }
  }
  log(`Target ${t.endpoint}${apply ? ' — APPLYING' : ' — preview only'}`)
  try {
    await db.transaction(async (tx) => {
      const NORM = (c: string) => sql.raw(`upper(regexp_replace(btrim(${c}), '\\s+', ' ', 'g'))`)
      for (const s of rows) {
        const found = (await tx.execute<{ id: number; artName: string; colorCode: string; segment: string | null; division: string | null }>(sql`
          SELECT id, "artName", "colorCode", segment, division FROM articles
          WHERE ${NORM('"artCode"')} = ${s.artCode} AND (${NORM('"colorCode"')} = ${s.colorCode}
                OR (btrim("colorCode") = '' AND ${NORM('color')} = ${normalizeArticleValue(s.color)}))
          ORDER BY (btrim("colorCode") <> '') DESC LIMIT 1 FOR UPDATE`)).rows[0]
        const order = sizeSortOrders(sortSizes(s.sizes))
        const sorted = sortSizes(s.sizes)
        if (!found) {
          const [ins] = await tx.insert(schema.articles).values({ artName: s.artName, artCode: s.artCode, color: s.color, colorCode: s.colorCode, segment: s.segment, division: s.division,
            minSize: sorted[0] ?? '', maxSize: sorted[sorted.length - 1] ?? '', reviewStatus: 'approved', source: (s.source as 'manual') ?? 'manual' }).returning({ id: schema.articles.id })
          await tx.insert(schema.articleColors).values({ articleId: ins.id, colorName: s.color, colorHex: s.colorCode || null })
          if (sorted.length) await tx.insert(schema.articleSizes).values(sorted.map(l => ({ articleId: ins.id, sizeLabel: l, sortOrder: order.get(l)! })))
          await tx.execute(sql`INSERT INTO catalog_articles ("artCode", "artName", source) VALUES (${s.artCode}, ${s.artName}, 'manual') ON CONFLICT ("artCode") DO NOTHING`)
          await tx.execute(sql`UPDATE articles a SET "catalogArticleId" = c.id FROM catalog_articles c WHERE a.id = ${ins.id} AND c."artCode" = a."artCode"`)
          await audit(tx, { actor, action: 'article.copied_from_development', entityType: 'article', entityId: ins.id, after: s })
          log(`  ADD   ${s.artCode} ${s.colorCode} "${s.artName}" ${s.color} · ${s.segment ?? '-'} · ${s.division ?? '-'} · sizes ${sorted.join(',')}`)
        } else {
          const set: Record<string, unknown> = {}
          if (!found.colorCode.trim()) set.colorCode = s.colorCode
          if (!found.segment && s.segment) set.segment = s.segment
          if (!found.division && s.division) set.division = s.division
          const cur = (await tx.execute<{ id: number; sizeLabel: string; active: boolean; stock: number }>(sql`
            SELECT s.id, s."sizeLabel", s.active, coalesce((SELECT sum(b.quantity) FROM stock_balances b WHERE b."skuId" = s.id), 0)::int AS stock
            FROM article_sizes s WHERE s."articleId" = ${found.id}`)).rows
          const add = sorted.filter(l => !cur.some(c => c.sizeLabel === l && c.active))
          const drop = cur.filter(c => c.active && !sorted.includes(c.sizeLabel))
          const blocked = drop.filter(c => Number(c.stock) !== 0)
          if (blocked.length) throw new Error(`${s.artCode} ${s.colorCode}: size ${blocked.map(b => b.sizeLabel).join(',')} still has stock — not switched off. Nothing written.`)
          for (const l of add) {
            const row = cur.find(c => c.sizeLabel === l)
            if (row) await tx.execute(sql`UPDATE article_sizes SET active = true, "sortOrder" = ${order.get(l)!} WHERE id = ${row.id}`)
            else await tx.insert(schema.articleSizes).values({ articleId: found.id, sizeLabel: l, sortOrder: order.get(l)! })
          }
          for (const c of drop) await tx.execute(sql`UPDATE article_sizes SET active = false WHERE id = ${c.id}`)
          if (add.length || drop.length) { set.minSize = sorted[0] ?? ''; set.maxSize = sorted[sorted.length - 1] ?? '' }
          if (Object.keys(set).length) await tx.update(schema.articles).set(set).where(sql`id = ${found.id}`)
          if (set.colorCode) await tx.execute(sql`UPDATE article_colors SET "colorHex" = ${s.colorCode} WHERE "articleId" = ${found.id}`)
          if (Object.keys(set).length || add.length || drop.length) {
            await audit(tx, { actor, action: 'article.copied_from_development', entityType: 'article', entityId: found.id, before: found, after: { ...set, sizesAdded: add, sizesOff: drop.map(d => d.sizeLabel) } })
            log(`  EDIT  ${s.artCode} ${s.colorCode} (#${found.id})${set.colorCode ? ' colour code ' + s.colorCode : ''}${set.segment ? ' segment ' + s.segment : ''}${set.division ? ' division ' + s.division : ''}${add.length ? ' +sizes ' + add.join(',') : ''}${drop.length ? ' −sizes ' + drop.map(d => d.sizeLabel).join(',') : ''}`)
          } else log(`  same  ${s.artCode} ${s.colorCode}`)
        }
        await resolvePendingScans(tx, actor, s.artCode, s.colorCode)
      }
      for (const d of dels) {
        const a = (await tx.execute<{ id: number; artName: string }>(sql`SELECT id, "artName" FROM articles WHERE ${NORM('"artCode"')} = ${d.code} AND ${NORM('"colorCode"')} = ${d.colour} AND active FOR UPDATE`)).rows[0]
        if (!a) { log(`  gone  ${d.code} ${d.colour} (not in target)`); continue }
        const used = await tx.execute(sql`
          SELECT 1 FROM scan_events WHERE "articleId" = ${a.id}
          UNION ALL SELECT 1 FROM stock_movements m JOIN article_sizes s ON s.id = m."skuId" WHERE s."articleId" = ${a.id} LIMIT 1`)
        if (used.rows.length) {
          await tx.execute(sql`UPDATE articles SET active = false, "retiredAt" = now(), "retiredReason" = 'Deleted on development; in use, so switched off' WHERE id = ${a.id}`)
          await audit(tx, { actor, action: 'article.deactivated', entityType: 'article', entityId: a.id, reason: 'Copied delete from development; article is in use' })
          log(`  OFF   ${d.code} ${d.colour} (#${a.id}) — in use, switched off`)
        } else {
          await tx.execute(sql`DELETE FROM articles WHERE id = ${a.id}`)
          await audit(tx, { actor, action: 'article.deleted', entityType: 'article', entityId: a.id, before: a, reason: 'Copied from development' })
          log(`  DEL   ${d.code} ${d.colour} (#${a.id})`)
        }
      }
      if (!apply) throw new Error('__preview__')
    })
    log('Applied.')
  } catch (e) {
    if (e instanceof Error && e.message === '__preview__') log('Preview only. Nothing written.')
    else throw e
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
