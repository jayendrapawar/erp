import { NextResponse } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { AuthError, requirePermission } from '@/lib/authz'
import { db } from '@/lib/db'
import { PHOTO_CONTENT_TYPES, PHOTO_MAX_BYTES, PHOTO_MONTHLY_UPLOAD_LIMIT, isArticlePhotoPath } from '@/lib/photos/limits'
import { photoUploadsThisMonth } from '@/lib/photos/uploads-this-month'

// POST /api/article-photos/upload — hands the browser a short-lived token to upload ONE article photo
// straight to Vercel Blob (the file never passes through this function: no function time or
// transfer for the image). The link is saved afterwards by addArticlePhoto (app/actions/article-photos).
// Checks: articles.edit permission, path articles/<id>/…, WebP/JPEG only, ≤ 2 MB, monthly budget.
// Queries: session (1) + uploads this month (1).
export async function POST(request: Request): Promise<NextResponse> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'The photo store is not set up yet (Vercel Blob).' }, { status: 503 })
  }
  try {
    const body = (await request.json()) as HandleUploadBody
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        await requirePermission('articles.edit')
        const articleId = Number(JSON.parse(clientPayload ?? '{}').articleId)
        if (!Number.isInteger(articleId) || articleId <= 0 || !isArticlePhotoPath(pathname, articleId)) {
          throw new Error('Wrong photo path.')
        }
        if (await photoUploadsThisMonth(db) >= PHOTO_MONTHLY_UPLOAD_LIMIT) {
          throw new Error(`This month's photo uploads (${PHOTO_MONTHLY_UPLOAD_LIMIT}) are used up. Uploads open again on the 1st.`)
        }
        return {
          allowedContentTypes: PHOTO_CONTENT_TYPES,
          maximumSizeInBytes: PHOTO_MAX_BYTES,
          addRandomSuffix: true,
          cacheControlMaxAge: 60 * 60 * 24 * 365, // links never change (random suffix): cache for a year
        }
      },
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 403 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload failed' }, { status: 400 })
  }
}
