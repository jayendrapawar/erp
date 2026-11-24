'use client'

/**
 * useCatalogueCache — the article + retailer list for the admin Orders hub (Salesman, Biller tabs).
 *
 * The list is large, so the browser keeps one copy (Cache API) and downloads it again only when the
 * catalogue version changed (lib/catalog/version.ts). The version comes with the tab's own data
 * (1 tiny query), so a Master edit shows the next time the tab loads: opening it, or the 30 s
 * refresh while it is open. (24 Nov 2026: before, a 30 min browser copy, a 5–30 min HTTP cache and
 * a 30 min service-worker copy all hid Master edits.)
 *
 * Pages that load the catalogue on the server (/orders, /orders/salesman, /orders/biller) pass it
 * straight to the dashboards and do not use this.
 */

import { useState, useEffect } from 'react'
import type { CatalogueData } from '@/app/actions/catalogue'
import { asSavedCatalogue, isCatalogue, needsDownload, type SavedCatalogue } from '@/lib/catalog/catalogue-copy'

// Change the name when CatalogueData changes shape (public/sw.js keeps this one cache).
const CACHE_NAME = 'shayona-order-catalogue-v1'
const CACHE_KEY = '/__order-catalogue'
const EMPTY: CatalogueData = { version: '', vendors: [], articles: [] }

// Shared by every user of the hook on the page: one read of the saved copy, one download at a time.
let memory: SavedCatalogue | null = null
let download: Promise<SavedCatalogue | null> | null = null

async function readSaved(): Promise<SavedCatalogue | null> {
  try {
    const res = await (await caches.open(CACHE_NAME)).match(CACHE_KEY)
    return res ? asSavedCatalogue(await res.json()) : null
  } catch { return null } // storage unavailable or corrupt: download instead
}

function downloadCatalogue(): Promise<SavedCatalogue | null> {
  download ??= (async () => {
    try {
      const res = await fetch('/api/catalogue', { cache: 'no-store' })
      if (!res.ok) return null
      const data: unknown = await res.json()
      if (!isCatalogue(data)) return null
      const saved: SavedCatalogue = { version: data.version, savedAt: Date.now(), data }
      try {
        await (await caches.open(CACHE_NAME)).put(CACHE_KEY, new Response(JSON.stringify(saved), { headers: { 'Content-Type': 'application/json' } }))
      } catch { /* not saved (private window, storage full): this visit only */ }
      return saved
    } catch { return null } // offline: keep showing the saved copy
    finally { download = null }
  })()
  return download
}

/** `version`: the current catalogue version from the server (with the tab's data). */
export function useCatalogueCache(version: string | undefined): CatalogueData {
  const [catalogue, setCatalogue] = useState<CatalogueData>(memory?.data ?? EMPTY)

  useEffect(() => {
    // Without the Cache API (plain-http address) readSaved finds nothing and the list is downloaded each time.
    let live = true
    ;(async () => {
      if (!memory) memory = await readSaved()
      if (memory && live) setCatalogue(memory.data)
      if (!needsDownload(memory, version, Date.now())) return
      const fresh = await downloadCatalogue()
      if (!fresh) return
      memory = fresh
      if (live) setCatalogue(fresh.data)
    })()
    return () => { live = false }
  }, [version])

  return catalogue
}
