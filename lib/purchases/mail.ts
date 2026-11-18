// Purchase bills by mail (server only). Reads Relaxo's bill mails from the shop's mailbox (IMAP,
// read-only: nothing is moved, flagged or deleted) and imports each attached PDF like an upload.
//
// Settings (env): BILL_MAIL_IMAP_HOST, BILL_MAIL_USER, BILL_MAIL_PASSWORD (Yahoo app password),
// BILL_MAIL_FROM, and BILL_MAIL_START (yyyy-mm-dd). Without BILL_MAIL_START, Check mail is OFF; mails
// before it are never imported. Owner (19 Nov 2026): on the live site it is set only once the
// stocktake of the whole warehouse is complete, on the owner's word. Every mail looked at is recorded in bill_mail_messages, so it is imported once;
// mails that failed are tried again next time. Run on demand ("Check mail"); no polling.

import { ImapFlow, type MessageStructureObject } from 'imapflow'
import { sql } from 'drizzle-orm'
import type { Actor, Db } from '@/lib/db/types'
import { importBillPdf, type ImportFileResult } from './import-pdf'

export const MAILBOXES = ['INBOX', 'Relaxo']
/** Mails per check: keeps one check well inside a serverless time limit. Press again for more. */
export const MAX_MAILS_PER_CHECK = 15
export const DEFAULT_LOOKBACK_DAYS = 7

export interface MailCheckResult {
  since: string
  found: number
  alreadyDone: number
  processed: number
  remaining: number
  files: (ImportFileResult & { mailbox: string; subject: string; receivedAt: string })[]
}

function settings() {
  const host = process.env.BILL_MAIL_IMAP_HOST || 'imap.mail.yahoo.com'
  const user = process.env.BILL_MAIL_USER
  const pass = process.env.BILL_MAIL_PASSWORD
  const from = process.env.BILL_MAIL_FROM
  if (!user || !pass || !from) throw new Error('Bill mail is not set up (BILL_MAIL_USER, BILL_MAIL_PASSWORD, BILL_MAIL_FROM).')
  const start = mailStartDate()
  if (!start) throw new Error('Reading bills from mail is not switched on yet (it starts after the warehouse stocktake).')
  return { host, user, pass, from, start }
}

