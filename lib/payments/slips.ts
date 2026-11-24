// Banks and cash / bank slips (owner, 24 Nov 2026; migration 0019). Server only.
//
// A slip holds one day's receipts: a cash slip, or a bank slip for one of the shop's banks. Saving a
// payment "into" cash or a bank puts it on that day's slip (opened on the first line, numbered from
// its series: cash C1, C2 …; each bank its own prefix). The same day's slip takes more lines later; a
// wrong line is reversed with a reason (lib/payments/payments.ts reversePayment), never deleted.

import { sql } from 'drizzle-orm'
import type { Actor, DbOrTx, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { formatBillNo, prefixesClash } from '@/lib/billing/bill-number'

export interface BankAccount {
  id: number; name: string; slipPrefix: string; accountNo: string; ifsc: string; branch: string; note: string; active: boolean
  /** Next slip number of this bank's series. */
  nextSlip: number
}
export interface SlipNumbering { prefix: string; next: number }
export type SlipInto = { kind: 'cash' } | { kind: 'bank'; bankAccountId: number }

const seqName = (into: SlipInto) => (into.kind === 'cash' ? 'slip_cash' : `slip_bank_${into.bankAccountId}`)
const PREFIX = /^[A-Za-z0-9/-]{1,12}$/

/** The shop's banks (Master → Banks; Record payment's "Into"). 1 query. */
export async function listBanks(db: DbOrTx, o: { activeOnly?: boolean } = {}): Promise<BankAccount[]> {
  const rows = (await db.execute<Record<string, string | number | boolean>>(sql`
    SELECT b.id, b.name, b."slipPrefix", b."accountNo", b.ifsc, b.branch, b.note, b.active, coalesce(s.next, 1) AS "nextSlip"
    FROM bank_accounts b LEFT JOIN document_sequences s ON s.name = 'slip_bank_' || b.id
    WHERE NOT ${o.activeOnly === true} OR b.active
    ORDER BY b.active DESC, b.name`)).rows
  return rows.map((r) => ({
    id: Number(r.id), name: String(r.name), slipPrefix: String(r.slipPrefix), accountNo: String(r.accountNo), ifsc: String(r.ifsc),
    branch: String(r.branch), note: String(r.note), active: Boolean(r.active), nextSlip: Number(r.nextSlip),
  }))
}

/** Cash slip numbering (Master → Banks). 1 query. */
export async function cashSlipNumbering(db: DbOrTx): Promise<SlipNumbering> {
  const r = (await db.execute<{ prefix: string; next: string }>(sql`SELECT prefix, next FROM document_sequences WHERE name = 'slip_cash'`)).rows[0]
  return { prefix: r?.prefix ?? 'C', next: Number(r?.next ?? 1) }
}

/** Highest slip number already used with this prefix. 1 query. */
async function highestSlip(db: DbOrTx, prefix: string): Promise<number> {
  const r = (await db.execute<{ max: string | null }>(sql`
    SELECT max(substring("slipNo" FROM ${prefix.length + 1}::int)::bigint) AS max FROM receipt_slips
    WHERE left("slipNo", ${prefix.length}::int) = ${prefix} AND substring("slipNo" FROM ${prefix.length + 1}::int) ~ '^[0-9]{1,15}$'`)).rows[0]
  return Number(r?.max ?? 0)
}

/** Refuse a prefix whose numbers could read as another series' numbers (cash or another bank). 1 query. */
async function checkPrefix(db: DbOrTx, prefix: string, self: string): Promise<void> {
  const others = (await db.execute<{ name: string; prefix: string }>(sql`
    SELECT name, prefix FROM document_sequences WHERE (name = 'slip_cash' OR name LIKE 'slip_bank_%') AND name <> ${self}`)).rows
  const clash = others.find((o) => prefixesClash(prefix, o.prefix))
  if (clash) throw new Error(`The prefix "${prefix}" clashes with "${clash.prefix}" already used by ${clash.name === 'slip_cash' ? 'cash slips' : 'another bank'}. Choose a different prefix.`)
}

function cleanNext(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 1 || n > 9_999_999_999) throw new Error('Next slip number must be a whole number, 1 or more.')
  return n
}

