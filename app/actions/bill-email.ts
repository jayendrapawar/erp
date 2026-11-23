'use server'

// Bills by email (owner, 21 Nov 2026). Sender set by an admin (Master → Bill template); bills sent
// from Biller → Receipts → Mail as PDF attachments. Query counts are noted per action.

import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requireAnyRole, requirePermission } from '@/lib/authz'
import { audit } from '@/lib/audit'
import { SETTING_BILL_EMAIL_SENDER, getSenderInfo, saveSender, sendMail, senderFromSetting, type SenderInfo } from '@/lib/bill-email'
import { SETTING_BILL_TEMPLATE, normalizeBillTemplate, type BillTemplate } from '@/lib/bill-template'
import { buildBillPdf } from '@/lib/bill-pdf'
import type { MrpLine } from '@/lib/bill-html'
import { SALE_BILL_AMOUNT_COLUMNS, amountsFromLines, amountsFromRow, rupees, type SaleBillAmountRow } from '@/lib/billing/bill-amounts'
import { parseEmailList } from '@/lib/email-address'

const MAX_BILLS = 20
const BILLED = ['billed', 'dispatched', 'delivered']

/** Master → Bill template: sender shown (no password). 1 query. */
export async function getBillEmailSetup(): Promise<SenderInfo> {
  await requirePermission('settings.bill')
  return getSenderInfo(db)
}

/** Save the sender (blank password keeps the saved one). 1 transaction. */
export async function saveBillEmailSender(email: string, password: string): Promise<SenderInfo> {
  const u = await requirePermission('settings.bill')
  await saveSender(db, { id: u.id, name: u.name }, email, password)
  return getSenderInfo(db)
}

