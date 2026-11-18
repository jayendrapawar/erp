'use server'

import { asc, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { suppliers } from '@/lib/db/schema'
import { requirePermission } from '@/lib/authz'
import { audit } from '@/lib/audit'

// Supplier master: the companies we BUY from (Relaxo divisions etc.). Retailers live in
// `retailers`. Phase 2 (vendor ledger) extends this table; keep it the single source.

export type Supplier = typeof suppliers.$inferSelect
export type SupplierInput = Omit<Supplier, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }

export async function getSuppliers(): Promise<Supplier[]> {
  await requirePermission('suppliers.view')
  return db.select().from(suppliers).orderBy(asc(suppliers.name))
}

export async function saveSupplier(input: SupplierInput): Promise<Supplier[]> {
  const u = await requirePermission('suppliers.edit')
  const clean = {
    name: input.name.trim(),
    contactPerson: input.contactPerson.trim(),
    phone: input.phone.trim(),
    email: input.email.trim(),
    gst: input.gst.trim().toUpperCase(),
    address: input.address.trim(),
    city: input.city.trim(),
    divisions: [...new Set(input.divisions.map((d) => d.trim()).filter(Boolean))],
    paymentTermsDays: input.paymentTermsDays == null || Number.isNaN(input.paymentTermsDays) ? null : Math.max(0, Math.round(input.paymentTermsDays)),
    notes: input.notes.trim(),
    status: input.status === 'inactive' ? 'inactive' as const : 'active' as const,
  }
  if (!clean.name) throw new Error('Supplier name is required.')
  if (clean.gst && !/^[0-9A-Z]{15}$/.test(clean.gst)) throw new Error('GSTIN must be 15 letters and digits.')
  try {
    await db.transaction(async (tx) => {
      if (input.id) {
        const [before] = await tx.select().from(suppliers).where(eq(suppliers.id, input.id)).for('update')
        if (!before) throw new Error('Supplier not found.')
        await tx.update(suppliers).set({ ...clean, updatedAt: sql`now()` }).where(eq(suppliers.id, input.id))
        await audit(tx, { actor: { id: u.id, name: u.name }, action: 'supplier.updated', entityType: 'supplier', entityId: input.id, before, after: clean })
      } else {
        const [row] = await tx.insert(suppliers).values(clean).returning({ id: suppliers.id })
        await audit(tx, { actor: { id: u.id, name: u.name }, action: 'supplier.created', entityType: 'supplier', entityId: row.id, after: clean })
      }
    })
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code
    if (code === '23505') throw new Error('A supplier with this name already exists.')
    throw e
  }
  revalidatePath('/master')
  return db.select().from(suppliers).orderBy(asc(suppliers.name))
}
