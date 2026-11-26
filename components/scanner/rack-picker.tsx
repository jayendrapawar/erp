'use client'

// Warehouse Scanner: choose the rack to count. A rack being counted shows who started it and its
// pairs so far; tapping it joins that count, else a new count starts.

import { RefreshCw, Settings2 } from 'lucide-react'
import type { Rack, SessionInfo } from '@/lib/inventory/stocktake-sessions'
import { secondaryBtn, timeIST } from './sheet'

type Props = {
  racks: Rack[]
  open: SessionInfo[]
  busyRackId: number | null
  error: string
  loading: boolean
  online: boolean
  canManage: boolean
  onPick: (rack: Rack) => void
  onRefresh: () => void
  onManage: () => void
}

export function RackPicker({ racks, open, busyRackId, error, loading, online, canManage, onPick, onRefresh, onManage }: Props) {
  const openByRack = new Map(open.map((s) => [s.rackId, s]))
  return (
    <section className="space-y-3" aria-label="Choose a rack">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Which rack are you counting?</h2>
          <p className="text-xs text-muted-foreground">Everything you scan is counted for this rack.</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading || !online} aria-label="Refresh" className="rounded-lg border border-border p-2.5 hover:bg-muted disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {!online && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">You are offline. Connect to the internet to choose a rack.</p>}
      {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {!loading && racks.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {canManage ? 'No racks yet. Add them with "Manage racks".' : 'No racks yet. Ask a supervisor to add them.'}
        </p>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {racks.map((r) => {
          const s = openByRack.get(r.id)
          return (
            <button key={r.id} type="button" onClick={() => onPick(r)} disabled={!online || busyRackId != null}
              className={`flex min-h-16 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60 ${s ? 'border-sky-500/50 bg-sky-500/10 hover:bg-sky-500/15' : 'border-border hover:bg-muted'}`}>
              <span className="min-w-0">
                <span className="block truncate text-base font-semibold" data-no-translate>{r.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {s ? `Counting now · ${s.totals.pairs} pairs · since ${timeIST(s.startedAt)} (${s.startedByName})` : 'Not being counted'}
                </span>
              </span>
              <span className="shrink-0 text-xs font-semibold text-sky-700 dark:text-sky-300">{busyRackId === r.id ? 'Opening…' : s ? 'Join' : 'Start'}</span>
            </button>
          )
        })}
      </div>
      {canManage && (
        <button type="button" onClick={onManage} className={`${secondaryBtn} w-full`}>
          <Settings2 className="h-4 w-4" /> Manage racks
        </button>
      )}
    </section>
  )
}
