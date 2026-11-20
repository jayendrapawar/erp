import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isArticlePhotoPath, isBlobUrl } from '../../lib/photos/limits'

test('only article photo paths of the same article are accepted', () => {
  assert.ok(isArticlePhotoPath('articles/42/SS0101G-CLCL-a1B2c3.webp', 42))
  assert.ok(isArticlePhotoPath('articles/42/x.jpg', 42))
  assert.ok(!isArticlePhotoPath('articles/43/x.webp', 42))       // another article
  assert.ok(!isArticlePhotoPath('articles/42/../1/x.webp', 42))  // no path tricks
  assert.ok(!isArticlePhotoPath('articles/42/x.svg', 42))        // photos only
  assert.ok(!isArticlePhotoPath('bills/42/x.webp', 42))
})

test('only public Vercel Blob links are saved', () => {
  assert.ok(isBlobUrl('https://abc123.public.blob.vercel-storage.com/articles/42/x.webp'))
  assert.ok(!isBlobUrl('http://abc123.public.blob.vercel-storage.com/articles/42/x.webp'))
  assert.ok(!isBlobUrl('https://evil.example.com/abc.public.blob.vercel-storage.com/x.webp'))
  assert.ok(!isBlobUrl('javascript:alert(1)'))
})
