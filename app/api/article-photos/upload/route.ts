import { NextResponse } from 'next/server'
import { handleUploadPresigned, type HandleUploadPresignedBody } from '@vercel/blob/client'
import { issueSignedToken } from '@vercel/blob'
import { AuthError, requirePermission } from '@/lib/authz'
import { db } from '@/lib/db'
import { blobAuth, blobStoreReady } from '@/lib/photos/store'
import { PHOTO_CONTENT_TYPES, PHOTO_MAX_BYTES, PHOTO_MONTHLY_UPLOAD_LIMIT, isArticlePhotoPath } from '@/lib/photos/limits'
import { photoUploadsThisMonth } from '@/lib/photos/uploads-this-month'

// POST /api/article-photos/upload — hands the browser a short-lived presigned URL to upload ONE
// article photo straight to Vercel Blob (the file never passes through this function).
// Credentials: on Vercel the store is connected by OIDC (BLOB_STORE_ID, no long-lived secret);
// locally BLOB_READ_WRITE_TOKEN in .env.local. The link is saved afterwards by addArticlePhoto.
// Checks: articles.edit permission, path articles/<id>/…, WebP/JPEG only, ≤ 2 MB, monthly budget.
// Queries: session (1) + uploads this month (1).
export async function POST(request: Request): Promise<NextResponse> {
  if (!blobStoreReady()) {
    return NextResponse.json({ error: 'The photo store is not set up yet (Vercel Blob).' }, { status: 503 })
  }
  try {
    const body = (await request.json()) as HandleUploadPresignedBody
    // Only upload URLs are handed out here; no upload-completed callbacks are used.
    if (body?.type !== 'blob.generate-presigned-url') return NextResponse.json({ error: 'Not supported' }, { status: 400 })
    const result = await handleUploadPresigned({
      body,
      request,
      // Required by the library; only used to verify upload-completed callbacks, which are refused above.
      webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || 'unused',
      getSignedToken: async (pathname, clientPayload) => {
        await requirePermission('articles.edit')
        const articleId = Number(JSON.parse(clientPayload ?? '{}').articleId)
        if (!Number.isInteger(articleId) || articleId <= 0 || !isArticlePhotoPath(pathname, articleId)) {
          throw new Error('Wrong photo path.')
        }
        if (await photoUploadsThisMonth(db) >= PHOTO_MONTHLY_UPLOAD_LIMIT) {
          throw new Error(`This month's photo uploads (${PHOTO_MONTHLY_UPLOAD_LIMIT}) are used up. Uploads open again on the 1st.`)
        }
        const validUntil = Date.now() + 10 * 60 * 1000
        const token = await issueSignedToken({
          ...blobAuth(), pathname, operations: ['put'], validUntil,
          allowedContentTypes: PHOTO_CONTENT_TYPES, maximumSizeInBytes: PHOTO_MAX_BYTES,
        })
        return {
          token,
          urlOptions: {
            validUntil,
            allowedContentTypes: PHOTO_CONTENT_TYPES,
            maximumSizeInBytes: PHOTO_MAX_BYTES,
            addRandomSuffix: true,
            cacheControlMaxAge: 60 * 60 * 24 * 365, // links never change (random suffix): cache for a year
          },
        }
      },
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    }
    console.error('[article-photos/upload]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload failed' }, { status: 400 })
  }
}
