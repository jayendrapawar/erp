/**
 * Warehouse Scanner: the godown stocktake and racks (owner, 26 Nov 2026; migrations 0021, 0022).
 *
 *  - The godown has no fixed areas: loose pairs, open cartons and sealed cartons are mixed. So there
 *    is ONE open stocktake; everyone scanning joins it. It starts by itself when the scanner opens and
 *    none is open (unique index: one open at a time). Admin / supervisor (scan.void.any) finish it.
 *  - Racks are an optional list kept by admin and supervisor (racks.manage). Never deleted: switched
 *    off. A scan may carry a rack / area name (flag); none is needed.
 *  - Every scan, manual entry and counted carton carries the stocktake. Scans saved offline while it
 *    was open still join it when they sync. Old per-rack counts (0021) keep their rack.
 *
 * Totals per stocktake are aggregated in SQL (indexes on "sessionId"); nothing is cached.
 */

import { sql } from 'drizzle-orm'
import type { Actor, Db, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'

const J = (v: unknown) => JSON.stringify(v)

export class SessionError extends Error {}

export type Rack = { id: number; name: string; active: boolean; sortOrder: number }

export interface SessionTotals {
  /** Every pair counted: boxes + manual pairs + carton pairs. */
  pairs: number
  boxes: number
  manualPairs: number
  cartons: number
  cartonPairs: number
  /** Box / manual entries whose article or size is not in the master (no stock yet). */
  missing: number
  people: number
}

export interface SessionInfo {
  /** Old per-rack counts only; the godown stocktake has none. */
  id: number; rackId: number | null; rackName: string | null; status: 'open' | 'finished'
  startedByName: string; startedBy: string | null; startedAt: string
  finishedAt: string | null; finishedByName: string | null
  totals: SessionTotals
}

const EMPTY: SessionTotals = { pairs: 0, boxes: 0, manualPairs: 0, cartons: 0, cartonPairs: 0, missing: 0, people: 0 }

/**
 * The stocktake stamped on a scan (inside the caller's transaction). `flag` is the rack of an old
 * per-rack count, else null (the scan's own optional area is used).
 */
export async function sessionStamp(db: DbOrTx, sessionId: number | null | undefined): Promise<{ sessionId: number; flag: string | null } | null> {
  if (!sessionId || !Number.isInteger(sessionId)) return null
  const r = await db.execute<{ id: number; name: string | null }>(sql`
    SELECT s.id, r.name FROM stocktake_sessions s LEFT JOIN racks r ON r.id = s."rackId" WHERE s.id = ${sessionId}`)
  const row = r.rows[0]
  return row ? { sessionId: Number(row.id), flag: row.name ?? null } : null
}

/** The open stocktake's id, or null. One statement. */
export async function openStocktakeId(db: DbOrTx): Promise<number | null> {
  const r = await db.execute<{ id: number }>(sql`SELECT id FROM stocktake_sessions WHERE status = 'open' LIMIT 1`)
  return r.rows[0] ? Number(r.rows[0].id) : null
}

// ── Racks ────────────────────────────────────────────────────────────────────

export async function listRacks(db: DbOrTx, opts: { all?: boolean } = {}): Promise<Rack[]> {
  const r = await db.execute<Rack>(sql`
    SELECT id, name, active, "sortOrder" FROM racks ${opts.all ? sql`` : sql`WHERE active`} ORDER BY "sortOrder", lower(name)`)
  return r.rows.map((x) => ({ id: Number(x.id), name: String(x.name), active: Boolean(x.active), sortOrder: Number(x.sortOrder) }))
}

/** Add a rack, or rename / switch one on or off. One transaction. */
export async function saveRack(db: Db, actor: Actor, input: { id?: number | null; name: string; active?: boolean }): Promise<Rack> {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ')
  if (!name) throw new SessionError('Write the rack name.')
  if (name.length > 50) throw new SessionError('Rack name is too long (50 letters at most).')
  return db.transaction(async (tx) => {
    const clash = await tx.execute<{ id: number }>(sql`SELECT id FROM racks WHERE lower(btrim(name)) = lower(${name}) AND id <> ${input.id ?? -1} LIMIT 1`)
    if (clash.rows[0]) throw new SessionError(`There is already a rack called "${name}".`)
    if (input.id) {
      const before = await tx.execute<Rack>(sql`SELECT id, name, active, "sortOrder" FROM racks WHERE id = ${input.id} FOR UPDATE`)
      if (!before.rows[0]) throw new SessionError('Rack not found.')
      const r = await tx.execute<Rack>(sql`
        UPDATE racks SET name = ${name}, active = ${input.active ?? before.rows[0].active}, "updatedAt" = now()
         WHERE id = ${input.id} RETURNING id, name, active, "sortOrder"`)
      await audit(tx, { actor, action: 'rack.updated', entityType: 'rack', entityId: input.id, before: before.rows[0], after: r.rows[0] })
      return toRack(r.rows[0])
    }
    const r = await tx.execute<Rack>(sql`
      INSERT INTO racks (name, "sortOrder", "createdBy") VALUES (${name}, (SELECT coalesce(max("sortOrder"), 0) + 1 FROM racks), ${actor.id})
      RETURNING id, name, active, "sortOrder"`)
    await audit(tx, { actor, action: 'rack.created', entityType: 'rack', entityId: Number(r.rows[0].id), after: r.rows[0] })
    return toRack(r.rows[0])
  })
}

const toRack = (x: Rack): Rack => ({ id: Number(x.id), name: String(x.name), active: Boolean(x.active), sortOrder: Number(x.sortOrder) })

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Totals for some sessions, set-based (2 statements in one round trip via UNION ALL). */
export async function sessionTotals(db: DbOrTx, ids: number[]): Promise<Map<number, SessionTotals>> {
  const out = new Map<number, SessionTotals>()
  if (!ids.length) return out
  const r = await db.execute<{ id: number; boxes: number; manual: number; missing: number; cartons: number; cartonPairs: number; people: number }>(sql`
    WITH ids AS (SELECT json_array_elements_text(${J(ids)}::json)::int AS id),
    e AS (
      SELECT e."sessionId" AS id,
             count(*) FILTER (WHERE e."entryType" = 'scan')::int AS boxes,
             coalesce(sum(e.quantity) FILTER (WHERE e."entryType" = 'manual'), 0)::int AS manual,
             count(*) FILTER (WHERE e.resolution <> 'resolved')::int AS missing,
             array_agg(DISTINCT e."userId") AS users
        FROM scan_events e WHERE e."sessionId" IN (SELECT id FROM ids) AND e.status = 'active'
       GROUP BY e."sessionId"),
    c AS (
      SELECT c."sessionId" AS id, count(*)::int AS cartons, coalesce(sum(c."postedPairs"), 0)::int AS pairs, array_agg(DISTINCT c."userId") AS users
        FROM carton_receipts c WHERE c."sessionId" IN (SELECT id FROM ids) AND c.status = 'active' AND c.match = 'stocktake'
       GROUP BY c."sessionId")
    SELECT ids.id, coalesce(e.boxes, 0) AS boxes, coalesce(e.manual, 0) AS manual, coalesce(e.missing, 0) AS missing,
           coalesce(c.cartons, 0) AS cartons, coalesce(c.pairs, 0) AS "cartonPairs",
           (SELECT count(DISTINCT u) FROM unnest(coalesce(e.users, '{}') || coalesce(c.users, '{}')) u WHERE u IS NOT NULL)::int AS people
      FROM ids LEFT JOIN e ON e.id = ids.id LEFT JOIN c ON c.id = ids.id`)
  for (const x of r.rows) {
    const boxes = Number(x.boxes), manualPairs = Number(x.manual), cartonPairs = Number(x.cartonPairs)
    out.set(Number(x.id), { pairs: boxes + manualPairs + cartonPairs, boxes, manualPairs, cartons: Number(x.cartons), cartonPairs, missing: Number(x.missing), people: Number(x.people) })
  }
  return out
}

type SessionRow = { id: number; rackId: number | null; rackName: string | null; status: 'open' | 'finished'; startedBy: string | null; startedByName: string; startedAt: string; finishedAt: string | null; finishedByName: string | null }

const SESSION_COLS = sql`s.id, s."rackId", r.name AS "rackName", s.status, s."startedBy", s."startedByName", s."startedAt", s."finishedAt", s."finishedByName"`

async function withTotals(db: DbOrTx, rows: SessionRow[]): Promise<SessionInfo[]> {
  const totals = await sessionTotals(db, rows.map((r) => Number(r.id)))
  return rows.map((x) => ({
    id: Number(x.id), rackId: x.rackId != null ? Number(x.rackId) : null, rackName: x.rackName ?? null, status: x.status,
    startedBy: x.startedBy ?? null, startedByName: String(x.startedByName ?? ''), startedAt: new Date(x.startedAt).toISOString(),
    finishedAt: x.finishedAt ? new Date(x.finishedAt).toISOString() : null, finishedByName: x.finishedByName ?? null,
    totals: totals.get(Number(x.id)) ?? EMPTY,
  }))
}

export async function getSession(db: DbOrTx, id: number): Promise<SessionInfo | null> {
  const r = await db.execute<SessionRow>(sql`SELECT ${SESSION_COLS} FROM stocktake_sessions s LEFT JOIN racks r ON r.id = s."rackId" WHERE s.id = ${id}`)
  return r.rows[0] ? (await withTotals(db, r.rows))[0] : null
}

/** Recent sessions (open first, then newest), with totals. Two statements. */
export async function listSessions(db: DbOrTx, limit = 40): Promise<SessionInfo[]> {
  const r = await db.execute<SessionRow>(sql`
    SELECT ${SESSION_COLS} FROM stocktake_sessions s LEFT JOIN racks r ON r.id = s."rackId"
     ORDER BY (s.status = 'open') DESC, s.id DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`)
  return withTotals(db, r.rows)
}

/**
 * The open godown stocktake; started now when none is open. The open one is found first (one
 * statement); only when there is none: one transaction to insert (a concurrent start wins the
 * unique index and this one joins it).
 */
export async function ensureOpenStocktake(db: Db, actor: Actor): Promise<{ id: number; started: boolean }> {
  const open = await openStocktakeId(db)
  if (open != null) return { id: open, started: false }
  return db.transaction(async (tx) => {
    const ins = await tx.execute<{ id: number }>(sql`
      INSERT INTO stocktake_sessions ("startedBy", "startedByName") VALUES (${actor.id}, ${actor.name})
      ON CONFLICT (status) WHERE status = 'open' DO NOTHING RETURNING id`)
    if (ins.rows[0]) {
      const id = Number(ins.rows[0].id)
      await audit(tx, { actor, action: 'stocktake.started', entityType: 'stocktake_session', entityId: id })
      return { id, started: true }
    }
    const again = await openStocktakeId(tx)
    if (again == null) throw new SessionError('Could not start the stocktake. Try again.')
    return { id: again, started: false }
  })
}

/** Finish the stocktake: admin / supervisor (scan.void.any) only. One transaction. */
export async function finishSession(db: Db, actor: Actor, opts: { sessionId: number; canFinishAny: boolean; note?: string }): Promise<SessionInfo> {
  await db.transaction(async (tx) => {
    const r = await tx.execute<{ status: string }>(sql`SELECT status FROM stocktake_sessions WHERE id = ${opts.sessionId} FOR UPDATE`)
    const s = r.rows[0]
    if (!s) throw new SessionError('Stocktake not found.')
    if (s.status === 'finished') return
    // Everyone scans into the same stocktake: one person finishing it would end it for all.
    if (!opts.canFinishAny) throw new SessionError('Only an admin or supervisor can finish the stocktake.')
    await tx.execute(sql`
      UPDATE stocktake_sessions SET status = 'finished', "finishedAt" = now(), "finishedBy" = ${actor.id}, "finishedByName" = ${actor.name},
             note = ${String(opts.note ?? '').trim().slice(0, 300)}
       WHERE id = ${opts.sessionId}`)
    await audit(tx, { actor, action: 'stocktake.finished', entityType: 'stocktake_session', entityId: opts.sessionId })
  })
  return (await getSession(db, opts.sessionId))!
}

// ── What the screen shows ────────────────────────────────────────────────────

export interface FeedItem {
  /** 'scan:<id>' or 'carton:<id>' */
  key: string
  /** The device's id of the scan (clientEventId): matches a row saved offline to the saved one. */
  eventId: string
  id: number
  type: 'box' | 'manual' | 'carton'
  articleCode: string | null; colourCode: string | null; size: string | null
  articleName: string | null; colourName: string | null
  /** Pairs added: 1 for a box, the quantity for manual, the carton's pairs. */
  pairs: number
  mrp: string | null
  resolution: 'resolved' | 'missing_article' | 'missing_size'
  userName: string
  at: string
  /** Carton: "6×6 7×6 …" */
  detail: string | null
}

/** My last scans and cartons in a session, newest first (to rebuild the list after a reload). One statement. */
export async function sessionFeed(db: DbOrTx, userId: string, sessionId: number, limit = 40): Promise<FeedItem[]> {
  const n = Math.min(Math.max(limit, 1), 100)
  const r = await db.execute<Record<string, unknown>>(sql`
    (SELECT 'scan' AS kind, e.id, e."clientEventId"::text AS "eventId", e."entryType", e."articleCode", e."colourCode", e."sizeLabel", a."artName", a.color, e.quantity AS pairs, e.mrp::text, e.resolution,
            e."userName", e."createdAt", NULL::text AS detail
       FROM scan_events e LEFT JOIN articles a ON a.id = e."articleId"
      WHERE e."sessionId" = ${sessionId} AND e."userId" = ${userId} AND e.status = 'active'
      ORDER BY e.id DESC LIMIT ${n})
    UNION ALL
    (SELECT 'carton', c.id, c."clientEventId"::text, 'carton', c."articleCode", c."colourCode", CASE WHEN c."sizeFrom" = c."sizeTo" THEN c."sizeFrom" ELSE c."sizeFrom" || '–' || c."sizeTo" END,
            (SELECT a."artName" FROM articles a WHERE upper(btrim(a."artCode")) = c."articleCode" AND a.active ORDER BY a.id LIMIT 1), NULL,
            coalesce(c."postedPairs", 0), c.mrp::text, 'resolved', c."userName", c."createdAt",
            (SELECT string_agg(s."sizeLabel" || '×' || m.quantity, ' ' ORDER BY s."sortOrder") FROM stock_movements m JOIN article_sizes s ON s.id = m."skuId"
              WHERE m."sourceType" = 'carton_receipt' AND m."sourceId" = c.id::text AND m."movementType" = 'stocktake_carton')
       FROM carton_receipts c
      WHERE c."sessionId" = ${sessionId} AND c."userId" = ${userId} AND c.status = 'active' AND c.match = 'stocktake'
      ORDER BY c.id DESC LIMIT ${n})
    ORDER BY "createdAt" DESC LIMIT ${n}`)
  return r.rows.map((x) => ({
    key: `${x.kind}:${x.id}`, id: Number(x.id), eventId: String(x.eventId),
    type: x.kind === 'carton' ? 'carton' : x.entryType === 'manual' ? 'manual' : 'box',
    articleCode: (x.articleCode as string) ?? null, colourCode: (x.colourCode as string) ?? null, size: (x.sizeLabel as string) ?? null,
    articleName: (x.artName as string) ?? null, colourName: (x.color as string) ?? null,
    pairs: Number(x.pairs ?? 0), mrp: (x.mrp as string) ?? null, resolution: x.resolution as FeedItem['resolution'],
    userName: String(x.userName ?? ''), at: new Date(x.createdAt as string).toISOString(), detail: (x.detail as string) ?? null,
  }))
}
