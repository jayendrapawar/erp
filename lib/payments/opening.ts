// Opening balances (payments step 6; owner, 22 Nov 2026). Server only.
//
// What parties owed (or had paid in advance) before the app, entered as of go-live: one at a time or
// by Excel / CSV upload with a preview, like the other uploads. Each row is one ledger entry of kind
// 'opening': + = the party owes (a lump sum, or one old bill with its number), − = advance held.
//
// Same row twice: the ledger key is party + date + old bill no. + amount, so uploading a file again
// adds nothing twice (the preview says "already entered"); two different old bills of the same amount
// on the same day need their bill numbers. A wrong row is reversed with a reason, never deleted.
//
// After saving, each party's open dues and advance are matched oldest first (the owner's rule: advance
// goes to what is owed). Database work: preview = 2 queries for any number of rows; save = 1
// transaction (lock the parties, check keys, 1 insert, 1 matching statement, 1 audit row).

import { sql } from 'drizzle-orm'
import type { Actor, DbOrTx, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { toPaise } from '@/lib/billing/bill-totals'

export interface OpeningInput { party: string; partyId?: string; date: string; amountPaise: number; billNo: string; note: string }
export interface OpeningRow extends OpeningInput { rowNumber: number }
export type OpeningStatus = 'ok' | 'error' | 'duplicate'
export interface OpeningPlanRow extends OpeningRow { status: OpeningStatus; message: string; retailerId: string | null; partyName: string | null }
export interface OpeningPlan { rows: OpeningPlanRow[]; ok: number; errors: number; duplicates: number; owedPaise: number; advancePaise: number; missingColumns: string[] }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ROWS = 5000
const J = (v: unknown) => JSON.stringify(v)
const headerKey = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '')
const HEADERS: Record<string, string[]> = {
  party: ['party', 'partyname', 'retailer', 'retailername', 'name', 'customer'],
  partyId: ['partycode', 'partyid', 'retailerid', 'retailercode', 'code', 'id'],
  date: ['date', 'asof', 'asondate', 'billdate', 'openingdate'],
  amount: ['amount', 'balance', 'openingbalance', 'outstanding', 'due', 'amountrs'],
  type: ['type', 'drcr', 'dc', 'side'],
  billNo: ['billno', 'oldbillno', 'bill', 'invoice', 'invoiceno', 'ref', 'refno'],
  note: ['note', 'notes', 'remark', 'remarks'],
}

/** Ledger key of an opening row: the same row twice is entered once. */
export function openingKey(retailerId: string, r: { date: string; billNo: string; amountPaise: number }): string {
  return `opening:${retailerId}:${r.date}:${r.billNo.trim().toUpperCase()}:${r.amountPaise}`
}

/** 2026-04-01 from a Date, an Excel day number, "01/04/2026", "1-4-26", "2026-04-01". */
export function readDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000).toISOString().slice(0, 10)
  const s = String(v ?? '').trim()
  if (DATE.test(s)) return Number.isNaN(Date.parse(s)) ? null : s
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s)
  if (!m) return null
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso
}

/** Paise from 1,23,456.50 / "₹ 500" / -200 / "500 Cr"; null when not an amount. */
export function readAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null
  const s = String(v ?? '').replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '').replace(/(dr|cr)$/i, '')
  if (!s) return null
  try { return toPaise(s) } catch { return null }
}

