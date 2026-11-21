// Small secrets kept in the database (e.g. the Gmail app password for sending bills), encrypted with
// AES-256-GCM. The key is derived from BETTER_AUTH_SECRET (already set on Vercel and in .env.local),
// so no new environment variable is needed. Server only. Never log the plain value.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

function key(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set.')
  return Buffer.from(hkdfSync('sha256', secret, 'shayona.secret-box', 'app-settings-v1', 32))
}

/** "v1:<iv>:<tag>:<data>" (base64url). */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join(':')
}

/** Null when the value cannot be opened (other key, damaged). */
export function openSecret(sealed: string): string | null {
  try {
    const [v, iv, tag, data] = sealed.split(':')
    if (v !== 'v1' || !iv || !tag || !data) return null
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
  } catch {
    return null
  }
}
