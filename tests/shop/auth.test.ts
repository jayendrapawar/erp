import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.BETTER_AUTH_SECRET ||= 'test-secret-for-shop-auth-only'

test('mobile number: +91 / spaces / leading 0 ignored; must be an Indian mobile', async () => {
  const { normalizeShopPhone } = await import('../../lib/shop/auth')
  assert.equal(normalizeShopPhone('+91 98250 00000'), '9825000000')
  assert.equal(normalizeShopPhone('09825000000'), '9825000000')
  assert.equal(normalizeShopPhone('98250-00000'), '9825000000')
  assert.equal(normalizeShopPhone('1234567890'), null)
  assert.equal(normalizeShopPhone('98250'), null)
})

test('PIN rules: 4–6 digits, no repeats, no simple runs', async () => {
  const { checkPin } = await import('../../lib/shop/auth')
  assert.equal(checkPin('482915'), null)
  assert.equal(checkPin('7391'), null)
  assert.ok(checkPin('123'))
  assert.ok(checkPin('1111'))
  assert.ok(checkPin('1234'))
  assert.ok(checkPin('654321'))
  assert.ok(checkPin('12a4'))
})

test('PIN hash: right PIN passes, wrong PIN fails, the PIN is not in the hash', async () => {
  const { hashPin, verifyPin } = await import('../../lib/shop/auth')
  const h = await hashPin('482915')
  assert.ok(h.startsWith('scrypt$') && !h.includes('482915'))
  assert.equal(await verifyPin('482915', h), true)
  assert.equal(await verifyPin('482916', h), false)
  assert.notEqual(await hashPin('482915'), h) // salted
})

test('session cookie: signed, expires, cannot be edited', async () => {
  const { encodeSession, decodeSession } = await import('../../lib/shop/auth')
  const now = Date.now()
  const v = encodeSession({ retailerId: 'V001', name: 'Om Shoes', pinSetAt: 5, expires: now + 1000 })
  assert.equal(decodeSession(v, now)?.retailerId, 'V001')
  assert.equal(decodeSession(v, now + 2000), null)                       // expired
  const [body, sig] = v.split('.')
  const forged = Buffer.from(JSON.stringify({ retailerId: 'V002', name: 'x', pinSetAt: 5, expires: now + 1000 })).toString('base64url')
  assert.equal(decodeSession(`${forged}.${sig}`, now), null)              // other retailer, old signature
  assert.equal(decodeSession(`${body}.${sig.slice(0, -2)}xx`, now), null)  // damaged signature
  assert.equal(decodeSession(undefined), null)
})
