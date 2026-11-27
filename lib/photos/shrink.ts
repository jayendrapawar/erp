// Browser only: shrink a photo before upload (longest side PHOTO_MAX_SIDE, WebP, JPEG where the
// browser cannot write WebP). A 4–8 MB phone photo becomes ~60–120 KB.

import { PHOTO_MAX_BYTES, PHOTO_MAX_SIDE } from './limits'

export interface ShrunkPhoto { blob: Blob; width: number; height: number; ext: 'webp' | 'jpg' }

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export async function shrinkPhoto(file: File, maxSide = PHOTO_MAX_SIDE): Promise<ShrunkPhoto> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not a photo.`)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error(`${file.name} could not be opened (use JPG, PNG or WebP).`)
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot shrink photos.')
  ctx.fillStyle = '#fff' // transparent PNGs get a white background, not black
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  for (const q of [0.8, 0.65, 0.5]) {
    const webp = await toBlob(canvas, 'image/webp', q)
    const blob = webp?.type === 'image/webp' ? webp : await toBlob(canvas, 'image/jpeg', q)
    if (!blob) break
    if (blob.size <= PHOTO_MAX_BYTES) return { blob, width, height, ext: blob.type === 'image/webp' ? 'webp' : 'jpg' }
  }
  throw new Error(`${file.name} is too large even after shrinking.`)
}
