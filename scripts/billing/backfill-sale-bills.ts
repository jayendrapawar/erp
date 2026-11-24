// Backfill frozen bill amounts (sale_bills) for bills made before migration 0017 (payments step 3).
//
//   Dry run (read-only session; changes nothing):
//     npx tsx scripts/billing/backfill-sale-bills.ts --env-file .env.local
//   Apply (DEVELOPMENT database only; one transaction per bill; audited):
//     npx tsx scripts/billing/backfill-sale-bills.ts --env-file .env.local --apply --confirm <dev endpoint>
//   Add --ledger to also post each backfilled party bill to the party ledger (default: no ledger entry).
//
// What a backfilled bill gets: its amounts worked out with the paise arithmetic (lib/billing/bill-totals.ts)
// at the rates every old bill printed (4.75 % + CGST/SGST 2.5 %, or IGST 5 % for a retailer outside the
// state), NO round-off (old bills printed none), the bill date = the day it was billed (IST), and its
// existing bill number (else the order number). source = 'backfill'.
//
// Ledger: production has not started, and the ledger starts at go-live with opening balances (owner,
// 22 Nov 2026), so bills from before go-live are NOT posted by default — the opening balance covers
// them. Production has nothing to backfill; --apply refuses the production endpoint.

import type pg from 'pg'
import { arg, connect, flag, requireWriteConfirmation, resolveTarget } from '../db/_connect'
import { billTotals } from '../../lib/bill-html'
import { bpToPct, computeBillTotals, type TaxType } from '../../lib/billing/bill-totals'

const PRODUCTION_ENDPOINT = 'ep-royal-tooth-b3ub6jie'

interface Row {
  id: number; orderNumber: string; billNo: string | null; status: string; isEmergency: boolean
  retailerId: string | null; retailerTax: TaxType | null; shopkeeperName: string; billedAt: string | null; billDate: string
  lines: Array<{ mrp: string; qty: number; pct: string }>
}

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** What the old bill printed: outside the state → IGST, everything else → CGST + SGST. */
const printedType = (t: TaxType | null): TaxType => (t === 'inter_state' ? 'inter_state' : 'intra_state')

async function load(c: pg.Client): Promise<Row[]> {
  // Billed orders with no active saved bill; retailer = the order's, else the exact name match (as billing does).
  return (await c.query<Row>(`
    SELECT o.id, o."orderNumber", o."billNo", o.status::text AS status, o."isEmergency", o."shopkeeperName", o."billedAt",
           coalesce((o."billedAt" AT TIME ZONE 'Asia/Kolkata')::date, (now() AT TIME ZONE 'Asia/Kolkata')::date)::text AS "billDate",
           r.id AS "retailerId", r."taxType" AS "retailerTax",
           coalesce((SELECT json_agg(json_build_object('mrp', b.mrp, 'qty', b.qty, 'pct', b."lineDiscPct") ORDER BY b.id)
                     FROM bill_lines b WHERE b."orderId" = o.id), '[]') AS lines
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT x.id, x."taxType" FROM retailers x
      WHERE x.id = o."retailerId" OR (o."retailerId" IS NULL AND lower(btrim(x."partyName")) = lower(btrim(o."shopkeeperName")))
      ORDER BY (x.id = o."retailerId") DESC NULLS LAST LIMIT 1
    ) r ON true
    WHERE o.status IN ('billed', 'dispatched', 'delivered')
      AND NOT EXISTS (SELECT 1 FROM sale_bills s WHERE s."orderId" = o.id AND s.status = 'active')
    ORDER BY o."billedAt" NULLS LAST, o.id`)).rows
}