/** The first day mails are imported from (BILL_MAIL_START), or null while mail import is off. */
export function mailStartDate(env: Record<string, string | undefined> = process.env): Date | null {
  const s = (env.BILL_MAIL_START ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+05:30`) : null
}

function pdfParts(node: MessageStructureObject | undefined, out: { part: string; name: string; encoding: string }[] = []) {
  if (!node) return out
  for (const c of node.childNodes ?? []) pdfParts(c, out)
  const name = node.dispositionParameters?.filename || node.parameters?.name || ''
  if (node.part && (node.type === 'application/pdf' || /\.pdf$/i.test(name))) out.push({ part: node.part, name: name || `bill-${node.part}.pdf`, encoding: (node.encoding ?? '').toLowerCase() })
  return out
}

/**
 * The whole attachment in one request, decoded. (Chunked downloads from Yahoo sometimes came back
 * cut short — 48 KB of a 519 KB PDF — so they are not used.)
 */
async function fetchPart(client: ImapFlow, uid: number, part: { part: string; encoding: string }): Promise<Uint8Array> {
  const msg = await client.fetchOne(String(uid), { bodyParts: [part.part] }, { uid: true })
  const raw = msg && msg.bodyParts ? msg.bodyParts.get(part.part) : undefined
  if (!raw) throw new Error('Attachment could not be downloaded.')
  if (part.encoding === 'base64') return new Uint8Array(Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'))
  return new Uint8Array(raw)
}

/**
 * Check the mailbox. `since` (yyyy-mm-dd) overrides the default: one day before the newest mail
 * already recorded, or the last 7 days the first time. Mails that failed before are always retried.
 */
export async function checkBillMail(db: Db, actor: Actor, opts: { since?: string } = {}): Promise<MailCheckResult> {
  const cfg = settings()
  let since: Date
  if (opts.since && /^\d{4}-\d{2}-\d{2}$/.test(opts.since)) since = new Date(`${opts.since}T00:00:00+05:30`)
  else {
    // One day before the newest mail seen (mails that failed are retried by their own id below).
    const r = await db.execute<{ last: string | null }>(sql`SELECT max("receivedAt") AS last FROM bill_mail_messages`)
    const last = r.rows[0]?.last
    since = last ? new Date(new Date(last).getTime() - 86_400_000) : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000)
  }
  if (since < cfg.start) since = cfg.start // never before the start date

  const client = new ImapFlow({ host: cfg.host, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false })
  const result: MailCheckResult = { since: since.toISOString(), found: 0, alreadyDone: 0, processed: 0, remaining: 0, files: [] }
  try {
    await client.connect()
  } catch (e) {
    throw new Error(`Could not sign in to the mailbox (${(e as { responseText?: string }).responseText ?? (e as Error).message}). Check the app password.`)
  }
  try {
    const existing = new Set((await client.list()).map((b) => b.path))
    for (const mailbox of MAILBOXES.filter((m) => existing.has(m))) {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true })
      try {
        const uidValidity = Number(client.mailbox && client.mailbox.uidValidity)
        const found = (await client.search({ from: cfg.from, since }, { uid: true })) || []
        // Mails that failed before are retried even when they are older than the window.
        const failed = await db.execute<{ uid: string }>(sql`
          SELECT uid::text FROM bill_mail_messages WHERE mailbox = ${mailbox} AND "uidValidity" = ${uidValidity} AND status = 'error'
            AND "receivedAt" >= ${cfg.start.toISOString()}`)
        const uids = [...new Set([...found, ...failed.rows.map((x) => Number(x.uid))])]
        result.found += found.length
        if (!uids.length) continue
        const done = await db.execute<{ uid: string }>(sql`
          SELECT uid::text FROM bill_mail_messages
          WHERE mailbox = ${mailbox} AND "uidValidity" = ${uidValidity} AND status <> 'error'
            AND uid IN (SELECT json_array_elements_text(${JSON.stringify(uids)}::json)::bigint)`)
        const skip = new Set(done.rows.map((r) => Number(r.uid)))
        result.alreadyDone += skip.size
        const todo = uids.filter((u) => !skip.has(u)).sort((a, b) => a - b)
        const room = MAX_MAILS_PER_CHECK - result.processed
        result.remaining += Math.max(0, todo.length - room)
        for (const uid of todo.slice(0, Math.max(0, room))) {
          const msg = await client.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true }, { uid: true })
          if (!msg) continue
          const subject = (msg.envelope?.subject ?? '').slice(0, 300)
          const receivedAt = new Date(msg.internalDate ?? Date.now()).toISOString()
          const parts = pdfParts(msg.bodyStructure)
          const billIds: number[] = []
          const errors: string[] = []
          let status: 'imported' | 'duplicate' | 'no_pdf' | 'error' = parts.length ? 'duplicate' : 'no_pdf'
          for (const p of parts) {
            const file = await importBillPdf(db, actor, { name: p.name, bytes: await fetchPart(client, uid, p), source: 'mail' })
            result.files.push({ ...file, mailbox, subject, receivedAt })
            if (file.billId) billIds.push(file.billId)
            if (file.status === 'saved') status = 'imported'
            if (file.status === 'error') { errors.push(...(file.errors ?? [])); if (status !== 'imported') status = 'error' }
          }
          await db.execute(sql`
            INSERT INTO bill_mail_messages (mailbox, "uidValidity", uid, "messageId", subject, "receivedAt", status, "billIds", detail)
            VALUES (${mailbox}, ${uidValidity}, ${uid}, ${msg.envelope?.messageId ?? null}, ${subject}, ${receivedAt}, ${status},
                    (SELECT coalesce(array_agg(x::int), '{}') FROM json_array_elements_text(${JSON.stringify(billIds)}::json) x), ${errors.join(' ').slice(0, 1000) || null})
            ON CONFLICT (mailbox, "uidValidity", uid) DO UPDATE SET status = excluded.status, "billIds" = excluded."billIds", detail = excluded.detail, "checkedAt" = now()`)
          result.processed++
        }
      } finally {
        lock.release()
      }
    }
  } finally {
    await client.logout().catch(() => {})
  }
  return result
}
