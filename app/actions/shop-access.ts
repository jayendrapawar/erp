'use server'

// Master → Retailers → Shop access (owner, 21 Nov 2026): staff switch a retailer's shop on, set the
// phone they sign in with and a PIN. A new PIN signs out the retailer's old sessions. The PIN is
// never stored or logged in plain form. 1 transaction (read, write, audit).

import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { retailers } from '@/lib/db/schema'
import { requirePermission } from '@/lib/authz'
import { audit } from '@/lib/audit'
import { checkPin, hashPin, normalizeShopPhone } from '@/lib/shop/auth'
import { retailerColumns } from '@/lib/retailer-columns'
import type { Vendor } from './vendors'

export async function setShopAccess(input: { retailerId: string; phone: string; pin: string; enabled: boolean }): Promise<Vendor> {
  const u = await requirePermission('retailers.edit')
  const phone = input.phone.trim() ? normalizeShopPhone(input.phone) : ''
  if (phone === null) throw new Error('Enter a 10-digit mobile number (it is what the retailer signs in with).')
  const pin = input.pin.trim()
  if (pin) { const bad = checkPin(pin); if (bad) throw new Error(bad) }
  const pinHash = pin ? await hashPin(pin) : null

  await db.transaction(async (tx) => {
    const [before] = await tx.select({ shopPhone: retailers.shopPhone, shopEnabled: retailers.shopEnabled, hasPin: sql<boolean>`"shopPinHash" <> ''` })
      .from(retailers).where(eq(retailers.id, input.retailerId)).for('update')
    if (!before) throw new Error('Retailer not found.')
    if (input.enabled && !phone) throw new Error('Enter the mobile number before switching the shop on.')
    if (input.enabled && !pinHash && !before.hasPin) throw new Error('Set a PIN before switching the shop on.')
    if (phone) {
      const [other] = await tx.select({ name: retailers.partyName }).from(retailers)
        .where(sql`${retailers.shopPhone} = ${phone} AND ${retailers.id} <> ${input.retailerId}`).limit(1)
      if (other) throw new Error(`This mobile number already signs in for ${other.name}.`)
    }
    await tx.update(retailers).set({
      shopPhone: phone,
      shopEnabled: input.enabled,
      ...(pinHash ? { shopPinHash: pinHash, shopPinSetAt: sql`now()`, shopFailedPins: 0, shopLockedUntil: null } : {}),
      updatedAt: sql`now()`,
    }).where(eq(retailers.id, input.retailerId))
    await audit(tx, {
      actor: { id: u.id, name: u.name }, action: 'retailer.shop_access', entityType: 'retailer', entityId: input.retailerId,
      before: { shopPhone: before.shopPhone, shopEnabled: before.shopEnabled },
      after: { shopPhone: phone, shopEnabled: input.enabled, pin: pinHash ? '(new, hidden)' : '(unchanged)' },
    })
  })
  const [row] = await db.select(retailerColumns).from(retailers).where(eq(retailers.id, input.retailerId))
  return row
}
