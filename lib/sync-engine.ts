'use client'

/**
 * Sync Engine — flushes the offline IndexedDB queue to the server
 * by calling the same server actions the scanner page uses online.
 *
 * Rules:
 *  - Pending/syncing items are attempted.
 *  - Server duplicate → kept with status 'error' for user review.
 *  - Transient network failure → reset to 'pending' for next retry.
 *  - Items already in 'error' state are NOT retried automatically
 *    (they need user action: dismiss or they stay visible).
 */

import { getQueue, removeFromQueue, updateEntry, type OfflineEntry } from './offline-queue'
import { getCachedFlags, getPendingFlags, removePendingFlag, cacheFlags } from './offline-flags'
import { addManualEntry, recordScan } from '@/app/actions/scan'
import { getFlags, createFlag } from '@/app/actions/flags'
import { DUPLICATE_QR_ERROR } from './errors'

export interface SyncResult {
  synced:     number   // successfully written to DB
  duplicates: number   // server rejected as duplicate
  errors:     number   // transient failures (will retry next time)
}

/**
 * Attempt to flush every pending item in the queue.
 * Returns a summary of what happened.
 */
export async function syncQueue(): Promise<SyncResult> {
  const queue   = await getQueue()
  const pending = queue.filter((e) => e.status === 'pending' || e.status === 'syncing')

  const result: SyncResult = { synced: 0, duplicates: 0, errors: 0 }

  for (const entry of pending) {
    await updateEntry(entry.tempId, { status: 'syncing' })

    try {
      const outcome = await trySyncEntry(entry)

      if (outcome === 'success') {
        await removeFromQueue(entry.tempId)
        result.synced++
      } else if (outcome === 'duplicate') {
        await updateEntry(entry.tempId, {
          status:       'error',
          errorMessage: 'Duplicate — this item already exists in the database.',
        })
        result.duplicates++
      } else {
        // transient — reset so next sync retries
        await updateEntry(entry.tempId, { status: 'pending', errorMessage: outcome })
        result.errors++
      }
    } catch (err) {
      await updateEntry(entry.tempId, {
        status:       'pending',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      })
      result.errors++
    }
  }

  return result
}

/**
 * Flush any flags created while offline up to the server, then pull the
 * latest authoritative list back and update the local cache.
 * Returns the merged, deduplicated flag list.
 */
export async function syncFlags(): Promise<string[]> {
  const pending = await getPendingFlags()

  for (const name of pending) {
    try {
      await createFlag(name)       // onConflictDoNothing — safe if already in DB
      await removePendingFlag(name)
    } catch {
      // Network error — leave in pending store for next attempt
    }
  }

  try {
    const latest = await getFlags()
    await cacheFlags(latest)
    return latest
  } catch {
    // Server unreachable — return whatever is in the local cache
    return getCachedFlags()
  }
}

/**
 * Returns 'success' | 'duplicate' | error-message-string.
 * The queue's tempId was generated on the device when the box was scanned and is sent as
 * the event id, so re-sending after a lost response returns the original scan instead of
 * adding stock again.
 */
async function trySyncEntry(entry: OfflineEntry): Promise<'success' | 'duplicate' | string> {
  // Entries queued before the flag field existed carried it inside notes.
  const legacyFlag = entry.notes?.match(/\[Flag:\s*([^\]]+)\]/)?.[1]?.trim()
  const flag = entry.flag ?? legacyFlag ?? null
  const notes = entry.notes?.replace(/\[Flag:[^\]]*\]/, '').trim() || null

  if (entry.entryType === 'scan' && entry.rawQrCode) {
    const res = await recordScan(entry.rawQrCode, { clientEventId: entry.tempId, flag, notes, deviceAt: new Date(entry.savedAt).toISOString(), offline: true })
    if (res.ok)                           return 'success'
    if (res.error === DUPLICATE_QR_ERROR) return 'duplicate'
    return `Server error: ${res.message}`
  }

  const res = await addManualEntry({
    clientEventId: entry.tempId,
    artNumber: entry.artNumber,
    colorNumber: entry.colorNumber,
    sizeNumber: entry.sizeNumber,
    quantity: entry.quantity,
    notes,
    flag,
    mrp: entry.mrp ?? null,
    mfgMonth: entry.mfgMonth ?? null,
    mfgYear: entry.mfgYear ?? null,
    offline: true,
  })
  if (res.ok) return 'success'
  return `Server error: ${res.message}`
}
