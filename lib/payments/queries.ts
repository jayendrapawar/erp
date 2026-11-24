// Payments screens: reads (payments step 5). Server only. Each list is ONE query; ageing, totals and
// running balances are worked out in SQL. Dates are business dates in IST.

import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@/lib/db/types'

const TODAY = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`
export const PAGE = 50

// ── Outstanding ───────────────────────────────────────────────────────────────

export type OutstandingSort = 'balance' | 'overdue' | 'oldest' | 'name'
export interface OutstandingRow {
  retailerId: string; partyName: string; area: string; city: string; phone: string
  balancePaise: number; unpaidPaise: number; advancePaise: number
  /** Unpaid by age of the bill: 0–30, 31–60, 61–90, over 90 days. */
  age0: number; age30: number; age60: number; age90: number
  oldestUnpaid: string | null; lastPaid: string | null; pendingCheques: number
}
export interface OutstandingPage {
  rows: OutstandingRow[]; total: number; offset: number
  sums: { balancePaise: number; unpaidPaise: number; advancePaise: number; age0: number; age30: number; age60: number; age90: number }
}

const SORT_SQL: Record<OutstandingSort, ReturnType<typeof sql>> = {
  balance: sql`balance DESC, "partyName"`,
  overdue: sql`a90 DESC, balance DESC, "partyName"`,
  oldest: sql`oldest NULLS LAST, "partyName"`,
  name: sql`"partyName"`,
}

/** Parties with money owed or advance held. 1 query. */
export async function listOutstanding(db: DbOrTx, o: { q?: string; sort?: OutstandingSort; overdueOnly?: boolean; offset?: number } = {}): Promise<OutstandingPage> {
  const q = String(o.q ?? '').trim().slice(0, 80)
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const sort = SORT_SQL[o.sort ?? 'balance'] ?? SORT_SQL.balance
  const offset = Math.max(0, Math.floor(Number(o.offset) || 0))
  const rows = (await db.execute<Record<string, string | number | null>>(sql`
    WITH oi AS (
      SELECT "retailerId", side, "openPaise", "entryDate", ${TODAY} - "entryDate" AS age FROM party_open_items
    ), p AS (
      SELECT r.id AS "retailerId", r."partyName", coalesce(r.area, '') AS area, coalesce(r.city, '') AS city, coalesce(r.phone, '') AS phone,
        coalesce(b."balancePaise", 0) AS balance,
        coalesce(sum(oi."openPaise") FILTER (WHERE oi.side = 'debit'), 0) AS unpaid,
        coalesce(sum(oi."openPaise") FILTER (WHERE oi.side = 'credit'), 0) AS advance,
        coalesce(sum(oi."openPaise") FILTER (WHERE oi.side = 'debit' AND oi.age <= 30), 0) AS a0,
        coalesce(sum(oi."openPaise") FILTER (WHERE oi.side = 'debit' AND oi.age BETWEEN 31 AND 60), 0) AS a30,
        coalesce(sum(oi."openPaise") FILTER (WHERE oi.side = 'debit' AND oi.age BETWEEN 61 AND 90), 0) AS a60,
        coalesce(sum(oi."openPaise") FILTER (WHERE oi.side = 'debit' AND oi.age > 90), 0) AS a90,
        min(oi."entryDate") FILTER (WHERE oi.side = 'debit') AS oldest,
        (SELECT max(x."countedOn") FROM payments x WHERE x."retailerId" = r.id AND x.status = 'active') AS "lastPaid",
        (SELECT count(*) FROM payments x WHERE x."retailerId" = r.id AND x.status = 'pending') AS "pendingCheques"
      FROM retailers r
      LEFT JOIN party_balances b ON b."retailerId" = r.id
      LEFT JOIN oi ON oi."retailerId" = r.id
      WHERE (${q} = '' OR r."partyName" ILIKE ${like} OR r.area ILIKE ${like} OR r.city ILIKE ${like})
      GROUP BY r.id, b."balancePaise"
      HAVING coalesce(b."balancePaise", 0) <> 0 OR count(oi."retailerId") > 0
         OR EXISTS (SELECT 1 FROM payments x WHERE x."retailerId" = r.id AND x.status = 'pending')
    ), f AS (SELECT * FROM p WHERE NOT ${o.overdueOnly === true} OR a90 > 0)
    SELECT f.*, oldest::text AS oldest, "lastPaid"::text AS "lastPaid",
      count(*) OVER () AS total, sum(balance) OVER () AS s_balance, sum(unpaid) OVER () AS s_unpaid, sum(advance) OVER () AS s_advance,
      sum(a0) OVER () AS s0, sum(a30) OVER () AS s30, sum(a60) OVER () AS s60, sum(a90) OVER () AS s90
    FROM f ORDER BY ${sort} LIMIT ${PAGE} OFFSET ${offset}`)).rows
  const N = (v: unknown) => Number(v ?? 0)
  const first = rows[0]
  return {
    offset,
    total: N(first?.total),
    sums: { balancePaise: N(first?.s_balance), unpaidPaise: N(first?.s_unpaid), advancePaise: N(first?.s_advance), age0: N(first?.s0), age30: N(first?.s30), age60: N(first?.s60), age90: N(first?.s90) },
    rows: rows.map((r) => ({
      retailerId: String(r.retailerId), partyName: String(r.partyName), area: String(r.area), city: String(r.city), phone: String(r.phone),
      balancePaise: N(r.balance), unpaidPaise: N(r.unpaid), advancePaise: N(r.advance),
      age0: N(r.a0), age30: N(r.a30), age60: N(r.a60), age90: N(r.a90),
      oldestUnpaid: (r.oldest as string | null) ?? null, lastPaid: (r.lastPaid as string | null) ?? null, pendingCheques: N(r.pendingCheques),
    })),
  }
}

// ── Party statement ───────────────────────────────────────────────────────────

export interface StatementEntry {
  id: number; entryDate: string; kind: string; refNo: string; note: string; reason: string | null
  amountPaise: number; runningPaise: number
  /** Payments: how it was paid. */
  mode: string | null; chequeNo: string | null
}
export interface Statement {
  party: { retailerId: string; partyName: string; phone: string; address: string; gst: string }
  from: string; to: string
  openingPaise: number; closingPaise: number; balanceNowPaise: number
  entries: StatementEntry[]
  /** Unpaid bills and other debits now, oldest first. */
  unpaid: Array<{ refNo: string; kind: string; entryDate: string; amountPaise: number; openPaise: number; days: number }>
  /** Cheques received, not yet deposited. */
  pendingCheques: Array<{ paymentId: number; receiptNo: string; amountPaise: number; chequeNo: string; chequeBank: string; chequeDate: string }>
  /** Counted payments that can still be reversed / bounced (in this period). */
  truncated: boolean
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ENTRIES = 1000

/** One party's ledger between two dates with a running balance. 1 query. */
export async function partyStatement(db: DbOrTx, retailerId: string, from: string, to: string): Promise<Statement | null> {
  if (!DATE.test(from) || !DATE.test(to)) throw new Error('Choose the dates.')
  if (from > to) throw new Error('"From" is after "To".')
  const r = (await db.execute<{
    party: Statement['party'] | null; opening: string; closing: string; now: string
    entries: Array<Omit<StatementEntry, 'runningPaise'> & { runningPaise: string }> | null
    unpaid: Statement['unpaid'] | null; cheques: Statement['pendingCheques'] | null
  }>(sql`
    WITH e AS (
      SELECT id, kind, "amountPaise", "entryDate", "refNo", note, reason, "paymentId"
      FROM party_ledger_entries WHERE "retailerId" = ${retailerId}
    ), ob AS (SELECT coalesce(sum("amountPaise"), 0) AS s FROM e WHERE "entryDate" < ${from}::date),
    rng AS (
      SELECT e.*, p.mode, p."chequeNo", (SELECT s FROM ob) + sum(e."amountPaise") OVER (ORDER BY e."entryDate", e.id) AS running
      FROM e LEFT JOIN payments p ON p.id = e."paymentId"
      WHERE e."entryDate" BETWEEN ${from}::date AND ${to}::date
    )
    SELECT
      (SELECT json_build_object('retailerId', id, 'partyName', "partyName", 'phone', coalesce(phone, ''),
         'address', concat_ws(', ', nullif(address, ''), nullif(city, '')), 'gst', coalesce(gst, ''))
       FROM retailers WHERE id = ${retailerId}) AS party,
      (SELECT s FROM ob) AS opening,
      (SELECT coalesce(sum("amountPaise"), 0) FROM e WHERE "entryDate" <= ${to}::date) AS closing,
      coalesce((SELECT "balancePaise" FROM party_balances WHERE "retailerId" = ${retailerId}), 0) AS now,
      (SELECT json_agg(json_build_object('id', id, 'entryDate', "entryDate", 'kind', kind, 'refNo', "refNo", 'note', note, 'reason', reason,
          'amountPaise', "amountPaise", 'runningPaise', running, 'mode', mode, 'chequeNo', "chequeNo") ORDER BY "entryDate", id)
       FROM (SELECT * FROM rng ORDER BY "entryDate", id LIMIT ${MAX_ENTRIES + 1}) x) AS entries,
      (SELECT json_agg(json_build_object('refNo', "refNo", 'kind', kind, 'entryDate', "entryDate", 'amountPaise', "amountPaise",
          'openPaise', "openPaise", 'days', ${TODAY} - "entryDate") ORDER BY "entryDate", id)
       FROM party_open_items WHERE "retailerId" = ${retailerId} AND side = 'debit') AS unpaid,
      (SELECT json_agg(json_build_object('paymentId', id, 'receiptNo', "receiptNo", 'amountPaise', "amountPaise", 'chequeNo', "chequeNo",
          'chequeBank', "chequeBank", 'chequeDate', "chequeDate") ORDER BY "chequeDate", id)
       FROM payments WHERE "retailerId" = ${retailerId} AND status = 'pending') AS cheques`)).rows[0]
  if (!r?.party) return null
  const entries = (r.entries ?? []).map((x) => ({
    ...x, id: Number(x.id), amountPaise: Number(x.amountPaise), runningPaise: Number(x.runningPaise), entryDate: String(x.entryDate).slice(0, 10),
  }))
  return {
    party: r.party, from, to,
    openingPaise: Number(r.opening), closingPaise: Number(r.closing), balanceNowPaise: Number(r.now),
    entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES,
    unpaid: (r.unpaid ?? []).map((x) => ({ ...x, entryDate: String(x.entryDate).slice(0, 10), amountPaise: Number(x.amountPaise), openPaise: Number(x.openPaise), days: Number(x.days) })),
    pendingCheques: (r.cheques ?? []).map((x) => ({ ...x, paymentId: Number(x.paymentId), amountPaise: Number(x.amountPaise), chequeDate: String(x.chequeDate).slice(0, 10) })),
  }
}

// ── Payments list (Cheques tab, statement actions) ───────────────────────────

export interface PaymentRow {
  paymentId: number; receiptNo: string; retailerId: string; partyName: string
  mode: string; amountPaise: number; receivedOn: string; countedOn: string | null; status: string
  chequeNo: string; chequeBank: string; chequeDate: string | null; reference: string; note: string; createdByName: string
}

/** Cheques waiting to be deposited (all), and payments counted in the last 60 days. 1 query. */
export async function listPayments(db: DbOrTx, o: { q?: string } = {}): Promise<{ pending: PaymentRow[]; recent: PaymentRow[] }> {
  const q = String(o.q ?? '').trim().slice(0, 80)
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = (await db.execute<Record<string, string | number | null>>(sql`
    SELECT p.id AS "paymentId", p."receiptNo", p."retailerId", r."partyName", p.mode, p."amountPaise", p."receivedOn"::text AS "receivedOn",
      p."countedOn"::text AS "countedOn", p.status, p."chequeNo", p."chequeBank", p."chequeDate"::text AS "chequeDate", p.reference, p.note, p."createdByName"
    FROM payments p JOIN retailers r ON r.id = p."retailerId"
    WHERE (p.status = 'pending' OR p."receivedOn" >= ${TODAY} - 60)
      AND (${q} = '' OR r."partyName" ILIKE ${like} OR p."receiptNo" ILIKE ${like} OR p."chequeNo" ILIKE ${like})
    ORDER BY (p.status = 'pending') DESC, CASE WHEN p.status = 'pending' THEN p."chequeDate" END, p."receivedOn" DESC, p.id DESC
    LIMIT 500`)).rows
  const list = rows.map((r) => ({
    paymentId: Number(r.paymentId), receiptNo: String(r.receiptNo), retailerId: String(r.retailerId), partyName: String(r.partyName),
    mode: String(r.mode), amountPaise: Number(r.amountPaise), receivedOn: String(r.receivedOn), countedOn: (r.countedOn as string | null) ?? null,
    status: String(r.status), chequeNo: String(r.chequeNo ?? ''), chequeBank: String(r.chequeBank ?? ''), chequeDate: (r.chequeDate as string | null) ?? null,
    reference: String(r.reference ?? ''), note: String(r.note ?? ''), createdByName: String(r.createdByName ?? ''),
  }))
  return { pending: list.filter((p) => p.status === 'pending'), recent: list.filter((p) => p.status !== 'pending') }
}

/** Parties to choose from (Record payment, Statement). 1 query. */
export async function listPartyChoices(db: DbOrTx): Promise<PartyChoice[]> {
  const rows = (await db.execute<PartyChoice>(sql`
    SELECT id, "partyName" AS name, coalesce(area, '') AS area, coalesce(city, '') AS city, coalesce(phone, '') AS phone
    FROM retailers WHERE status = 'active' ORDER BY "partyName"`)).rows
  return rows
}
export type PartyChoice = { id: string; name: string; area: string; city: string; phone: string }
