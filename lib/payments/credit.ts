// Credit hold (payments steps 7–9; owner, 22 Nov 2026): a party with anything unpaid for longer than
// its credit days (retailers.creditDays; default 90) cannot place a new order or get a Direct bill
// until it pays — an admin can override (audited). The retailer shop is not checked. A credit limit
// (retailers.creditLimitPaise) only warns. Server only.

import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'

export const DEFAULT_CREDIT_DAYS = 90
/** Starts every credit-hold error, so screens can offer the admin override. */
export const CREDIT_HOLD = 'Credit hold:'

export interface CreditStatus {
  retailerId: string
  partyName: string
  creditDays: number
  balancePaise: number
  creditLimitPaise: number | null
  /** Unpaid longer than the credit days, oldest first (up to 5 shown). */
  overdue: Array<{ refNo: string; kind: string; entryDate: string; days: number; openPaise: number }>
  overduePaise: number
  overLimit: boolean
  blocked: boolean
}

/** The party's balance and what is overdue: by retailer id, else exact name. 1 query. */
export async function creditStatus(db: DbOrTx, party: { retailerId?: string | null; name?: string | null }): Promise<CreditStatus | null> {
  const id = String(party.retailerId ?? ''), name = String(party.name ?? '').trim()
  if (!id && !name) return null
  const r = (await db.execute<{
    id: string; partyName: string; days: number; limit: string | null; balance: string; overduePaise: string
    overdue: CreditStatus['overdue'] | null
  }>(sql`
    WITH r AS (
      SELECT id, "partyName", coalesce("creditDays", ${DEFAULT_CREDIT_DAYS}) AS days, "creditLimitPaise" AS lim FROM retailers
      WHERE (${id} <> '' AND id = ${id}) OR (${id} = '' AND lower(btrim("partyName")) = lower(${name}))
      LIMIT 1
    ), o AS (
      SELECT oi."refNo", oi.kind, oi."entryDate", oi."openPaise", (now() AT TIME ZONE 'Asia/Kolkata')::date - oi."entryDate" AS age
      FROM party_open_items oi, r WHERE oi."retailerId" = r.id AND oi.side = 'debit'
    )
    SELECT r.id, r."partyName", r.days, r.lim::text AS limit,
      coalesce((SELECT "balancePaise" FROM party_balances WHERE "retailerId" = r.id), 0) AS balance,
      coalesce((SELECT sum("openPaise") FROM o WHERE age > r.days), 0) AS "overduePaise",
      (SELECT json_agg(json_build_object('refNo', "refNo", 'kind', kind, 'entryDate', "entryDate", 'days', age, 'openPaise', "openPaise") ORDER BY "entryDate")
       FROM (SELECT * FROM o WHERE age > r.days ORDER BY "entryDate" LIMIT 5) x) AS overdue
    FROM r`)).rows[0]
  if (!r) return null
  const balancePaise = Number(r.balance), limit = r.limit == null ? null : Number(r.limit)
  const overdue = (r.overdue ?? []).map((x) => ({ ...x, entryDate: String(x.entryDate).slice(0, 10), days: Number(x.days), openPaise: Number(x.openPaise) }))
  return {
    retailerId: r.id, partyName: r.partyName, creditDays: Number(r.days), balancePaise, creditLimitPaise: limit,
    overdue, overduePaise: Number(r.overduePaise), overLimit: limit != null && balancePaise > limit, blocked: overdue.length > 0,
  }
}

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The message a held party gets (starts with CREDIT_HOLD). */
export function creditHoldMessage(s: CreditStatus): string {
  const o = s.overdue[0]
  return `${CREDIT_HOLD} ${s.partyName} has ${rs(s.overduePaise)} unpaid for more than ${s.creditDays} days`
    + (o ? ` (oldest: ${o.refNo || o.kind}, ${o.days} days).` : '.')
    + ' Record the payment first, or ask an admin to allow it.'
}

/**
 * Refuse a new order / Direct bill for a held party unless an admin overrides. Returns the status
 * when the hold was overridden (for the audit row), else null. 1 query.
 */
export async function enforceCredit(db: DbOrTx, party: { retailerId?: string | null; name?: string | null }, override: { allowed: boolean; requested: boolean }): Promise<CreditStatus | null> {
  const s = await creditStatus(db, party)
  if (!s?.blocked) return null
  if (!override.requested || !override.allowed) throw new Error(creditHoldMessage(s))
  return s
}
