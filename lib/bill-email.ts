// Bills by email (owner, 21 Nov 2026): the shop's Gmail sends bill PDFs to retailers.
// Sender = an app setting {email, password: sealed}; the Gmail "app password" is encrypted
// (lib/secret-box.ts) and never sent to the browser or written to the audit log. Server only.

import nodemailer from 'nodemailer'
import { sql } from 'drizzle-orm'
import type { Actor, Db, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { openSecret, sealSecret } from '@/lib/secret-box'
import { isEmail } from '@/lib/email-address'

export const SETTING_BILL_EMAIL_SENDER = 'billEmail.sender'

interface StoredSender { email: string; password: string }
export interface SenderInfo { email: string; hasPassword: boolean; updatedByName: string | null; updatedAt: string | null }

/** Sender as shown on screen (no password). 1 query. */
export async function getSenderInfo(db: DbOrTx): Promise<SenderInfo> {
  const r = await db.execute<{ value: StoredSender; updatedByName: string; updatedAt: string }>(sql`
    SELECT value, "updatedByName", "updatedAt" FROM app_settings WHERE key = ${SETTING_BILL_EMAIL_SENDER}`)
  const x = r.rows[0]
  return {
    email: x?.value?.email ?? '',
    hasPassword: Boolean(x?.value?.password),
    updatedByName: x?.updatedByName ?? null,
    updatedAt: x ? new Date(x.updatedAt).toISOString() : null,
  }
}

/** Sender with the opened password, for sending. Throws a plain message when not set up. */
export function senderFromSetting(value: StoredSender | null | undefined): { email: string; password: string } {
  if (!value?.email || !value.password) throw new Error('Bill email is not set up yet. An admin adds the sender Gmail in Master → Bill template.')
  const password = openSecret(value.password)
  if (!password) throw new Error('The saved Gmail app password cannot be read (the app secret changed). Enter it again in Master → Bill template.')
  return { email: value.email, password }
}

/**
 * Save the sender. A blank password keeps the saved one (only the email changes). Audited without
 * the password. 1 transaction.
 */
export async function saveSender(db: Db, actor: Actor, email: string, password: string): Promise<void> {
  const e = email.trim().toLowerCase()
  if (!isEmail(e)) throw new Error('Enter the sender email address (e.g. shayonafootwear11@gmail.com).')
  const p = password.replace(/\s+/g, '')
  if (p && p.length < 16) throw new Error('A Gmail app password has 16 letters (spaces do not matter).')
  await db.transaction(async (tx) => {
    const r = await tx.execute<{ value: StoredSender }>(sql`SELECT value FROM app_settings WHERE key = ${SETTING_BILL_EMAIL_SENDER} FOR UPDATE`)
    const before = r.rows[0]?.value
    const sealed = p ? sealSecret(p) : before?.password
    if (!sealed) throw new Error('Enter the Gmail app password.')
    const value: StoredSender = { email: e, password: sealed }
    await tx.execute(sql`
      INSERT INTO app_settings (key, value, "updatedBy", "updatedByName", "updatedAt")
      VALUES (${SETTING_BILL_EMAIL_SENDER}, ${JSON.stringify(value)}::jsonb, ${actor.id}, ${actor.name}, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedBy" = excluded."updatedBy", "updatedByName" = excluded."updatedByName", "updatedAt" = now()`)
    await audit(tx, {
      actor, action: 'setting.changed', entityType: 'app_setting', entityId: SETTING_BILL_EMAIL_SENDER,
      before: before ? { email: before.email, password: '(hidden)' } : null,
      after: { email: e, password: p ? '(new, hidden)' : '(unchanged)' },
    })
  })
}

/** Gmail SMTP (TLS, port 465). Explains the usual Google refusals in plain words. */
export async function sendMail(sender: { email: string; password: string }, msg: {
  to: string[]; subject: string; text: string; html: string; fromName: string
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>
}): Promise<void> {
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: sender.email, pass: sender.password },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  })
  try {
    await transport.sendMail({
      from: { name: msg.fromName, address: sender.email },
      to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, attachments: msg.attachments,
    })
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (/535|Username and Password not accepted|BadCredentials|Invalid login/i.test(m)) {
      throw new Error('Gmail refused the sign-in. Check the sender address and use a Gmail App Password (Google account → Security → 2-Step Verification → App passwords), not the normal password.')
    }
    if (/Daily user sending limit|550 5\.4\.5|quota/i.test(m)) throw new Error('Gmail\'s daily sending limit is reached for this account. Try again tomorrow.')
    throw new Error(`Email not sent: ${m.slice(0, 200)}`)
  } finally {
    transport.close()
  }
}