/** Header row + data rows → opening rows (a type column "Cr" / "Advance" makes the amount advance). */
export function parseOpeningSheet(cells: { rowNumber: number; values: unknown[] }[]): { rows: OpeningRow[]; problems: Array<{ rowNumber: number; message: string }>; missingColumns: string[] } {
  const head = cells[0]
  const col: Record<string, number> = {}
  head?.values.forEach((v, i) => {
    const k = headerKey(v)
    for (const [name, aliases] of Object.entries(HEADERS)) if (col[name] === undefined && aliases.includes(k)) col[name] = i
  })
  const missingColumns = [
    ...(col.party === undefined && col.partyId === undefined ? ['Party'] : []),
    ...(col.date === undefined ? ['Date'] : []),
    ...(col.amount === undefined ? ['Amount'] : []),
  ]
  const rows: OpeningRow[] = [], problems: Array<{ rowNumber: number; message: string }> = []
  if (missingColumns.length) return { rows, problems, missingColumns }
  for (const c of cells.slice(1, MAX_ROWS + 1)) {
    const at = (k: string) => (col[k] === undefined ? '' : c.values[col[k]])
    const party = String(at('party') ?? '').trim(), partyId = String(at('partyId') ?? '').trim()
    if (!party && !partyId && at('amount') == null) continue // empty line
    const date = readDate(at('date'))
    let amount = readAmount(at('amount'))
    const type = String(at('type') ?? '').trim().toLowerCase()
    const rawAmount = String(at('amount') ?? '').trim().toLowerCase()
    if (amount !== null && (/^(cr|credit|advance|adv)/.test(type) || /cr$/.test(rawAmount))) amount = -Math.abs(amount)
    rows.push({
      rowNumber: c.rowNumber, party, partyId, date: date ?? '', amountPaise: amount ?? 0,
      billNo: String(at('billNo') ?? '').trim().slice(0, 40), note: String(at('note') ?? '').trim().slice(0, 200),
    })
    if (!date) problems.push({ rowNumber: c.rowNumber, message: 'Date not understood (use DD/MM/YYYY).' })
    if (amount === null) problems.push({ rowNumber: c.rowNumber, message: 'Amount not understood.' })
  }
  if (cells.length - 1 > MAX_ROWS) problems.push({ rowNumber: cells[MAX_ROWS + 1].rowNumber, message: `Only the first ${MAX_ROWS} rows are read. Split the file.` })
  return { rows, problems, missingColumns }
}

/**
 * Rows already in the ledger under these keys: live = not reversed. A row re-entered after its
 * reversal gets the key + ":r2", ":r3"… (the reversed entry keeps its key). 1 query.
 */
async function existingKeys(db: DbOrTx, bases: string[]): Promise<Map<string, { live: boolean; count: number }>> {
  const out = new Map<string, { live: boolean; count: number }>()
  if (!bases.length) return out
  const rows = (await db.execute<{ base: string; live: boolean; n: string }>(sql`
    WITH b AS (SELECT (x)::text AS base FROM json_array_elements_text(${J(bases)}::json) x)
    SELECT b.base, bool_or(NOT EXISTS (SELECT 1 FROM party_ledger_entries r WHERE r."reversalOfId" = e.id)) AS live, count(*) AS n
    FROM b JOIN party_ledger_entries e ON e."idempotencyKey" = b.base OR e."idempotencyKey" LIKE b.base || ':r%'
    GROUP BY b.base`)).rows
  for (const r of rows) out.set(r.base, { live: Boolean(r.live), count: Number(r.n) })
  return out
}

