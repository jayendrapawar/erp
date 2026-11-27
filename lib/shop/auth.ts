// Retailer shop sign-in (owner, 21 Nov 2026): phone + PIN set by staff. Separate from staff sign-in.
// - PIN: scrypt hash in retailers."shopPinHash" (never the PIN, never sent to a page).
// - Session: signed cookie (HMAC-SHA256, key derived from BETTER_AUTH_SECRET), 7 days. Pages trust it
//   without a database query; placing an order re-checks the retailer (still on, same PIN) in its
//   transaction, so switching a retailer off or setting a new PIN stops orders at once.
// Server only.

import { createHmac, hkdfSync, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { cookies } from 'next/headers'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>

export const SHOP_COOKIE = 'shayona_shop'
export const SHOP_SESSION_DAYS = 7
export const PIN_MAX_TRIES = 5
export const PIN_LOCK_MINUTES = 15

export interface ShopSession { retailerId: string; name: string; pinSetAt: number; expires: number }

// ── Phone and PIN rules ──────────────────────────────────────────────────────

/** The 10-digit mobile number a retailer signs in with (+91 / spaces / dashes ignored). */
export function normalizeShopPhone(value: string): string | null {
  const d = value.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(d) ? d : null
}

/** 4–6 digits, not all the same digit, not 1234 / 123456 style runs. */
export function checkPin(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'The PIN must be 4 to 6 digits.'
  if (/^(\d)\1+$/.test(pin)) return 'Choose a PIN that is not one digit repeated.'
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Choose a PIN that is not a simple run like 1234.'
  return null
}

const SCRYPT = { N: 16384, r: 8, p: 1 }

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(pin, salt, 32, SCRYPT)
  return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [kind, n, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  const got = await scrypt(pin, Buffer.from(salt, 'base64url'), expected.length, { ...SCRYPT, N: Number(n) || SCRYPT.N })
  return got.length === expected.length && timingSafeEqual(got, expected)
}

// ── Session cookie ───────────────────────────────────────────────────────────

function sessionKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set.')
  return Buffer.from(hkdfSync('sha256', secret, 'shayona.shop-session', 'v1', 32))
}

export function encodeSession(s: ShopSession): string {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url')
  const sig = createHmac('sha256', sessionKey()).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function decodeSession(value: string | undefined, now = Date.now()): ShopSession | null {
  if (!value) return null
  const [body, sig] = value.split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', sessionKey()).update(body).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ShopSession
    if (typeof s.retailerId !== 'string' || typeof s.expires !== 'number' || s.expires < now) return null
    return s
  } catch {
    return null
  }
}

/** The signed-in retailer from the cookie (no database query), or null. */
export async function getShopSession(): Promise<ShopSession | null> {
  return decodeSession((await cookies()).get(SHOP_COOKIE)?.value)
}

export async function setShopSession(retailerId: string, name: string, pinSetAt: Date | null): Promise<void> {
  const expires = Date.now() + SHOP_SESSION_DAYS * 86_400_000
  ;(await cookies()).set(SHOP_COOKIE, encodeSession({ retailerId, name, pinSetAt: pinSetAt?.getTime() ?? 0, expires }), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SHOP_SESSION_DAYS * 86_400,
  })
}

export async function clearShopSession(): Promise<void> {
  ;(await cookies()).delete(SHOP_COOKIE)
}
