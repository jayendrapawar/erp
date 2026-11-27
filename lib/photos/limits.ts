/**
 * Vercel Blob on the Hobby plan (checked 21 Nov 2026): 1 GB storage, 10 GB transfer and 2,000
 * uploads ("advanced operations") a month. Going over blocks the store for 30 days, so uploads stop
 * a little before the limit. One file per photo (no separate thumbnail) halves the upload count.
 */
export const PHOTO_MONTHLY_UPLOAD_LIMIT = 1800
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024
export const PHOTO_CONTENT_TYPES = ['image/webp', 'image/jpeg']
/** Longest side after shrinking on the phone / laptop before upload. */
export const PHOTO_MAX_SIDE = 1000

/** Blob path of an article photo: articles/<article id>/<anything>.webp|jpg */
export function isArticlePhotoPath(pathname: string, articleId: number): boolean {
  return new RegExp(`^articles/${articleId}/[A-Za-z0-9._-]+\\.(webp|jpe?g)$`).test(pathname)
}

/** Only links to a public Vercel Blob store are saved. */
export function isBlobUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.endsWith('.public.blob.vercel-storage.com')
  } catch {
    return false
  }
}