/** Match parties, check every row, mark rows already entered. 2 queries. */
export async function planOpenings(db: DbOrTx, rows: OpeningRow[], problems: Array<{ rowNumber: number; message: string }> = []): Promise<OpeningPlan> {
  const found = (await db.execute<{ k: string; id: string; partyName: string; n: string }>(sql`
    WITH x AS (SELECT DISTINCT * FROM json_to_recordset(${J(rows.map((r) => ({ name: r.party, id: r.partyId ?? '' })))}::json) AS x(name text, id text))
    SELECT CASE WHEN x.id <> '' THEN 'id:' || lower(x.id) ELSE 'name:' || lower(btrim(x.name)) END AS k,
           min(r.id) AS id, min(r."partyName") AS "partyName", count(DISTINCT r.id) AS n
    FROM x JOIN retailers r ON (x.id <> '' AND lower(r.id) = lower(x.id)) OR (x.id = '' AND lower(btrim(r."partyName")) = lower(btrim(x.name)))
    GROUP BY 1`)).rows
  const byKey = new Map(found.map((f) => [f.k, f]))
  const keyOf = (r: OpeningRow) => (r.partyId ? `id:${r.partyId.toLowerCase()}` : `name:${r.party.trim().toLowerCase()}`)
  const bad = new Map<number, string>()
  for (const p of problems) if (!bad.has(p.rowNumber)) bad.set(p.rowNumber, p.message)
  const planned: OpeningPlanRow[] = rows.map((r) => {
    const f = byKey.get(keyOf(r))
    let message = bad.get(r.rowNumber) ?? ''
    if (!message && !f) message = `"${r.partyId || r.party}" is not in the retailer master.`
    if (!message && r.amountPaise === 0) message = 'Amount is 0.'
    if (!message && Math.abs(r.amountPaise) > 1_000_000_000_00) message = 'Amount is too large.'
    return { ...r, status: message ? 'error' : 'ok', message, retailerId: f && Number(f.n) === 1 ? f.id : null, partyName: f?.partyName ?? null }
  })
  // Same row twice in the file.
  const seen = new Map<string, number>()
  for (const r of planned) {
    if (r.status !== 'ok') continue
    const k = openingKey(r.retailerId!, r)
    if (seen.has(k)) { r.status = 'error'; r.message = `Same as row ${seen.get(k)}. Give each old bill its bill no.` } else seen.set(k, r.rowNumber)
  }
  // Already entered (an earlier upload or by hand).
  const have = await existingKeys(db, [...seen.keys()])
  for (const r of planned) if (r.status === 'ok' && have.get(openingKey(r.retailerId!, r))?.live) { r.status = 'duplicate'; r.message = 'Already entered.' }
  const ok = planned.filter((r) => r.status === 'ok')
  return {
    rows: planned, ok: ok.length, errors: planned.filter((r) => r.status === 'error').length, duplicates: planned.filter((r) => r.status === 'duplicate').length,
    owedPaise: ok.filter((r) => r.amountPaise > 0).reduce((s, r) => s + r.amountPaise, 0),
    advancePaise: ok.filter((r) => r.amountPaise < 0).reduce((s, r) => -r.amountPaise + s, 0),
    missingColumns: [],
  }
}

/**
 * Match each party's open dues and advance, oldest first (dues by date; advance by date). One
 * statement for any number of parties. The parties must be locked.
 */
export async function settleParties(tx: Tx, actor: Actor, retailerIds: string[]): Promise<number> {
  if (!retailerIds.length) return 0
  const rows = (await tx.execute<{ amountPaise: string }>(sql`
    WITH o AS (SELECT * FROM party_open_items WHERE "retailerId" IN (SELECT (x)::text FROM json_array_elements_text(${J(retailerIds)}::json) x)),
    d AS (SELECT id, "retailerId", "openPaise" AS amt, sum("openPaise") OVER (PARTITION BY "retailerId" ORDER BY "entryDate", id) - "openPaise" AS s FROM o WHERE side = 'debit'),
    c AS (SELECT id, "retailerId", "openPaise" AS amt, sum("openPaise") OVER (PARTITION BY "retailerId" ORDER BY "entryDate", id) - "openPaise" AS s FROM o WHERE side = 'credit'),
    m AS (
      SELECT d."retailerId", d.id AS did, c.id AS cid, LEAST(d.s + d.amt, c.s + c.amt) - GREATEST(d.s, c.s) AS amt
      FROM d JOIN c ON c."retailerId" = d."retailerId" AND d.s < c.s + c.amt AND c.s < d.s + d.amt
    )
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
    SELECT "retailerId", did, cid, amt, 'auto', ${actor.id} FROM m WHERE amt > 0
    RETURNING "amountPaise"`)).rows
  return rows.reduce((s, r) => s + Number(r.amountPaise), 0)
}

