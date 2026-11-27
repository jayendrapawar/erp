'use server'

// Warehouse Scanner: the godown stocktake and racks (lib/inventory/stocktake-sessions.ts).
// Opening the screen is ONE request (getScannerBoot): the open stocktake (if any), its totals, my
// scans in it and the optional racks list. Opening creates nothing: the first scan starts a stocktake.

import { db } from '@/lib/db'
import { AuthError, requirePermission } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import {
  SessionError, finishSession, openStocktakeId, getSession, listRacks, listSessions, saveRack, sessionFeed,
  type FeedItem, type Rack, type SessionInfo,
} from '@/lib/inventory/stocktake-sessions'

export interface ScannerUser { id: string; name: string; canCreateArticles: boolean; canVoidAny: boolean; canManageRacks: boolean }

export interface ScannerBoot {
  user: ScannerUser
  /** Optional areas a scan can be tagged with. */
  racks: Rack[]
  /** The open godown stocktake; null when none is open (the first scan starts one). */
  session: SessionInfo | null
  /** My scans in it, newest first. */
  feed: FeedItem[]
}

type Result<T> = { ok: true; data: T } | { ok: false; message: string }

function fail(e: unknown, fallback: string): { ok: false; message: string } {
  if (e instanceof SessionError) return { ok: false, message: e.message }
  if (e instanceof AuthError) return { ok: false, message: 'Your account is not allowed to do this.' }
  console.error(fallback, e)
  return { ok: false, message: fallback }
}

export async function getScannerBoot(): Promise<ScannerBoot> {
  const u = await requirePermission('scan.record')
  const [openId, racks] = await Promise.all([openStocktakeId(db), listRacks(db)])
  const [session, feed] = openId == null ? [null, [] as FeedItem[]] : await Promise.all([getSession(db, openId), sessionFeed(db, u.id, openId, 40)])
  return {
    user: {
      id: u.id, name: u.name,
      canCreateArticles: hasPermission(u.roles, 'articles.create_from_scan'),
      canVoidAny: hasPermission(u.roles, 'scan.void.any'),
      canManageRacks: hasPermission(u.roles, 'racks.manage'),
    },
    racks, session, feed,
  }
}

/** Fresh totals (and my list) of a stocktake: after reconnecting, a new-article link, or ↻. */
export async function refreshSessionAction(sessionId: number): Promise<Result<{ session: SessionInfo | null; feed: FeedItem[] }>> {
  try {
    const u = await requirePermission('scan.record')
    const [session, feed] = await Promise.all([getSession(db, sessionId), sessionFeed(db, u.id, sessionId, 40)])
    return { ok: true, data: { session, feed } }
  } catch (e) { return fail(e, 'Could not load the stocktake. Try again.') }
}

/** Admin / supervisor: finish the godown stocktake. */
export async function finishSessionAction(sessionId: number, note: string): Promise<Result<SessionInfo>> {
  try {
    const u = await requirePermission('scan.record')
    const s = await finishSession(db, { id: u.id, name: u.name }, { sessionId, note, canFinishAny: hasPermission(u.roles, 'scan.void.any') })
    return { ok: true, data: s }
  } catch (e) { return fail(e, 'Could not finish the stocktake. Try again.') }
}

/** Stocktakes → recent ones with totals (open first). */
export async function listSessionsAction(): Promise<Result<SessionInfo[]>> {
  try {
    await requirePermission('scan.record')
    return { ok: true, data: await listSessions(db, 50) }
  } catch (e) { return fail(e, 'Could not load the stocktakes.') }
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
