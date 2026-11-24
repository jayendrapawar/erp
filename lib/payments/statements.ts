// Bank statement import (owner, 24–25 Nov 2026; migration 0020). Server only.
//
// Upload a bank's Excel / CSV statement → its lines are saved (a line already imported is skipped, so
// an overlapping file adds nothing twice) → each money-in line is reviewed:
//   already entered  a payment typed on that bank's slip with the same amount (and the cheque no. /
//                    UTR in the line) → confirming links it, nothing is added;
//   known payer      the payer name / UPI ID was confirmed before for a party (payer_aliases);
//   unknown          the accountant chooses the party, or splits the amount across several parties.
// Nothing reaches a ledger until a person confirms the line. Confirming makes each part a payment on
// that bank's slip for the statement date (UPI / transfer / cheque), set against the oldest bills, and
// remembers the payer for next time. Lines that are not party payments are ignored with a reason.

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Actor, DbOrTx, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { recordPayment } from './payments'
import { chequeNoOf, guessMode, lineKeys, type StatementColumns, type StatementLine } from './statement-parse'

const J = (v: unknown) => JSON.stringify(v)

/** The bank's saved statement columns. 1 query. */
export async function bankStatementColumns(db: DbOrTx, bankAccountId: number): Promise<{ name: string; columns: StatementColumns | null } | null> {
  const r = (await db.execute<{ name: string; columns: StatementColumns | null }>(sql`
    SELECT name, "statementColumns" AS columns FROM bank_accounts WHERE id = ${bankAccountId}`)).rows[0]
  return r ?? null
}