/** Add or edit a bank (with its slip prefix and next slip number). 1 transaction, ~5 statements + audit. */
export async function saveBank(tx: Tx, actor: Actor, raw: unknown): Promise<BankAccount[]> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const t = (k: string, max: number) => String(r[k] ?? '').trim().slice(0, max)
  const id = r.id == null || r.id === '' ? null : Number(r.id)
  const name = t('name', 80), prefix = t('slipPrefix', 12).toUpperCase()
  if (!name) throw new Error('Type the bank\'s name.')
  if (!PREFIX.test(prefix)) throw new Error('Slip prefix: up to 12 letters, digits, "/" or "-" (e.g. SBI/).')
  const next = cleanNext(r.nextSlip ?? 1)
  const fields = { name, prefix, accountNo: t('accountNo', 30), ifsc: t('ifsc', 20).toUpperCase(), branch: t('branch', 60), note: t('note', 200), active: r.active !== false }
  if (fields.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(fields.ifsc)) throw new Error('IFSC should look like SBIN0001234.')
  let bankId = id
  try {
    if (bankId == null) {
      bankId = Number((await tx.execute<{ id: number }>(sql`
        INSERT INTO bank_accounts (name, "slipPrefix", "accountNo", ifsc, branch, note, active, "updatedByName")
        VALUES (${fields.name}, ${fields.prefix}, ${fields.accountNo}, ${fields.ifsc}, ${fields.branch}, ${fields.note}, ${fields.active}, ${actor.name})
        RETURNING id`)).rows[0].id)
    } else {
      const u = await tx.execute(sql`
        UPDATE bank_accounts SET name = ${fields.name}, "slipPrefix" = ${fields.prefix}, "accountNo" = ${fields.accountNo}, ifsc = ${fields.ifsc},
          branch = ${fields.branch}, note = ${fields.note}, active = ${fields.active}, "updatedAt" = now(), "updatedByName" = ${actor.name}
        WHERE id = ${bankId}`)
      if (!u.rowCount) throw new Error('Bank not found.')
    }
  } catch (e) {
    const m = String((e as { cause?: Error }).cause?.message ?? (e as Error).message)
    if (/bank_accounts_name_unique/.test(m)) throw new Error(`A bank named "${name}" already exists.`)
    if (/bank_accounts_prefix_unique/.test(m)) throw new Error(`The slip prefix "${prefix}" is already used by another bank.`)
    throw e
  }
  const series = `slip_bank_${bankId}`
  await checkPrefix(tx, fields.prefix, series)
  const used = await highestSlip(tx, fields.prefix)
  if (next <= used) throw new Error(`Slip ${formatBillNo(fields.prefix, used, 0)} is already used. The next slip number must be ${used + 1} or more.`)
  await tx.execute(sql`
    INSERT INTO document_sequences (name, prefix, next, padding, "updatedByName") VALUES (${series}, ${fields.prefix}, ${next}, 0, ${actor.name})
    ON CONFLICT (name) DO UPDATE SET prefix = EXCLUDED.prefix, next = EXCLUDED.next, "updatedAt" = now(), "updatedByName" = EXCLUDED."updatedByName"`)
  await audit(tx, { actor, action: id == null ? 'bank.created' : 'bank.updated', entityType: 'bank_account', entityId: bankId!, after: { ...fields, nextSlip: next } })
  return listBanks(tx)
}

/** Cash slip prefix and next number (go-live: continue the old software's numbers). */
export async function saveCashSlipNumbering(tx: Tx, actor: Actor, raw: unknown): Promise<SlipNumbering> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const prefix = String(r.prefix ?? '').trim().toUpperCase()
  if (!PREFIX.test(prefix)) throw new Error('Slip prefix: up to 12 letters, digits, "/" or "-" (e.g. C).')
  const next = cleanNext(r.next)
  await checkPrefix(tx, prefix, 'slip_cash')
  const used = await highestSlip(tx, prefix)
  if (next <= used) throw new Error(`Slip ${formatBillNo(prefix, used, 0)} is already used. The next slip number must be ${used + 1} or more.`)
  await tx.execute(sql`UPDATE document_sequences SET prefix = ${prefix}, next = ${next}, "updatedAt" = now(), "updatedByName" = ${actor.name} WHERE name = 'slip_cash'`)
  await audit(tx, { actor, action: 'slip_numbering.changed', entityType: 'document_sequence', entityId: 'slip_cash', after: { prefix, next } })
  return { prefix, next }
}

/**
 * That day's slip for cash / a bank, locked — opened (and numbered) when it is the day's first line.
 * 1–3 statements.
 */
export async function slipForDay(tx: Tx, actor: Actor, into: SlipInto, day: string): Promise<{ id: number; slipNo: string }> {
  const bank = into.kind === 'bank' ? into.bankAccountId : 0
  const find = async () => (await tx.execute<{ id: string; slipNo: string }>(sql`
    SELECT id, "slipNo" FROM receipt_slips WHERE kind = ${into.kind} AND coalesce("bankAccountId", 0) = ${bank} AND "slipDate" = ${day}::date FOR UPDATE`)).rows[0]
  const have = await find()
  if (have) return { id: Number(have.id), slipNo: have.slipNo }
  if (into.kind === 'bank') {
    const b = (await tx.execute<{ active: boolean; name: string }>(sql`SELECT active, name FROM bank_accounts WHERE id = ${bank}`)).rows[0]
    if (!b) throw new Error('Bank not found. Add it in Master → Banks.')
    if (!b.active) throw new Error(`${b.name} is retired in Master → Banks.`)
  }
  const seq = (await tx.execute<{ prefix: string; n: string; padding: number }>(sql`
    UPDATE document_sequences SET next = next + 1 WHERE name = ${seqName(into)} RETURNING prefix, next - 1 AS n, padding`)).rows[0]
  if (!seq) throw new Error('Slip numbering is not set up for this bank. Open it in Master → Banks and save.')
  const slipNo = formatBillNo(seq.prefix, Number(seq.n), seq.padding)
  const made = (await tx.execute<{ id: string }>(sql`
    INSERT INTO receipt_slips (kind, "bankAccountId", "slipNo", "slipDate", "createdBy", "createdByName")
    VALUES (${into.kind}, ${into.kind === 'bank' ? bank : null}, ${slipNo}, ${day}::date, ${actor.id}, ${actor.name})
    ON CONFLICT DO NOTHING RETURNING id`)).rows[0]
  if (made) return { id: Number(made.id), slipNo }
  // Opened by someone else a moment ago: use theirs (this number is skipped).
  const again = await find()
  if (!again) throw new Error('Could not open the slip. Try again.')
  return { id: Number(again.id), slipNo: again.slipNo }
}

