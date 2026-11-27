// Order numbers: short running numbers ORD-1, ORD-2 … (owner, 24 Nov 2026; before: ORD-20261123-QCB3JJ).
// One counter for every kind of order (staff, retailer shop, direct bill), kept in document_sequences
// (migration 0016) under the name 'order'. Taken inside the caller's transaction with one statement:
// the first order creates the counter, every later one adds 1 under a row lock — no two orders get
// the same number, and a failed save gives its number back (no gaps). Earlier orders keep theirs
// (the old format can never equal a new one).

import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'

export const ORDER_SERIES = 'order'

export async function nextOrderNumber(tx: DbOrTx): Promise<string> {
  const r = await tx.execute<{ prefix: string; n: number }>(sql`
    INSERT INTO document_sequences (name, prefix, next, padding, "updatedByName") VALUES (${ORDER_SERIES}, 'ORD-', 2, 0, 'first order')
    ON CONFLICT (name) DO UPDATE SET next = document_sequences.next + 1
    RETURNING prefix, next - 1 AS n`)
  const row = r.rows[0]
  return `${row.prefix}${Number(row.n)}`
}