/** How many of these lines are already imported. 1 query. */
export async function countKnownLines(db: DbOrTx, bankAccountId: number, lines: StatementLine[]): Promise<number> {
  if (!lines.length) return 0
  const keys = lineKeys(bankAccountId, lines)
  return Number((await db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM bank_statement_lines WHERE "lineKey" IN (SELECT (x)::text FROM json_array_elements_text(${J(keys)}::json) x)`)).rows[0].n)
}

/** Save a file's lines (new ones only) and the bank's columns. 1 transaction, 3 statements + audit. */
export async function importStatement(
  tx: Tx, actor: Actor, bankAccountId: number, file: { name: string; sha256: string }, cols: StatementColumns, lines: StatementLine[],
): Promise<{ importId: number; rowsRead: number; rowsNew: number }> {
  const bank = (await tx.execute<{ id: number }>(sql`SELECT id FROM bank_accounts WHERE id = ${bankAccountId} FOR UPDATE`)).rows[0]
  if (!bank) throw new Error('Bank not found. Add it in Master → Banks.')
  await tx.execute(sql`UPDATE bank_accounts SET "statementColumns" = ${J(cols)}::jsonb, "updatedAt" = now() WHERE id = ${bankAccountId}`)
  const importId = Number((await tx.execute<{ id: string }>(sql`
    INSERT INTO bank_statement_imports ("bankAccountId", "fileName", sha256, "rowsRead", "importedBy", "importedByName")
    VALUES (${bankAccountId}, ${file.name.slice(0, 200)}, ${file.sha256}, ${lines.length}, ${actor.id}, ${actor.name}) RETURNING id`)).rows[0].id)
  const keys = lineKeys(bankAccountId, lines)
  const data = lines.map((l, i) => ({ k: keys[i], d: l.txnDate, t: l.details, r: l.reference, c: l.creditPaise, b: l.debitPaise, bal: l.balancePaise, p: l.payerKey }))
  const added = data.length ? (await tx.execute<{ id: string }>(sql`
    INSERT INTO bank_statement_lines ("bankAccountId", "importId", "lineKey", "txnDate", details, reference, "creditPaise", "debitPaise", "balancePaise", "payerKey")
    SELECT ${bankAccountId}, ${importId}, x.k, x.d::date, x.t, x.r, x.c, x.b, x.bal, x.p
    FROM json_to_recordset(${J(data)}::json) AS x(k text, d text, t text, r text, c bigint, b bigint, bal bigint, p text)
    ON CONFLICT ("lineKey") DO NOTHING RETURNING id`)).rows.length : 0
  await tx.execute(sql`UPDATE bank_statement_imports SET "rowsNew" = ${added} WHERE id = ${importId}`)
  await audit(tx, { actor, action: 'bank_statement.imported', entityType: 'bank_account', entityId: bankAccountId, after: { importId, fileName: file.name, rowsRead: lines.length, rowsNew: added } })
  return { importId, rowsRead: lines.length, rowsNew: added }
}

export type LineFilter = 'review' | 'confirmed' | 'ignored' | 'out'

export interface ReviewLine {
  id: number; txnDate: string; details: string; reference: string; creditPaise: number; debitPaise: number; payerKey: string
  status: string; ignoreReason: string | null; doneByName: string
  mode: 'cheque' | 'upi' | 'bank'; chequeNo: string
  /** Payments typed on this bank that this line may be (same amount, close date, unlinked). strong = cheque no. / UTR in the line. */
  typed: Array<{ paymentId: number; receiptNo: string; retailerId: string; partyName: string; receivedOn: string; strong: boolean }>
  /** Parties this payer paid for before. exactBill = the line's amount equals one of the party's unpaid bills. */
  known: Array<{ retailerId: string; partyName: string; timesUsed: number; exactBill: boolean }>
  /** Confirmed lines: the payments it became. */
  payments: Array<{ receiptNo: string; partyName: string; amountPaise: number; status: string }>
  /** Pre-ticked: one strong typed payment, or one known payer whose amount matches an unpaid bill. */
  exact: boolean
}

/** A bank's statement lines with suggestions (up to 300, newest first). 1 query. */
export async function listStatementLines(db: DbOrTx, bankAccountId: number, filter: LineFilter = 'review'): Promise<ReviewLine[]> {
  const where = filter === 'review' ? sql`l.status = 'new' AND l."creditPaise" > 0`
    : filter === 'out' ? sql`l."debitPaise" > 0`
    : filter === 'confirmed' ? sql`l.status = 'confirmed'` : sql`l.status = 'ignored'`
  const rows = (await db.execute<Record<string, unknown>>(sql`
    SELECT l.id, l."txnDate"::text AS "txnDate", l.details, l.reference, l."creditPaise", l."debitPaise", l."payerKey", l.status, l."ignoreReason", l."doneByName",
      CASE WHEN l.status = 'new' AND l."creditPaise" > 0 THEN coalesce((SELECT json_agg(json_build_object('paymentId', p.id, 'receiptNo', p."receiptNo", 'retailerId', p."retailerId",
          'partyName', r."partyName", 'receivedOn', p."receivedOn",
          'strong', (p."chequeNo" <> '' AND (l.reference ILIKE '%' || p."chequeNo" || '%' OR l.details ILIKE '%' || p."chequeNo" || '%'))
                 OR (length(p.reference) >= 6 AND (l.reference ILIKE '%' || p.reference || '%' OR l.details ILIKE '%' || p.reference || '%'))) ORDER BY p.id)
        FROM payments p JOIN retailers r ON r.id = p."retailerId"
        WHERE p."bankAccountId" = l."bankAccountId" AND p."statementLineId" IS NULL AND p.status = 'active'
          AND p."amountPaise" = l."creditPaise" AND p."receivedOn" BETWEEN l."txnDate" - 10 AND l."txnDate" + 3), '[]') ELSE '[]' END AS typed,
      CASE WHEN l.status = 'new' AND l."payerKey" <> '' THEN coalesce((SELECT json_agg(json_build_object('retailerId', a."retailerId", 'partyName', r."partyName", 'timesUsed', a."timesUsed",
          'exactBill', EXISTS (SELECT 1 FROM party_open_items o WHERE o."retailerId" = a."retailerId" AND o.side = 'debit' AND o."openPaise" = l."creditPaise")) ORDER BY a."timesUsed" DESC)
        FROM payer_aliases a JOIN retailers r ON r.id = a."retailerId" WHERE a."payerKey" = l."payerKey"), '[]') ELSE '[]' END AS known,
      CASE WHEN l.status = 'confirmed' THEN coalesce((SELECT json_agg(json_build_object('receiptNo', p."receiptNo", 'partyName', r."partyName", 'amountPaise', p."amountPaise", 'status', p.status) ORDER BY p.id)
        FROM payments p JOIN retailers r ON r.id = p."retailerId" WHERE p."statementLineId" = l.id), '[]') ELSE '[]' END AS payments
    FROM bank_statement_lines l
    WHERE l."bankAccountId" = ${bankAccountId} AND ${where}
    ORDER BY l."txnDate" DESC, l.id DESC LIMIT 300`)).rows
  return rows.map((r) => {
    const typed = (r.typed as ReviewLine['typed']).map((t) => ({ ...t, paymentId: Number(t.paymentId), receivedOn: String(t.receivedOn).slice(0, 10), strong: Boolean(t.strong) }))
    const known = (r.known as ReviewLine['known']).map((k) => ({ ...k, timesUsed: Number(k.timesUsed), exactBill: Boolean(k.exactBill) }))
    const details = String(r.details), reference = String(r.reference)
    const strong = typed.filter((t) => t.strong)
    return {
      id: Number(r.id), txnDate: String(r.txnDate), details, reference, creditPaise: Number(r.creditPaise), debitPaise: Number(r.debitPaise),
      payerKey: String(r.payerKey), status: String(r.status), ignoreReason: (r.ignoreReason as string | null) ?? null, doneByName: String(r.doneByName ?? ''),
      mode: guessMode(details, reference), chequeNo: chequeNoOf(details, reference), typed, known,
      payments: (r.payments as ReviewLine['payments']).map((p) => ({ ...p, amountPaise: Number(p.amountPaise) })),
      exact: strong.length === 1 || (typed.length === 0 && known.length === 1 && known[0].exactBill),
    }
  })
}

export interface ConfirmItem {
  lineId: number
  /** Link these typed payments (their amounts must add up to the line). */
  link?: number[]
  /** Or make new payments: one per party (split), adding up to the line exactly. */
  splits?: Array<{ retailerId: string; amountPaise: number }>
}

/** Confirm lines: link typed payments or make new ones on the bank's slip; remember the payer. */
export async function confirmStatementLines(tx: Tx, actor: Actor, raw: unknown): Promise<{ confirmed: number; payments: number }> {
  const items = (Array.isArray(raw) ? raw : []) as ConfirmItem[]
  if (!items.length) throw new Error('Tick the lines to confirm.')
  if (items.length > 300) throw new Error('Confirm at most 300 lines at a time.')
  let made = 0
  for (const it of items) {
    const lineId = Number(it?.lineId)
    const l = (await tx.execute<{ id: string; bankAccountId: number; txnDate: string; details: string; reference: string; creditPaise: string; payerKey: string; status: string }>(sql`
      SELECT id, "bankAccountId", "txnDate"::text AS "txnDate", details, reference, "creditPaise", "payerKey", status
      FROM bank_statement_lines WHERE id = ${lineId} FOR UPDATE`)).rows[0]
    if (!l) throw new Error('A statement line was not found. Reload.')
    if (l.status !== 'new') throw new Error(`The line of ${l.txnDate} for ₹${(Number(l.creditPaise) / 100).toFixed(2)} is already ${l.status}. Reload.`)
    const credit = Number(l.creditPaise)
    if (credit <= 0) throw new Error('Money going out is not confirmed against parties.')
    const link = Array.isArray(it.link) ? it.link.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
    const splits = Array.isArray(it.splits) ? it.splits.map((s) => ({ retailerId: String(s?.retailerId ?? ''), amountPaise: Number(s?.amountPaise) })) : []
    if (!!link.length === !!splits.length) throw new Error('For each line choose the typed payment, or the party (or parties).')
    let partyIds: string[]
    if (link.length) {
      const ps = (await tx.execute<{ id: string; retailerId: string; amountPaise: string; bankAccountId: number | null; statementLineId: string | null; status: string }>(sql`
        SELECT id, "retailerId", "amountPaise", "bankAccountId", "statementLineId", status FROM payments
        WHERE id IN (SELECT (x)::bigint FROM json_array_elements_text(${J(link)}::json) x) FOR UPDATE`)).rows
      if (ps.length !== link.length) throw new Error('A typed payment was not found. Reload.')
      for (const p of ps) {
        if (p.statementLineId) throw new Error('A typed payment is already confirmed by another statement line.')
        if (p.status !== 'active') throw new Error('A typed payment was reversed. Choose the party instead.')
        if (p.bankAccountId !== l.bankAccountId) throw new Error('A typed payment is on another bank.')
      }
      if (ps.reduce((s, p) => s + Number(p.amountPaise), 0) !== credit) throw new Error('The typed payments do not add up to the statement line.')
      await tx.execute(sql`UPDATE payments SET "statementLineId" = ${lineId} WHERE id IN (SELECT (x)::bigint FROM json_array_elements_text(${J(link)}::json) x)`)
      partyIds = ps.map((p) => p.retailerId)
    } else {
      if (splits.some((s) => !s.retailerId || !Number.isInteger(s.amountPaise) || s.amountPaise <= 0)) throw new Error('Each part needs a party and an amount.')
      if (new Set(splits.map((s) => s.retailerId)).size !== splits.length) throw new Error('The same party is in a split twice.')
      if (splits.reduce((s, x) => s + x.amountPaise, 0) !== credit) throw new Error(`The parts must add up to ₹${(credit / 100).toFixed(2)}.`)
      const mode = guessMode(l.details, l.reference)
      const chequeNo = mode === 'cheque' ? chequeNoOf(l.details, l.reference) || l.reference || 'statement' : ''
      for (const s of splits) {
        await recordPayment(tx, actor, {
          clientId: randomUUID(), retailerId: s.retailerId, receivedOn: l.txnDate, mode, amountPaise: s.amountPaise,
          into: { kind: 'bank', bankAccountId: l.bankAccountId }, chequeNo, reference: mode === 'cheque' ? '' : l.reference,
          note: splits.length > 1 ? `Bank statement (part of ₹${(credit / 100).toFixed(2)})` : 'Bank statement',
        }, { statementLineId: lineId })
        made++
      }
      partyIds = splits.map((s) => s.retailerId)
    }
    // Remember the payer for these parties (next time it is suggested).
    if (l.payerKey) {
      await tx.execute(sql`
        INSERT INTO payer_aliases ("payerKey", "retailerId")
        SELECT ${l.payerKey}, x FROM json_array_elements_text(${J([...new Set(partyIds)])}::json) x
        ON CONFLICT ("payerKey", "retailerId") DO UPDATE SET "timesUsed" = payer_aliases."timesUsed" + 1, "lastUsedAt" = now()`)
    }
    await tx.execute(sql`UPDATE bank_statement_lines SET status = 'confirmed', "doneBy" = ${actor.id}, "doneByName" = ${actor.name}, "doneAt" = now() WHERE id = ${lineId}`)
  }
  await audit(tx, { actor, action: 'bank_statement.confirmed', entityType: 'bank_statement_line', entityId: items.length === 1 ? Number(items[0].lineId) : 'batch', after: { lines: items.length, newPayments: made } })
  return { confirmed: items.length, payments: made }
}

/** A line that is not a party payment (bank charge, own transfer, interest …). */
export async function ignoreStatementLine(tx: Tx, actor: Actor, lineId: number, reason: unknown): Promise<void> {
  const why = String(reason ?? '').trim().slice(0, 300)
  if (!why) throw new Error('Type why this line is not a party payment.')
  const u = await tx.execute(sql`
    UPDATE bank_statement_lines SET status = 'ignored', "ignoreReason" = ${why}, "doneBy" = ${actor.id}, "doneByName" = ${actor.name}, "doneAt" = now()
    WHERE id = ${lineId} AND status = 'new'`)
  if (!u.rowCount) throw new Error('This line is already confirmed or ignored. Reload.')
  await audit(tx, { actor, action: 'bank_statement.ignored', entityType: 'bank_statement_line', entityId: lineId, reason: why })
}