/** Save the rows marked ok (re-checked inside the transaction). Returns how many were added. */
export async function applyOpenings(tx: Tx, actor: Actor, rows: OpeningPlanRow[], source: { fileName?: string } = {}): Promise<{ added: number; owedPaise: number; advancePaise: number; matchedPaise: number }> {
  const ok = rows.filter((r) => r.status === 'ok' && r.retailerId)
  if (!ok.length) return { added: 0, owedPaise: 0, advancePaise: 0, matchedPaise: 0 }
  for (const r of ok) {
    if (!DATE.test(r.date)) throw new Error(`Row ${r.rowNumber}: bad date.`)
    if (!Number.isInteger(r.amountPaise) || r.amountPaise === 0) throw new Error(`Row ${r.rowNumber}: bad amount.`)
  }
  const parties = [...new Set(ok.map((r) => r.retailerId!))].sort()
  await tx.execute(sql`SELECT id FROM retailers WHERE id IN (SELECT (x)::text FROM json_array_elements_text(${J(parties)}::json) x) ORDER BY id FOR UPDATE`)
  const have = await existingKeys(tx, ok.map((r) => openingKey(r.retailerId!, r)))
  const data = ok.flatMap((r) => {
    const base = openingKey(r.retailerId!, r), h = have.get(base)
    if (h?.live) return [] // entered meanwhile
    return [{ retailerId: r.retailerId, amountPaise: r.amountPaise, entryDate: r.date, refNo: r.billNo, note: r.note || 'Opening balance', key: h ? `${base}:r${h.count + 1}` : base }]
  })
  // ON CONFLICT: a row entered meanwhile (another tab) is skipped, not doubled.
  const added = (await tx.execute<{ amountPaise: string }>(sql`
    INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "refNo", note, "idempotencyKey", "createdBy", "createdByName")
    SELECT x."retailerId", 'opening', x."amountPaise", x."entryDate"::date, x."refNo", x.note, x.key, ${actor.id}, ${actor.name}
    FROM json_to_recordset(${J(data)}::json) AS x("retailerId" text, "amountPaise" bigint, "entryDate" text, "refNo" text, note text, key text)
    ON CONFLICT ("idempotencyKey") DO NOTHING
    RETURNING "amountPaise"`)).rows.map((r) => Number(r.amountPaise))
  const matchedPaise = await settleParties(tx, actor, parties)
  const owedPaise = added.filter((a) => a > 0).reduce((s, a) => s + a, 0)
  const advancePaise = added.filter((a) => a < 0).reduce((s, a) => s - a, 0)
  await audit(tx, {
    actor, action: 'opening_balance.added', entityType: 'party_ledger', entityId: parties.length === 1 ? parties[0] : 'upload',
    after: { rows: added.length, parties: parties.length, owedPaise, advancePaise, matchedPaise, fileName: source.fileName },
  })
  return { added: added.length, owedPaise, advancePaise, matchedPaise }
}

