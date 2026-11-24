// Catalogue version (24 Nov 2026): the Orders screens keep the article + retailer list in the
// browser, so it is not downloaded on every visit. Every change to that list (articles, colours,
// sizes, retailers) gives it a new version in the same transaction. The screen reads only the
// version (1 tiny query) and downloads the list again only when it changed. Server only.
//
// Stored in app_settings (migration 0009): no schema change. Not audited: it marks a change that
// already has its own audit row.

import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'

export const CATALOGUE_VERSION_KEY = 'catalogue.version'

/** 1 query (primary key). '0' until the first change. */
export async function getCatalogueVersion(db: DbOrTx): Promise<string> {
  const r = await db.execute<{ v: string }>(sql`SELECT value #>> '{}' AS v FROM app_settings WHERE key = ${CATALOGUE_VERSION_KEY}`)
  return r.rows[0]?.v ?? '0'
}

/**
 * 1 statement. Call inside the transaction that changes the catalogue, near its end (the row stays
 * locked until commit, so two saves at once simply take turns).
 */
export async function bumpCatalogueVersion(db: DbOrTx): Promise<void> {
  await db.execute(sql`
    INSERT INTO app_settings (key, value, "updatedByName", "updatedAt")
    VALUES (${CATALOGUE_VERSION_KEY}, to_jsonb(gen_random_uuid()::text), 'system', now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = now()`)
}
