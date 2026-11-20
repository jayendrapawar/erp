'use server'

// Article photos (retailer shop, owner 21 Nov 2026). Files live in Vercel Blob; rows in article_photos.
// The main photo is the one with the lowest sortOrder.

import { and, asc, eq, sql } from 'drizzle-orm'
import { del } from '@vercel/blob'
import { db } from '@/lib/db'
import { articlePhotos, articles } from '@/lib/db/schema'
import { requirePermission } from '@/lib/authz'
import { audit } from '@/lib/audit'
import { PHOTO_MAX_BYTES, PHOTO_MONTHLY_UPLOAD_LIMIT, isArticlePhotoPath, isBlobUrl } from '@/lib/photos/limits'
import { photoUploadsThisMonth } from '@/lib/photos/uploads-this-month'
import { revalidateShopCatalogue } from '@/lib/shop/cache'

export interface ArticlePhotoItem { id: number; url: string; width: number | null; height: number | null; bytes: number | null }
export interface ArticlePhotoList { photos: ArticlePhotoItem[]; uploadsThisMonth: number; monthlyLimit: number; storeReady: boolean }

/** Photo count per article (Master → Articles list). 1 query. */
export async function getArticlePhotoCounts(): Promise<Record<number, number>> {
  await requirePermission('articles.view')
  const rows = await db.select({ articleId: articlePhotos.articleId, n: sql<number>`count(*)::int` })
    .from(articlePhotos).groupBy(articlePhotos.articleId)
  return Object.fromEntries(rows.map((r) => [r.articleId, Number(r.n)]))
}

/** Photos of one article colour, main first, plus this month's upload count. 2 queries in parallel. */
export async function getArticlePhotos(articleId: number): Promise<ArticlePhotoList> {
  await requirePermission('articles.view')
  const [photos, used] = await Promise.all([
    db.select({ id: articlePhotos.id, url: articlePhotos.url, width: articlePhotos.width, height: articlePhotos.height, bytes: articlePhotos.bytes })
      .from(articlePhotos).where(eq(articlePhotos.articleId, articleId)).orderBy(asc(articlePhotos.sortOrder), asc(articlePhotos.id)),
    photoUploadsThisMonth(db),
  ])
  return { photos, uploadsThisMonth: used, monthlyLimit: PHOTO_MONTHLY_UPLOAD_LIMIT, storeReady: Boolean(process.env.BLOB_READ_WRITE_TOKEN) }
}

/** Save the link of a photo the browser just uploaded to Blob. Added last (not main) unless it is the first. 1 transaction. */
export async function addArticlePhoto(input: { articleId: number; url: string; pathname: string; width?: number; height?: number; bytes?: number }): Promise<ArticlePhotoList> {
  const u = await requirePermission('articles.edit')
  const articleId = Number(input.articleId)
  if (!isBlobUrl(input.url) || !isArticlePhotoPath(input.pathname, articleId)) throw new Error('This photo link was not made by the photo upload.')
  const int = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null)
  await db.transaction(async (tx) => {
    const [art] = await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, articleId)).limit(1)
    if (!art) throw new Error('Article not found.')
    const [row] = await tx.insert(articlePhotos).values({
      articleId, url: input.url, pathname: input.pathname,
      width: int(input.width), height: int(input.height), bytes: Math.min(int(input.bytes) ?? 0, PHOTO_MAX_BYTES) || null,
      sortOrder: sql`(SELECT coalesce(max("sortOrder") + 1, 0) FROM article_photos WHERE "articleId" = ${articleId})`,
      createdBy: u.id,
    }).onConflictDoNothing().returning({ id: articlePhotos.id })
    if (row) await audit(tx, { actor: { id: u.id, name: u.name }, action: 'article_photo.added', entityType: 'article', entityId: articleId, after: { photoId: row.id, url: input.url } })
  })
  revalidateShopCatalogue()
  return getArticlePhotos(articleId)
}

/** Make a photo the main one (shown in the shop list). 1 update. */
export async function makeMainArticlePhoto(photoId: number): Promise<ArticlePhotoList> {
  const u = await requirePermission('articles.edit')
  const [row] = await db.update(articlePhotos)
    .set({ sortOrder: sql`(SELECT min(p."sortOrder") - 1 FROM article_photos p WHERE p."articleId" = ${articlePhotos.articleId})` })
    .where(eq(articlePhotos.id, photoId)).returning({ articleId: articlePhotos.articleId })
  if (!row) throw new Error('Photo not found.')
  await audit(db, { actor: { id: u.id, name: u.name }, action: 'article_photo.made_main', entityType: 'article', entityId: row.articleId, after: { photoId } })
  revalidateShopCatalogue()
  return getArticlePhotos(row.articleId)
}

/** Delete a photo: the row (with its audit row), then the file in Blob. */
export async function deleteArticlePhoto(photoId: number): Promise<ArticlePhotoList> {
  const u = await requirePermission('articles.edit')
  const row = await db.transaction(async (tx) => {
    const [r] = await tx.delete(articlePhotos).where(and(eq(articlePhotos.id, photoId)))
      .returning({ articleId: articlePhotos.articleId, url: articlePhotos.url })
    if (!r) throw new Error('Photo not found.')
    await audit(tx, { actor: { id: u.id, name: u.name }, action: 'article_photo.deleted', entityType: 'article', entityId: r.articleId, before: { photoId, url: r.url } })
    return r
  })
  // The link is already gone from the shop; a file left behind only takes storage.
  try { await del(row.url) } catch (e) { console.error('[article-photos] Blob delete failed', row.url, e) }
  revalidateShopCatalogue()
  return getArticlePhotos(row.articleId)
}
