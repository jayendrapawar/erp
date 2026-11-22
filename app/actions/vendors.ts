'use server'

// Retailer master (parties we sell to). Kept at this path because many screens import it;
// the table itself is `retailers` since migration 0002.
import { parseEmailList } from '@/lib/email-address'
import { db } from '@/lib/db'
import { retailers as vendors } from '@/lib/db/schema'
import { eq, asc, ilike, or, sql } from 'drizzle-orm'
import { requirePermission } from '@/lib/authz'
import { audit } from '@/lib/audit'
import { fuzzyScore } from '@/lib/fuzzy'
import { retailerColumns } from '@/lib/retailer-columns'

/** A retailer as pages see it: never the shop PIN hash (migration 0015). */
// Credit terms / bill type (migration 0017) join the master screen in the payments step; until then
// they are not part of what the retailer screens load.
export type Vendor = Omit<typeof vendors.$inferSelect, 'shopPinHash' | 'taxType' | 'creditLimitPaise' | 'creditDays' | 'earlyPayDiscountBp' | 'earlyPayDays'>
/** Fields the Retailers form saves; shop sign-in fields change only through the shop-access screen. */
type VendorFields = Pick<Vendor, 'partyName' | 'gst' | 'phone' | 'email' | 'address' | 'city' | 'area' | 'day' | 'salesman' | 'status'>

// ── Generate next ID (V001, V002, …) ─────────────────────────────────────────
async function genId(): Promise<string> {
  const [row] = await db
    .select({ id: vendors.id })
    .from(vendors)
    .orderBy(sql`CAST(SUBSTRING(id, 2) AS INTEGER) DESC`)
    .limit(1)
  if (!row) return 'V001'
  const num = parseInt(row.id.replace('V', ''), 10)
  return `V${String(num + 1).padStart(3, '0')}`
}

// ── Bulk import vendors from parsed CSV rows ──────────────────────────────────
export async function importVendors(
  rows: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>[]
): Promise<{ imported: number; skipped: number; list: Vendor[] }> {
  const u = await requirePermission('retailers.edit')

  // Load existing partyNames (lowercase) to deduplicate
  const existing = await db.select({ partyName: vendors.partyName }).from(vendors)
  const existingNames = new Set(existing.map(v => v.partyName.toLowerCase().trim()))

  // Filter out rows whose partyName already exists
  const newRows = rows.filter(r => !existingNames.has(r.partyName.toLowerCase().trim()))
  const skipped = rows.length - newRows.length

  if (newRows.length > 0) {
    // Get current highest ID for sequential assignment
    const [last] = await db
      .select({ id: vendors.id })
      .from(vendors)
      .orderBy(sql`CAST(SUBSTRING(id, 2) AS INTEGER) DESC`)
      .limit(1)

    let next = last ? parseInt(last.id.replace('V', ''), 10) + 1 : 1

    await db.transaction(async (tx) => {
      const values = newRows.map((row) => ({ ...row, id: `V${String(next++).padStart(3, '0')}` }))
      for (let i = 0; i < values.length; i += 500) await tx.insert(vendors).values(values.slice(i, i + 500))
      await audit(tx, { actor: { id: u.id, name: u.name }, action: 'retailer.imported', entityType: 'retailer_import', entityId: new Date().toISOString(), after: { rows: rows.length, imported: newRows.length } })
    })
  }

  const list = await db.select(retailerColumns).from(vendors).orderBy(asc(vendors.partyName))
  return { imported: newRows.length, skipped, list }
}

// ── Fetch all vendors ─────────────────────────────────────────────────────────
export async function getVendors(): Promise<Vendor[]> {
  await requirePermission('retailers.view')
  return db.select(retailerColumns).from(vendors).orderBy(asc(vendors.partyName))
}

// ── Save (upsert) a single vendor ─────────────────────────────────────────────
export async function saveVendor(
  raw: VendorFields & { id?: string }
): Promise<Vendor[]> {
  const u = await requirePermission('retailers.edit')
  // One or more addresses for emailed bills (comma separated); '' = none.
  const { ok, bad } = parseEmailList(raw.email ?? '')
  if (bad.length) throw new Error(`Not an email address: ${bad.join(', ')}`)
  // Only the form's fields are written, whatever else the page sends.
  const input: VendorFields & { id?: string } = {
    id: raw.id, partyName: raw.partyName, gst: raw.gst, phone: raw.phone, email: ok.join(', '), address: raw.address,
    city: raw.city, area: raw.area, day: raw.day, salesman: raw.salesman, status: raw.status,
  }
  const id = input.id || (await genId())
  const [before] = input.id ? await db.select(retailerColumns).from(vendors).where(eq(vendors.id, input.id)).limit(1) : []
  await db
    .insert(vendors)
    .values({ ...input, id })
    .onConflictDoUpdate({
      target: vendors.id,
      set: {
        partyName:  input.partyName,
        gst:        input.gst,
        phone:      input.phone,
        email:      input.email,
        address:    input.address,
        city:       input.city,
        area:       input.area,
        day:        input.day,
        salesman:   input.salesman,
        status:     input.status,
        updatedAt:  sql`now()`,
      },
    })
  await audit(db, { actor: { id: u.id, name: u.name }, action: before ? 'retailer.updated' : 'retailer.created', entityType: 'retailer', entityId: id, before: before ?? undefined, after: input })
  return db.select(retailerColumns).from(vendors).orderBy(asc(vendors.partyName))
}

// ── Search vendors (used by salesman dashboard) ───────────────────────────────
export async function searchVendors(query: string): Promise<Vendor[]> {
  await requirePermission('retailers.view')
  const q = query.trim()

  if (!q) {
    return db.select(retailerColumns).from(vendors).where(eq(vendors.status, 'active')).orderBy(asc(vendors.partyName)).limit(20)
  }

  // Broad DB fetch — pull any row that substring-matches on key fields
  const rows = await db
    .select(retailerColumns)
    .from(vendors)
    .where(
      or(
        ilike(vendors.partyName, `%${q}%`),
        ilike(vendors.area, `%${q}%`),
        ilike(vendors.city, `%${q}%`),
        ilike(vendors.phone, `%${q}%`),
      )
    )
    .orderBy(asc(vendors.partyName))
    .limit(100)

  // Also fetch a wider set for fuzzy (typo tolerance) — up to 200 active vendors
  const wider = await db
    .select(retailerColumns)
    .from(vendors)
    .where(eq(vendors.status, 'active'))
    .orderBy(asc(vendors.partyName))
    .limit(200)

  // Merge: start with broader set, score every row, keep top matches
  const seen = new Set<string>()
  const candidates = [...rows, ...wider].filter(v => {
    if (seen.has(v.id)) return false
    seen.add(v.id)
    return true
  })

  const scored = candidates
    .map(v => ({
      v,
      score: Math.min(
        fuzzyScore(v.partyName, q),
        fuzzyScore(v.area ?? '', q),
        fuzzyScore(v.city ?? '', q),
        fuzzyScore(v.phone ?? '', q),
      ),
    }))
    .filter(x => x.score < Infinity)
    .sort((a, b) => a.score !== b.score ? a.score - b.score : a.v.partyName.localeCompare(b.v.partyName))

  return scored.slice(0, 20).map(x => x.v)
}