async function main() {
  const apply = flag('apply'), ledger = flag('ledger')
  const t = resolveTarget()
  if (apply && t.endpoint.includes(PRODUCTION_ENDPOINT)) throw new Error('Refusing: --apply is for the development database only (production has nothing to backfill).')
  if (apply) requireWriteConfirmation(t)
  console.log(`Target ${t.endpoint} (${apply ? 'WRITE' : 'read-only session'})`)
  const c = await connect(t, { readOnly: !apply })
  try {
    const rows = await load(c)
    const already = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM sale_bills WHERE status = 'active'`)).rows[0].n)
    const noRetailer = rows.filter((r) => !r.retailerId)
    const noLines = rows.filter((r) => r.lines.length === 0)
    const mixedPct = rows.filter((r) => new Set(r.lines.map((l) => Number(l.pct))).size > 1)
    const ok = rows.filter((r) => r.retailerId && r.lines.length && !mixedPct.includes(r))

    let total = 0
    const diffs: string[] = []
    const plan = ok.map((r) => {
      const taxType = printedType(r.retailerTax)
      const n = computeBillTotals(r.lines, r.lines[0].pct, taxType, { roundOff: false })
      const old = billTotals(r.lines.map((l) => ({ artNumber: '', mrp: Number(l.mrp), qty: l.qty })), Number(r.lines[0].pct), taxType === 'inter_state' ? 'outside' : 'city')
      const oldPaise = Math.round(old.netAmt * 100)
      if (oldPaise !== n.grandTotalPaise) diffs.push(`  ${r.billNo ?? r.orderNumber}: printed ${rs(oldPaise)}, saved ${rs(n.grandTotalPaise)} (${n.grandTotalPaise - oldPaise > 0 ? '+' : ''}${n.grandTotalPaise - oldPaise} paise)`)
      total += n.grandTotalPaise
      return { r, taxType, n }
    })

    console.log(`
Bills already saved (made since migration 0017): ${already}
Older bills without saved amounts: ${rows.length}
  Direct bills ${rows.filter((r) => r.isEmergency).length}, order bills ${rows.filter((r) => !r.isEmergency).length}; with a bill no. ${rows.filter((r) => r.billNo).length}
  First billed ${rows[0]?.billedAt ?? '—'}; last ${rows.at(-1)?.billedAt ?? '—'}
Can be backfilled: ${ok.length}, total ${rs(total)} (no round-off, as printed)
  Within the state ${plan.filter((p) => p.taxType === 'intra_state').length}, outside ${plan.filter((p) => p.taxType === 'inter_state').length}${
    plan.some((p) => p.r.retailerTax === 'untaxed') ? `; ${plan.filter((p) => p.r.retailerTax === 'untaxed').length} party now marked "without GST" (saved as printed: with GST)` : ''}
${plan.slice(0, 40).map((p) => `    ${(p.r.billNo ?? p.r.orderNumber).padEnd(22)} ${p.r.billDate}  ${p.r.shopkeeperName.slice(0, 28).padEnd(28)} ${rs(p.n.grandTotalPaise)}`).join('\n')}
Cannot be backfilled:
  No retailer in the master: ${noRetailer.length}${noRetailer.length ? '\n' + noRetailer.slice(0, 15).map((r) => `    ${r.billNo ?? r.orderNumber}  "${r.shopkeeperName}"`).join('\n') : ''}
  No bill lines:      ${noLines.length}${noLines.length ? '\n' + noLines.slice(0, 15).map((r) => `    ${r.billNo ?? r.orderNumber}  ${r.status}`).join('\n') : ''}
  Mixed line discount: ${mixedPct.length}
Saved amount vs what the bill prints today: ${diffs.length} differ${diffs.length ? '\n' + diffs.slice(0, 30).join('\n') : ''}
Ledger: ${ledger ? 'each backfilled party bill is posted to the party ledger' : 'not posted (the opening balance at go-live covers bills from before) — add --ledger to post'}`)
    if (arg('json') !== undefined) console.log(JSON.stringify({ noRetailer: noRetailer.map((r) => r.id), noLines: noLines.map((r) => r.id) }))

    if (!apply) { console.log('\nDry run: nothing was changed.'); return }
    let done = 0
    for (const { r, taxType, n } of plan) {
      await c.query('BEGIN')
      try {
        const billNo = r.billNo ?? r.orderNumber
        const ins = await c.query<{ id: string }>(`
          INSERT INTO sale_bills ("orderId", "retailerId", "customerName", "customerPhone", "paidMode", "billNo", "billDate", source, "taxType",
            "totalQty", "lineDiscPct", "grossPaise", "discountPct", "discountPaise", "taxablePaise",
            "cgstPct", "cgstPaise", "sgstPct", "sgstPaise", "igstPct", "igstPaise", "roundOffPaise", "grandTotalPaise", "createdBy", "createdByName")
          SELECT $1, $2, '', '', NULL, $3, $4::date, 'backfill', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NULL, 'backfill script'
          WHERE NOT EXISTS (SELECT 1 FROM sale_bills WHERE "orderId" = $1 AND status = 'active')
          RETURNING id`,
          [r.id, r.retailerId, billNo, r.billDate, taxType, n.totalQty, r.lines[0].pct, n.grossPaise, bpToPct(n.discountBp), n.discountPaise, n.taxablePaise,
            bpToPct(n.cgstBp), n.cgstPaise, bpToPct(n.sgstBp), n.sgstPaise, bpToPct(n.igstBp), n.igstPaise, n.roundOffPaise, n.grandTotalPaise])
        const id = ins.rows[0]?.id
        if (id && ledger) {
          await c.query(`
            INSERT INTO party_ledger_entries ("retailerId", kind, "amountPaise", "entryDate", "saleBillId", "refNo", "idempotencyKey", "createdBy", "createdByName")
            VALUES ($1, 'bill', $2, $3::date, $4, $5, 'sale_bill:' || $4, NULL, 'backfill script')`, [r.retailerId, n.grandTotalPaise, r.billDate, id, billNo])
        }
        if (id) {
          await c.query(`INSERT INTO audit_events ("actorName", action, "entityType", "entityId", after)
            VALUES ('backfill script', 'sale_bill.backfilled', 'order', $1, $2::jsonb)`,
            [String(r.id), JSON.stringify({ saleBillId: Number(id), billNo, taxType, grandTotalPaise: n.grandTotalPaise, ledger })])
          done++
        }
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK')
        throw new Error(`Bill ${r.billNo ?? r.orderNumber}: ${e instanceof Error ? e.message : e}`)
      }
    }
    const mism = (await c.query<{ n: string }>(`SELECT (SELECT count(*) FROM party_balance_mismatches) + (SELECT count(*) FROM party_open_item_mismatches) AS n`)).rows[0].n
    console.log(`\nApplied: ${done} bills saved${ledger ? ' and posted' : ''}. Ledger mismatches: ${mism}.`)
  } finally {
    await c.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