export interface SlipLine {
  paymentId: number; receiptNo: string; retailerId: string; partyName: string; mode: string; amountPaise: number
  reference: string; chequeNo: string; note: string; status: string; reversalReason: string | null; createdByName: string
  /** Set against bills / early-payment discount on this line. */
  setAgainst: Array<{ refNo: string; amountPaise: number }>; discountPaise: number
}
export interface SlipView {
  slip: { id: number; slipNo: string; slipDate: string; kind: 'cash' | 'bank'; bankName: string | null; createdByName: string } | null
  lines: SlipLine[]
  totalPaise: number
}

/** That day's slip for cash / a bank with its lines (what each paid). 1 query. */
export async function slipView(db: DbOrTx, into: SlipInto, day: string): Promise<SlipView> {
  const bank = into.kind === 'bank' ? into.bankAccountId : 0
  const r = (await db.execute<{ slip: SlipView['slip']; lines: Array<Record<string, unknown>> | null }>(sql`
    WITH s AS (
      SELECT rs.id, rs."slipNo", rs."slipDate"::text AS "slipDate", rs.kind, b.name AS "bankName", rs."createdByName"
      FROM receipt_slips rs LEFT JOIN bank_accounts b ON b.id = rs."bankAccountId"
      WHERE rs.kind = ${into.kind} AND coalesce(rs."bankAccountId", 0) = ${bank} AND rs."slipDate" = ${day}::date
    )
    SELECT (SELECT row_to_json(s) FROM s) AS slip,
      (SELECT json_agg(json_build_object(
          'paymentId', p.id, 'receiptNo', p."receiptNo", 'retailerId', p."retailerId", 'partyName', r."partyName", 'mode', p.mode,
          'amountPaise', p."amountPaise", 'reference', p.reference, 'chequeNo', p."chequeNo", 'note', p.note, 'status', p.status,
          'reversalReason', p."reversalReason", 'createdByName', p."createdByName",
          'discountPaise', coalesce((SELECT -sum(e."amountPaise") FROM party_ledger_entries e WHERE e."paymentId" = p.id AND e.kind = 'discount'), 0),
          'setAgainst', coalesce((SELECT json_agg(json_build_object('refNo', d."refNo", 'amountPaise', a."amountPaise") ORDER BY a.id)
              FROM party_ledger_entries e JOIN party_allocations a ON a."creditEntryId" = e.id AND a."reversalOfId" IS NULL
                AND NOT EXISTS (SELECT 1 FROM party_allocations x WHERE x."reversalOfId" = a.id)
              JOIN party_ledger_entries d ON d.id = a."debitEntryId"
              WHERE e."paymentId" = p.id AND e.kind = 'payment'), '[]')
        ) ORDER BY p.id)
       FROM payments p JOIN retailers r ON r.id = p."retailerId" WHERE p."slipId" = (SELECT id FROM s)) AS lines`)).rows[0]
  const lines = (r?.lines ?? []).map((l) => ({
    paymentId: Number(l.paymentId), receiptNo: String(l.receiptNo), retailerId: String(l.retailerId), partyName: String(l.partyName), mode: String(l.mode),
    amountPaise: Number(l.amountPaise), reference: String(l.reference ?? ''), chequeNo: String(l.chequeNo ?? ''), note: String(l.note ?? ''),
    status: String(l.status), reversalReason: (l.reversalReason as string | null) ?? null, createdByName: String(l.createdByName ?? ''),
    setAgainst: (l.setAgainst as Array<{ refNo: string; amountPaise: number }>).map((x) => ({ refNo: x.refNo, amountPaise: Number(x.amountPaise) })),
    discountPaise: Number(l.discountPaise),
  }))
  return {
    slip: r?.slip ? { ...r.slip, id: Number(r.slip.id) } : null,
    lines,
    totalPaise: lines.filter((l) => l.status === 'active').reduce((s, l) => s + l.amountPaise, 0),
  }
}
