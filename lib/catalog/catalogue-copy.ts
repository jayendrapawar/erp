// The browser's saved copy of the Orders catalogue (lib/use-catalogue-cache.ts). Pure, client-safe.

import type { CatalogueData } from '@/app/actions/catalogue'

export interface SavedCatalogue {
  version: string
  /** When this copy was downloaded (ms). */
  savedAt: number
  data: CatalogueData
}

/**
 * Safety net only: changes made in the app always change the version (lib/catalog/version.ts),
 * scripts that use lib/catalog too. A copy is downloaded again after this long anyway, in case the
 * catalogue was changed some other way (hand-written SQL).
 */
export const MAX_COPY_AGE_MS = 12 * 60 * 60 * 1000

/** Download the catalogue again? `version` is the current one from the server (undefined = not known). */
export function needsDownload(saved: SavedCatalogue | null, version: string | undefined, now: number): boolean {
  if (!saved) return true
  if (version !== undefined && saved.version !== version) return true
  return now - saved.savedAt >= MAX_COPY_AGE_MS
}

/** A saved copy or downloaded body that has the expected shape, else null (old format, corrupt). */
export function asSavedCatalogue(x: unknown): SavedCatalogue | null {
  if (!x || typeof x !== 'object') return null
  const s = x as Partial<SavedCatalogue>
  if (typeof s.version !== 'string' || typeof s.savedAt !== 'number' || !isCatalogue(s.data)) return null
  return s as SavedCatalogue
}

export function isCatalogue(x: unknown): x is CatalogueData {
  if (!x || typeof x !== 'object') return false
  const c = x as Partial<CatalogueData>
  return typeof c.version === 'string' && Array.isArray(c.vendors) && Array.isArray(c.articles)
}
