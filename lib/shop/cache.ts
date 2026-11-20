import { revalidateTag } from 'next/cache'

/**
 * The retailer shop catalogue (article colours with photos + latest MRP) is reference data, so it
 * is cached (AGENTS.md: cache reference data with clear invalidation). Anything that changes what
 * the shop shows — photos, article master edits, a new MRP — calls this.
 */
export const SHOP_CATALOGUE_TAG = 'shop-catalogue'

export function revalidateShopCatalogue(): void {
  try {
    revalidateTag(SHOP_CATALOGUE_TAG, 'max')
  } catch {
    // Outside a request (scripts, tests): nothing is cached there.
  }
}
