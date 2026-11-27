// Retailer shop catalogue (owner, 21 Nov 2026): article colours that have a photo, with photos, sizes,
// segment / division and the LATEST MRP (newest manufacture month, then most recently seen); plus
// Master sets and carton assortments for the "set" and "carton" buttons. Reference data: cached
// (tag SHOP_CATALOGUE_TAG, invalidated by photo / article / set / assortment changes; at most 30 min
// old otherwise — a brand-new MRP shows within 30 min). Building it: 3 queries in parallel.
// Server only.

import { unstable_cache } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { SHOP_CATALOGUE_TAG } from './cache'

export interface ShopItem {
  id: number           // articles.id (one article code + colour)
  name: string         // artName, e.g. SS-101
  code: string         // artCode
  color: string
  colorCode: string
  segment: string | null
  division: string | null
  mrp: number | null   // latest MRP
  photos: string[]     // main first
  sizes: string[]      // in size order
}
export interface ShopSet { id: number; name: string; quantities: Record<string, number> }
export interface ShopCarton { id: number; division: string; segment: string; pairs: number; code: string; onlyFor: string; sizes: Array<{ size: string; pairs: number }> }
export interface ShopCatalogue { items: ShopItem[]; sets: ShopSet[]; cartons: ShopCarton[]; builtAt: string }

async function build(): Promise<ShopCatalogue> {
  const [items, sets, cartons] = await Promise.all([
    db.execute<{ id: number; name: string; code: string; color: string; colorCode: string; segment: string | null; division: string | null; mrp: string | null; photos: string[]; sizes: string[] | null }>(sql`
      SELECT a.id, a."artName" AS name, a."artCode" AS code, a.color, a."colorCode", a.segment, a.division,
             (SELECT m.mrp FROM article_mrps m WHERE m."artCode" = upper(btrim(a."artCode"))
               ORDER BY m."mfgYm" DESC NULLS LAST, m."lastSeenAt" DESC NULLS LAST, m.mrp DESC LIMIT 1) AS mrp,
             (SELECT json_agg(p.url ORDER BY p."sortOrder", p.id) FROM article_photos p WHERE p."articleId" = a.id) AS photos,
             (SELECT json_agg(s."sizeLabel" ORDER BY s."sortOrder") FROM article_sizes s WHERE s."articleId" = a.id AND s.active) AS sizes
      FROM articles a
      WHERE a.active AND EXISTS (SELECT 1 FROM article_photos p WHERE p."articleId" = a.id)
      ORDER BY a."artName", a."artCode", a.color`),
    db.execute<{ id: number; name: string; quantities: Record<string, number> }>(sql`SELECT id, name, quantities FROM order_sets ORDER BY name`),
    db.execute<{ id: number; division: string; segment: string; packing: number; code: string; onlyFor: string; sizes: Array<{ size: string; pairs: number }> }>(sql`
      SELECT id, division, segment, packing, code, "onlyFor", sizes FROM carton_assortments WHERE active ORDER BY division, segment, packing, code`),
  ])
  return {
    items: items.rows.map((r) => ({
      id: r.id, name: r.name, code: r.code, color: r.color, colorCode: r.colorCode, segment: r.segment, division: r.division,
      mrp: r.mrp == null ? null : Number(r.mrp), photos: r.photos ?? [], sizes: r.sizes ?? [],
    })),
    sets: sets.rows.map((s) => ({ id: s.id, name: s.name, quantities: s.quantities ?? {} })),
    cartons: cartons.rows.map((c) => ({ id: c.id, division: c.division, segment: c.segment, pairs: c.packing, code: c.code, onlyFor: c.onlyFor, sizes: c.sizes })),
    builtAt: new Date().toISOString(),
  }
}

export const getShopCatalogue = unstable_cache(build, ['shop-catalogue-v1'], { tags: [SHOP_CATALOGUE_TAG], revalidate: 1800 })
