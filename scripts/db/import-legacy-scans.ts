// Import the old merged scan rows (legacy_scans) into scan_events + the stock ledger.
//
//   npx tsx scripts/db/import-legacy-scans.ts --env-file .env.local            (dry run: report only)
//   npx tsx scripts/db/import-legacy-scans.ts --env-file .env.local --apply --confirm <endpoint>
//
// - One scan event per recorded box code (old rows merged many boxes into one row).
// - Manual rows become one manual entry with their quantity (posted as UNSCANNED stock).
// - Event ids are derived from the legacy row id, so re-running never imports twice.
// - The original user is matched by display name; unmatched names are kept as text.
// - Rows whose quantity does not equal their number of box codes are REPORTED, not
//   "fixed": the old app let quantities be edited freely, so the right number needs a person.
// - legacy_scans itself is never modified.

import crypto from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../../lib/db/schema'
import type { Actor, Db } from '../../lib/db/types'
import { recordBoxScan, recordManualEntry } from '../../lib/inventory/scan-service'
import { audit } from '../../lib/audit'
import { flag, log, requireWriteConfirmation, resolveTarget } from './_connect'

function legacyUuid(...parts: Array<string | number>): string {
  const h = crypto.createHash('md5').update(`legacy:${parts.join(':')}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function flagFrom(notes: string | null): { flag: string | null; notes: string | null } {
  const m = notes?.match(/\[Flag:\s*([^\]]+)\]/)
  return { flag: m?.[1].trim() ?? null, notes: notes?.replace(/\[Flag:[^\]]*\]/, '').trim() || null }
}

async function main() {
  const t = resolveTarget()
  const apply = flag('apply')
  if (apply) requireWriteConfirmation(t)
  const pool = new pg.Pool({ connectionString: t.url, ssl: { rejectUnauthorized: false }, max: 2 })
  const db = drizzle(pool, { schema }) as unknown as Db
  try {
    const rows = await db.select().from(schema.legacyScans).orderBy(schema.legacyScans.id)
    const users = await db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user)
    const byName = new Map<string, string | null>()
    for (const u of users) {
      const k = (u.name ?? '').trim().toLowerCase()
      byName.set(k, byName.has(k) ? null : u.id) // ambiguous names map to null
    }

    const totals = { rows: rows.length, legacyQty: 0, boxEvents: 0, manualEvents: 0, saved: 0, replayed: 0, duplicates: 0, rejected: 0, missingArticle: 0, qtyMismatch: 0 }
    const problems: string[] = []
    log(`${apply ? 'Importing' : 'Dry run for'} ${rows.length} legacy scan rows from ${t.endpoint}`)

    for (const r of rows) {
      totals.legacyQty += r.quantity
      const name = r.scannedByName ?? ''
      const actor: Actor = { id: byName.get(name.trim().toLowerCase()) ?? null, name }
      const { flag: fl, notes } = flagFrom(r.notes)

      if (r.entryType === 'manual') {
        totals.manualEvents++
        if (!apply) continue
        const res = await recordManualEntry(db, actor, {
          clientEventId: legacyUuid(r.id, 'manual'), source: 'legacy_import', legacyScanId: r.id, createdAt: r.scannedAt,
          articleCode: r.artNumber ?? '', colourCode: r.colorNumber ?? '', sizeLabel: r.sizeNumber ?? '', quantity: r.quantity,
          mrp: r.mrp ? Number(r.mrp) : null, mfgMonth: r.mfgMonth, mfgYear: r.mfgYear, notes, flag: fl,
        })
        if (res.replay) totals.replayed++; else totals.saved++
        if (res.event.resolution !== 'resolved') totals.missingArticle++
        continue
      }

      const codes = Array.isArray(r.boxCodes) && r.boxCodes.length ? (r.boxCodes as string[]) : r.rawQrCode ? [r.rawQrCode] : []
      if (codes.length !== r.quantity) {
        totals.qtyMismatch++
        problems.push(`legacy row ${r.id}: quantity ${r.quantity} but ${codes.length} box code(s) — imported the box codes only; review the difference`)
      }
      for (let i = 0; i < codes.length; i++) {
        totals.boxEvents++
        if (!apply) continue
        const res = await recordBoxScan(db, actor, {
          clientEventId: legacyUuid(r.id, i), rawInput: codes[i], source: 'legacy_import', legacyScanId: r.id, createdAt: r.scannedAt, flag: fl, notes,
        })
        if (res.status === 'saved') {
          if (res.replay) totals.replayed++; else totals.saved++
          if (res.event.resolution !== 'resolved') totals.missingArticle++
        } else if (res.status === 'duplicate') {
          totals.duplicates++
          problems.push(`legacy row ${r.id}: box ${codes[i]} duplicates scan event ${res.original.id}`)
        } else {
          totals.rejected++
          problems.push(`legacy row ${r.id}: box ${codes[i]} rejected (${res.reason}: ${res.message})`)
        }
      }
    }

    if (apply && (problems.length || totals.saved)) {
      await audit(db, { actor: null, action: 'legacy.scans_imported', entityType: 'legacy_scans', entityId: 'all', after: totals, metadata: { problems } })
    }
    log(JSON.stringify(totals, null, 2))
    for (const p of problems) log(`  ! ${p}`)
    if (apply) {
      const check = await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM stock_balance_mismatches`)
      log(`Ledger/balance mismatches after import: ${check.rows[0].n}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
