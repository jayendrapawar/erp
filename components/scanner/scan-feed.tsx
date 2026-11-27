'use client'

// Warehouse Scanner: the scans of this count, newest first. A row appears the moment a code is read
// ("Saving…") and turns green / amber / red when the server answers.

import type { FeedItem } from '@/lib/inventory/stocktake-sessions'
import { timeIST } from './sheet'

export type EntryState = 'saving' | 'saved' | 'missing' | 'offline' | 'duplicate' | 'error' | 'asking'

export interface FeedEntry {
  /** The scan's clientEventId. */
  key: string
  state: EntryState
  title: string
  detail: string
  at: number
  item?: FeedItem
}

export function feedTitle(i: Pick<FeedItem, 'type' | 'articleCode' | 'colourCode' | 'size'>): string {
  const what = [i.articleCode, i.colourCode].filter(Boolean).join(' ')
  return i.type === 'carton' ? `Carton ${what} · ${i.size ?? ''}` : `${what} · size ${i.size ?? '?'}`
}

export function entryFromItem(i: FeedItem): FeedEntry {
  const name = [i.articleName, i.colourName].filter(Boolean).join(' · ')
  return {
    key: i.eventId, at: new Date(i.at).getTime(), item: i, title: feedTitle(i),
    state: i.resolution === 'resolved' ? 'saved' : 'missing',
    detail: i.resolution === 'resolved'
      ? [name, i.detail, i.type === 'manual' ? 'typed by hand' : null].filter(Boolean).join(' · ')
      : 'Not in the article master yet — saved; an admin will link it.',
  }
}

const TONE: Record<EntryState, { dot: string; row: string; label: string }> = {
  saving:    { dot: 'bg-muted-foreground animate-pulse', row: 'border-border', label: 'Saving…' },
  asking:    { dot: 'bg-sky-500 animate-pulse', row: 'border-sky-500/40', label: 'Waiting' },
  saved:     { dot: 'bg-emerald-500', row: 'border-emerald-500/40', label: 'Saved' },
  missing:   { dot: 'bg-amber-500', row: 'border-amber-500/40', label: 'Saved · not in master' },
  offline:   { dot: 'bg-amber-500', row: 'border-amber-500/40', label: 'On this phone · sends when online' },
  duplicate: { dot: 'bg-red-500', row: 'border-red-500/40', label: 'Not counted' },
  error:     { dot: 'bg-red-500', row: 'border-red-500/40', label: 'Not saved' },
}

export function ScanFeed({ entries, onUndo }: { entries: FeedEntry[]; onUndo: (item: FeedItem) => void }) {
  if (!entries.length) {
    return <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">Scan a box or a carton. It appears here.</p>
  }
  return (
    <ol className="space-y-1.5" aria-label="Scans in this count" aria-live="polite">
      {entries.map((e, i) => {
        const t = TONE[e.state]
        const pairs = e.item?.pairs ?? 0
        const canUndo = Boolean(e.item) && (e.state === 'saved' || e.state === 'missing')
        return (
          <li key={e.key} className={`flex items-start gap-3 rounded-xl border bg-background px-3 ${i === 0 ? 'py-3' : 'py-2'} ${t.row}`}>
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${t.dot}`} />
            <div className="min-w-0 flex-1">
              <p className={`truncate font-mono font-semibold ${i === 0 ? 'text-base' : 'text-sm'}`} data-no-translate>{e.title}</p>
              <p className="truncate text-xs text-muted-foreground">{e.detail || t.label}</p>
              {e.detail && <p className="text-[11px] text-muted-foreground">{`${t.label} · ${timeIST(new Date(e.at).toISOString())}`}</p>}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {pairs > 0 && (e.state === 'saved' || e.state === 'missing' || e.state === 'offline') && (
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-bold">{`+${pairs}`}</span>
              )}
              {canUndo && (
                <button type="button" onClick={() => onUndo(e.item!)} className="rounded-md px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-500/10 dark:text-red-400">Undo</button>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
