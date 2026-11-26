'use server'

// Warehouse Scanner: racks and stocktake sessions (lib/inventory/stocktake-sessions.ts).
// Opening the screen is ONE request (getScannerBoot); its reads run in parallel on the server.

import { db } from '@/lib/db'
import { AuthError, requirePermission } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import {
  SessionError, finishSession, getSession, listRacks, listSessions, saveRack, sessionFeed, startOrJoinSession,
  type FeedItem, type Rack, type SessionInfo,
} from '@/lib/inventory/stocktake-sessions'

export interface ScannerUser { id: string; name: string; canCreateArticles: boolean; canVoidAny: boolean; canManageRacks: boolean }

export interface ScannerBoot {
  user: ScannerUser
  racks: Rack[]
  /** Open counts (any rack), with totals. */
  open: SessionInfo[]
  /** The count this device was in, when still known (open or finished). */
  session: SessionInfo | null
  /** My scans in that count, newest first. */
  feed: FeedItem[]
}

type Result<T> = { ok: true; data: T } | { ok: false; message: string }

function fail(e: unknown, fallback: string): { ok: false; message: string } {
  if (e instanceof SessionError) return { ok: false, message: e.message }
  if (e instanceof AuthError) return { ok: false, message: 'Your account is not allowed to do this.' }
  console.error(fallback, e)
  return { ok: false, message: fallback }
}

export async function getScannerBoot(sessionId: number | null): Promise<ScannerBoot> {
  const u = await requirePermission('scan.record')
  const id = Number.isInteger(sessionId) ? Number(sessionId) : null
  const [racks, sessions, session, feed] = await Promise.all([
    listRacks(db),
    listSessions(db, 30),
    id ? getSession(db, id) : Promise.resolve(null),
    id ? sessionFeed(db, u.id, id, 40) : Promise.resolve([] as FeedItem[]),
  ])
  return {
    user: {
      id: u.id, name: u.name,
      canCreateArticles: hasPermission(u.roles, 'articles.create_from_scan'),
      canVoidAny: hasPermission(u.roles, 'scan.void.any'),
      canManageRacks: hasPermission(u.roles, 'racks.manage'),
    },
    racks, open: sessions.filter((s) => s.status === 'open'), session, feed,
  }
}

/** Choose a rack: join its open count or start one. Returns the count and my scans in it. */
export async function startOrJoinAction(rackId: number): Promise<Result<{ session: SessionInfo; started: boolean; feed: FeedItem[] }>> {
  try {
    const u = await requirePermission('scan.record')
    const { session, started } = await startOrJoinSession(db, { id: u.id, name: u.name }, rackId)
    const feed = started ? [] : await sessionFeed(db, u.id, session.id, 40)
    return { ok: true, data: { session, started, feed } }
  } catch (e) { return fail(e, 'Could not start the count. Try again.') }
}

/** Fresh totals (and my list) of a count: after reconnecting, a new-article link, or ↻. */
export async function refreshSessionAction(sessionId: number): Promise<Result<{ session: SessionInfo | null; feed: FeedItem[] }>> {
  try {
    const u = await requirePermission('scan.record')
    const [session, feed] = await Promise.all([getSession(db, sessionId), sessionFeed(db, u.id, sessionId, 40)])
    return { ok: true, data: { session, feed } }
  } catch (e) { return fail(e, 'Could not load the count. Try again.') }
}

export async function finishSessionAction(sessionId: number, note: string): Promise<Result<SessionInfo>> {
  try {
    const u = await requirePermission('scan.record')
    const s = await finishSession(db, { id: u.id, name: u.name }, { sessionId, note, canFinishAny: hasPermission(u.roles, 'scan.void.any') })
    return { ok: true, data: s }
  } catch (e) { return fail(e, 'Could not finish the count. Try again.') }
}

/** Counts → recent sessions with totals (open first). */
export async function listSessionsAction(): Promise<Result<SessionInfo[]>> {
  try {
    await requirePermission('scan.record')
    return { ok: true, data: await listSessions(db, 50) }
  } catch (e) { return fail(e, 'Could not load the counts.') }
}

export async function listAllRacksAction(): Promise<Result<Rack[]>> {
  try {
    await requirePermission('racks.manage')
    return { ok: true, data: await listRacks(db, { all: true }) }
  } catch (e) { return fail(e, 'Could not load the racks.') }
}

export async function saveRackAction(input: { id?: number | null; name: string; active?: boolean }): Promise<Result<Rack>> {
  try {
    const u = await requirePermission('racks.manage')
    return { ok: true, data: await saveRack(db, { id: u.id, name: u.name }, input) }
  } catch (e) { return fail(e, 'Could not save the rack. Try again.') }
}