/** Reverse an opening entry entered by mistake (what was set against it is freed). 4 statements + audit. */
export async function reverseOpening(tx: Tx, actor: Actor, entryId: number, reason: unknown): Promise<void> {
  const why = String(reason ?? '').trim().slice(0, 500)
  if (!why) throw new Error('Type the reason.')
  const e = (await tx.execute<{ retailerId: string; kind: string; refNo: string }>(sql`
    SELECT "retailerId", kind, "refNo" FROM party_ledger_entries WHERE id = ${entryId}`)).rows[0]
  if (!e || e.kind !== 'opening') throw new Error('Opening balance not found.')
  await tx.execute(sql`SELECT id FROM retailers WHERE id = ${e.retailerId} FOR UPDATE`)
  if ((await tx.execute(sql`SELECT 1 FROM party_ledger_entries WHERE "reversalOfId" = ${entryId}`)).rows.length) throw new Error('This opening balance is already reversed.')
  await tx.execute(sql`
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", "reversalOfId", method, "createdBy")
    SELECT a."retailerId", a."debitEntryId", a."creditEntryId", -a."amountPaise", a.id, 'reversal', ${actor.id}
    FROM party_allocations a
    WHERE a."reversalOfId" IS NULL AND ${entryId} IN (a."debitEntryId", a."creditEntryId")
      AND NOT EXISTS (SELECT 1 FROM party_allocations r WHERE r."reversalOfId" = a.id)`)
  await tx.execute(sql`
    WITH r AS (
      INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "reversalOfId", "refNo", reason, "idempotencyKey", "createdBy", "createdByName")
      SELECT "retailerId", 'reversal', -"amountPaise", (now() AT TIME ZONE 'Asia/Kolkata')::date, id, "refNo", ${`Opening balance reversed: ${why}`}, 'reversal:' || id, ${actor.id}, ${actor.name}
      FROM party_ledger_entries WHERE id = ${entryId}
      RETURNING id, "retailerId", "reversalOfId", "amountPaise"
    )
    INSERT INTO party_allocations ("retailerId", "debitEntryId", "creditEntryId", "amountPaise", method, "createdBy")
    SELECT "retailerId", CASE WHEN "amountPaise" > 0 THEN id ELSE "reversalOfId" END, CASE WHEN "amountPaise" < 0 THEN id ELSE "reversalOfId" END,
           abs("amountPaise"), 'auto', ${actor.id} FROM r`)
  await audit(tx, { actor, action: 'opening_balance.reversed', entityType: 'party_ledger', entityId: entryId, after: { retailerId: e.retailerId, refNo: e.refNo }, reason: why })
}

export interface OpeningListRow {
  entryId: number; retailerId: string; partyName: string; entryDate: string; amountPaise: number; refNo: string; note: string
  createdByName: string; createdAt: string; reversed: boolean
}

/** Opening balances entered (newest first, up to 500). 1 query. */
export async function listOpenings(db: DbOrTx, q = ''): Promise<{ rows: OpeningListRow[]; owedPaise: number; advancePaise: number; count: number }> {
  const s = String(q).trim().slice(0, 80)
  const like = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = (await db.execute<Record<string, string | number | boolean>>(sql`
    SELECT e.id AS "entryId", e."retailerId", r."partyName", e."entryDate"::text AS "entryDate", e."amountPaise", e."refNo", e.note,
      e."createdByName", e."createdAt"::text AS "createdAt",
      EXISTS (SELECT 1 FROM party_ledger_entries x WHERE x."reversalOfId" = e.id) AS reversed,
      count(*) OVER () AS total,
      sum(CASE WHEN e."amountPaise" > 0 AND NOT EXISTS (SELECT 1 FROM party_ledger_entries x WHERE x."reversalOfId" = e.id) THEN e."amountPaise" ELSE 0 END) OVER () AS owed,
      sum(CASE WHEN e."amountPaise" < 0 AND NOT EXISTS (SELECT 1 FROM party_ledger_entries x WHERE x."reversalOfId" = e.id) THEN -e."amountPaise" ELSE 0 END) OVER () AS adv
    FROM party_ledger_entries e JOIN retailers r ON r.id = e."retailerId"
    WHERE e.kind = 'opening' AND (${s} = '' OR r."partyName" ILIKE ${like} OR e."refNo" ILIKE ${like})
    ORDER BY e."createdAt" DESC, e.id DESC LIMIT 500`)).rows
  return {
    count: Number(rows[0]?.total ?? 0), owedPaise: Number(rows[0]?.owed ?? 0), advancePaise: Number(rows[0]?.adv ?? 0),
    rows: rows.map((r) => ({
      entryId: Number(r.entryId), retailerId: String(r.retailerId), partyName: String(r.partyName), entryDate: String(r.entryDate),
      amountPaise: Number(r.amountPaise), refNo: String(r.refNo ?? ''), note: String(r.note ?? ''), createdByName: String(r.createdByName ?? ''),
      createdAt: String(r.createdAt), reversed: Boolean(r.reversed),
    })),
  }
}
