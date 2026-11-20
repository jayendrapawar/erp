/**
 * Is a Vercel Blob store connected? On Vercel the store is linked by OIDC (BLOB_STORE_ID, no secret);
 * locally by BLOB_READ_WRITE_TOKEN in .env.local. Server only.
 */
export function blobStoreReady(): boolean {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN)
}

/**
 * Credentials for @vercel/blob calls: the read-write token when one is set (local development),
 * otherwise nothing, so the library uses Vercel OIDC (BLOB_STORE_ID) on Vercel. Without this the
 * library tries OIDC first and fails locally ("OIDC … not for the development environment").
 */
export function blobAuth(): { token?: string } {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim()
  return token ? { token } : {}
}
