'use client'

// Master → Articles → Photos: photos of one article colour for the retailer shop.
// Photos are shrunk in the browser and uploaded straight to Vercel Blob; then the link is saved.

import { useEffect, useRef, useState } from 'react'
import { uploadPresigned } from '@vercel/blob/client'
import { addArticlePhoto, deleteArticlePhoto, getArticlePhotos, makeMainArticlePhoto, type ArticlePhotoList } from '@/app/actions/article-photos'
import { shrinkPhoto } from '@/lib/photos/shrink'

export interface PhotoArticle { id: number; artName: string; artCode: string; color: string; colorCode: string }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ArticlePhotosDialog({ article, onClose, onCountChange }: {
  article: PhotoArticle
  onClose: () => void
  onCountChange: (articleId: number, count: number) => void
}) {
  const [data, setData] = useState<ArticlePhotoList | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function apply(list: ArticlePhotoList) {
    setData(list)
    onCountChange(article.id, list.photos.length)
  }

  useEffect(() => {
    getArticlePhotos(article.id).then(setData).catch((e) => setError(errMsg(e)))
  }, [article.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function uploadFiles(files: File[]) {
    if (!files.length || !data) return
    const left = data.monthlyLimit - data.uploadsThisMonth
    if (files.length > left) { setError(`Only ${Math.max(0, left)} photo upload(s) left this month.`); return }
    setError(null)
    const failed: string[] = []
    for (let i = 0; i < files.length; i++) {
      setBusy(`Uploading ${i + 1} of ${files.length}…`)
      try {
        const p = await shrinkPhoto(files[i])
        const slug = `${article.artCode}-${article.colorCode || 'colour'}`.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'photo'
        const blob = await uploadPresigned(`articles/${article.id}/${slug}.${p.ext}`, p.blob, {
          access: 'public',
          handleUploadUrl: '/api/article-photos/upload',
          clientPayload: JSON.stringify({ articleId: article.id }),
          contentType: p.blob.type,
        })
        apply(await addArticlePhoto({ articleId: article.id, url: blob.url, pathname: blob.pathname, width: p.width, height: p.height, bytes: p.blob.size }))
      } catch (e) {
        failed.push(`${files[i].name}: ${errMsg(e)}`)
      }
    }
    setBusy(null)
    if (failed.length) setError(failed.join('\n'))
  }

  async function run(label: string, fn: () => Promise<ArticlePhotoList>) {
    setBusy(label); setError(null)
    try { apply(await fn()) } catch (e) { setError(errMsg(e)) } finally { setBusy(null); setConfirmDelete(null) }
  }

  const photos = data?.photos ?? []
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-border bg-background shadow-2xl sm:m-4" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-background px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">Photos · {article.artName}</h3>
            <p className="text-xs text-muted-foreground font-mono truncate">{article.artCode} · {article.color || '—'} {article.colorCode ? `(${article.colorCode})` : ''}</p>
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">Close</button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-xs text-muted-foreground">
            The first photo is the <b>main</b> one in the retailer shop. An article colour shows in the shop once it has a photo.
            Photos are shrunk before upload (about 100 KB each).
          </p>

          {data && !data.storeReady && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              The photo store (Vercel Blob) is not connected yet, so photos cannot be uploaded.
            </p>
          )}
          {error && <p className="whitespace-pre-line rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>}

          {!data && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

          {data && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {photos.map((p, i) => (
                <div key={p.id} className="overflow-hidden rounded-xl border border-border bg-muted/30">
                  <div className="relative aspect-square bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element -- Blob links, already shrunk; no image optimiser */}
                    <img src={p.url} alt={`${article.artName} ${article.color} photo ${i + 1}`} loading="lazy" className="h-full w-full object-contain" />
                    {i === 0 && <span className="absolute left-2 top-2 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-semibold text-background">Main</span>}
                  </div>
                  <div className="flex gap-1.5 p-2">
                    {i > 0 && (
                      <button type="button" disabled={!!busy} onClick={() => run('Saving…', () => makeMainArticlePhoto(p.id))}
                        className="flex-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50">Make main</button>
                    )}
                    {confirmDelete === p.id ? (
                      <button type="button" disabled={!!busy} onClick={() => run('Deleting…', () => deleteArticlePhoto(p.id))}
                        className="flex-1 rounded-md bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50">Sure? Delete</button>
                    ) : (
                      <button type="button" disabled={!!busy} onClick={() => setConfirmDelete(p.id)}
                        className="flex-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50">Delete</button>
                    )}
                  </div>
                </div>
              ))}
              <button type="button" disabled={!!busy || !data.storeReady} onClick={() => fileRef.current?.click()}
                className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border text-sm font-medium text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50">
                <span className="text-2xl leading-none">+</span>
                {busy ?? 'Add photos'}
              </button>
            </div>
          )}

          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
            onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void uploadFiles(f) }} />

          {data && (
            <p className="text-[11px] text-muted-foreground">
              Uploads this month: {data.uploadsThisMonth} of {data.monthlyLimit} (Vercel free limit; uploads stop before it).
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