async function loadSettings(): Promise<{ template: BillTemplate; sender: ReturnType<typeof senderFromSetting> | null; senderError: string | null }> {
  const r = await db.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM app_settings WHERE key IN (${SETTING_BILL_TEMPLATE}, ${SETTING_BILL_EMAIL_SENDER})`)
  const get = (k: string) => r.rows.find((x) => x.key === k)?.value
  const template = normalizeBillTemplate(get(SETTING_BILL_TEMPLATE) as BillTemplate | undefined)
  try {
    return { template, sender: senderFromSetting(get(SETTING_BILL_EMAIL_SENDER) as never), senderError: null }
  } catch (e) {
    return { template, sender: null, senderError: e instanceof Error ? e.message : 'Bill email is not set up.' }
  }
}

/** "Send test": a short email from the sender to `to`. 1 query + Gmail. */
export async function sendBillEmailTest(to: string): Promise<{ sentTo: string[] }> {
  const u = await requirePermission('settings.bill')
  const { ok, bad } = parseEmailList(to)
  if (bad.length || ok.length === 0) throw new Error('Enter a valid email address to send the test to.')
  const { template, sender, senderError } = await loadSettings()
  if (!sender) throw new Error(senderError ?? 'Bill email is not set up.')
  await sendMail(sender, {
    to: ok, fromName: template.shopName, subject: `Test email — ${template.shopName}`,
    text: `This is a test from the Shayona app. Bills will be sent from ${sender.email}.\n\nSent by ${u.name}.`,
    html: `<p>This is a test from the Shayona app. Bills will be sent from <b>${escapeHtml(sender.email)}</b>.</p><p>Sent by ${escapeHtml(u.name)}.</p>`,
  })
  return { sentTo: ok }
}

export interface MailDefaults { suggestedTo: string; retailers: Array<{ name: string; email: string }>; senderEmail: string; ready: boolean; problem: string | null }

/** Mail dialog: the retailers' saved emails and whether sending is set up. 2 queries in parallel. */
export async function getBillMailDefaults(orderIds: number[]): Promise<MailDefaults> {
  await requireAnyRole('biller', 'admin', 'accountant')
  const ids = cleanIds(orderIds)
  const [rows, info] = await Promise.all([
    db.execute<{ name: string; email: string }>(sql`
      SELECT DISTINCT coalesce(r."partyName", o."shopkeeperName") AS name, coalesce(r.email, '') AS email
      FROM orders o LEFT JOIN retailers r ON r.id = o."retailerId"
      WHERE o.id IN (SELECT (x)::int FROM json_array_elements_text(${JSON.stringify(ids)}::json) x)`),
    getSenderInfo(db),
  ])
  const emails = [...new Set(rows.rows.map((x) => x.email).filter(Boolean))]
  const ready = Boolean(info.email && info.hasPassword)
  return {
    suggestedTo: rows.rows.length === 1 ? emails.join(', ') : '',
    retailers: rows.rows,
    senderEmail: info.email,
    ready,
    problem: ready ? null : 'Bill email is not set up yet. An admin adds the sender Gmail in Master → Bill template.',
  }
}

/**
 * Send the selected bills (one PDF each) to `to`. Optionally remember the address on the retailer
 * (only when all bills are for one retailer). Queries: settings 1 + bills 1 + remember 0–1 + audit 1.
 */
export async function mailBills(input: { orderIds: number[]; to: string; remember: boolean }): Promise<{ sentTo: string[]; bills: number }> {
  const u = await requireAnyRole('biller', 'admin', 'accountant')
  const ids = cleanIds(input.orderIds)
  if (ids.length === 0) throw new Error('Select the bills to send.')
  if (ids.length > MAX_BILLS) throw new Error(`Send at most ${MAX_BILLS} bills in one email.`)
  const { ok: to, bad } = parseEmailList(input.to)
  if (bad.length) throw new Error(`Not an email address: ${bad.join(', ')}`)
  if (to.length === 0) throw new Error('Enter the receiver\'s email address.')
  if (to.length > 5) throw new Error('Send to at most 5 addresses at once.')

  const [{ template, sender, senderError }, billRows] = await Promise.all([
    loadSettings(),
    db.execute<{ id: number; orderNumber: string; billNo: string | null; shopkeeperName: string; shopkeeperPhone: string | null; shopkeeperAddress: string | null; billedAt: string | null; status: string; retailerId: string | null; amounts: SaleBillAmountRow | null; lines: Array<{ artNumber: string; mrp: string; qty: number; disc: string; hsn: string | null }> }>(sql`
      SELECT o.id, o."orderNumber", o."billNo", o."shopkeeperName", o."shopkeeperPhone", o."shopkeeperAddress", o."billedAt", o.status, o."retailerId",
             (SELECT row_to_json(x) FROM (SELECT ${sql.raw(SALE_BILL_AMOUNT_COLUMNS)} FROM sale_bills sb WHERE sb."orderId" = o.id AND sb.status = 'active' LIMIT 1) x) AS amounts,
             coalesce(json_agg(json_build_object('artNumber', b."artNumber", 'mrp', b.mrp, 'qty', b.qty, 'disc', b."lineDiscPct",
               'hsn', coalesce(b.hsn, (SELECT a.hsn FROM articles a WHERE a.hsn <> '' AND upper(btrim(a."artCode")) = upper(btrim(b."artNumber")) LIMIT 1))) ORDER BY b.id)
                      FILTER (WHERE b.id IS NOT NULL), '[]') AS lines
      FROM orders o LEFT JOIN bill_lines b ON b."orderId" = o.id
      WHERE o.id IN (SELECT (x)::int FROM json_array_elements_text(${JSON.stringify(ids)}::json) x)
      GROUP BY o.id ORDER BY o."billedAt" NULLS LAST, o.id`),
  ])
  if (!sender) throw new Error(senderError ?? 'Bill email is not set up.')
  const bills = billRows.rows
  const missing = ids.filter((id) => !bills.some((b) => b.id === id))
  if (missing.length) throw new Error('Some bills were not found. Refresh and try again.')
  const notBilled = bills.filter((b) => !BILLED.includes(b.status))
  if (notBilled.length) throw new Error(`Not billed yet: ${notBilled.map((b) => b.orderNumber).join(', ')}`)
  const empty = bills.filter((b) => b.lines.length === 0)
  if (empty.length) throw new Error(`No bill lines saved for ${empty.map((b) => b.orderNumber).join(', ')}`)

  const prepared = await Promise.all(bills.map(async (b) => {
    const lines: MrpLine[] = b.lines.map((l) => ({ artNumber: l.artNumber, mrp: Number(l.mrp), qty: Number(l.qty), hsn: l.hsn }))
    const disc = Number(b.lines[0]?.disc ?? 30)
    const amounts = b.amounts ? amountsFromRow(b.amounts) : amountsFromLines(lines, disc, 'intra_state')
    const pdf = await buildBillPdf({
      vendor: { name: b.shopkeeperName, phone: b.shopkeeperPhone, address: b.shopkeeperAddress },
      order: { orderNumber: b.billNo || b.orderNumber, billedAt: b.billedAt }, lines, lineDiscPct: disc, template, amounts,
    })
    return { b, no: b.billNo || b.orderNumber, pdf, pairs: amounts.totalQty, net: rupees(amounts.grandTotalPaise) }
  }))

  const one = prepared.length === 1
  const party = one ? prepared[0].b.shopkeeperName : `${new Set(prepared.map((x) => x.b.shopkeeperName)).size === 1 ? prepared[0].b.shopkeeperName : 'your shop'}`
  const subject = one ? `Bill ${prepared[0].no} — ${template.shopName}` : `${prepared.length} bills — ${template.shopName}`
  const inr = (n: number) => `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '')
  const listText = prepared.map((x) => `- Bill ${x.no}, ${date(x.b.billedAt)}: ${x.pairs} pairs, ${inr(x.net)}`).join('\n')
  const listHtml = prepared.map((x) => `<tr><td style="padding:4px 12px 4px 0">Bill ${escapeHtml(x.no)}</td><td style="padding:4px 12px 4px 0">${escapeHtml(date(x.b.billedAt))}</td><td style="padding:4px 12px 4px 0;text-align:right">${x.pairs} pairs</td><td style="padding:4px 0;text-align:right"><b>${escapeHtml(inr(x.net))}</b></td></tr>`).join('')
  const contact = [template.phone && `Ph ${template.phone}`, template.email].filter(Boolean).join(' · ')

  await sendMail(sender, {
    to, fromName: template.shopName, subject,
    text: `Dear ${party},\n\nPlease find attached ${one ? 'your bill' : 'your bills'}:\n${listText}\n\nRegards,\n${template.shopName}${contact ? `\n${contact}` : ''}`,
    html: `<p>Dear ${escapeHtml(party)},</p><p>Please find attached ${one ? 'your bill' : 'your bills'}:</p><table style="border-collapse:collapse;font-size:14px">${listHtml}</table><p>Regards,<br><b>${escapeHtml(template.shopName)}</b>${contact ? `<br>${escapeHtml(contact)}` : ''}</p>`,
    attachments: prepared.map((x) => ({ filename: `Bill-${x.no.replace(/[^A-Za-z0-9-]/g, '')}.pdf`, content: Buffer.from(x.pdf), contentType: 'application/pdf' })),
  })

  // Remember the address for next time (one retailer only), then record the send.
  const retailerIds = [...new Set(bills.map((b) => b.retailerId))]
  const rememberId = input.remember && retailerIds.length === 1 && retailerIds[0] ? retailerIds[0] : null
  if (rememberId) await db.execute(sql`UPDATE retailers SET email = ${to.join(', ')}, "updatedAt" = now() WHERE id = ${rememberId}`)
  await audit(db, {
    actor: { id: u.id, name: u.name }, action: 'bill.emailed', entityType: 'order', entityId: bills.map((b) => b.id).join(','),
    after: { to, from: sender.email, bills: bills.map((b) => b.billNo || b.orderNumber), rememberedOn: rememberId },
  })
  return { sentTo: to, bills: bills.length }
}

function cleanIds(ids: number[]): number[] {
  return [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
