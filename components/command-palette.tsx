'use client'

// Ctrl K "Jump to…" (docs/architecture/keyboard.md). Three kinds of results from one box:
//   text   → pages and tabs (from the sidebar menu, no request)
//   "> "   → actions on the current page (New order, Direct bill, Upload bill…) from the shortcut registry
//   "# "   → records: order / bill number, retailer, article code (GET /api/search, 2+ characters,
//            debounced 250 ms, older requests cancelled, LIMIT 10 per kind)
// ↑↓ move, Enter opens, Esc closes and focus goes back where it was.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { SideSection } from '@/lib/nav'
import { formatShortcut, getShortcutRegistry, isMacPlatform, useShortcut } from '@/lib/shortcuts'
import { useDialogKeys } from '@/lib/shortcuts/dialog'
import type { RecordHit } from '@/lib/search/records'

interface Item { key: string; label: string; sub: string; hint?: string; run: () => void }

const KIND_LABEL: Record<RecordHit['kind'], string> = { order: 'Order', retailer: 'Retailer', article: 'Article' }

export function CommandPalette({ sections, onClose, onOpen }: { sections: SideSection[]; onClose: () => void; onOpen: (href: string) => void }) {
  const [q, setQ] = useState('')
  const [pos, setPos] = useState(0)
  const [records, setRecords] = useState<RecordHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const { scope, dialogProps } = useDialogKeys(box, { onClose, initialFocus: input })
  // Ctrl K again closes it (as before).
  useShortcut('mod+k', onClose, { label: 'Close', scope, hidden: true })
  const [mac] = useState(isMacPlatform)

  const mode: 'pages' | 'actions' | 'records' = q.startsWith('>') ? 'actions' : q.startsWith('#') ? 'records' : 'pages'
  const term = (mode === 'pages' ? q : q.slice(1)).trim()
  // Letters and digits of any script (Hindi page names too); spaces and punctuation ignored.
  const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

  // Actions the page underneath registered (read once when the palette opens: the page does not change meanwhile).
  const [actions] = useState(() => getShortcutRegistry().actions(scope))

  const pages = useMemo(() => sections.flatMap((s) => s.links.flatMap((l) => [
    { href: l.href, label: l.label, where: s.title ?? '' },
    ...(l.children ?? []).map((c) => ({ href: c.href, label: c.label, where: l.label })),
  ])), [sections])

  // Records: debounced, only 2+ characters, the previous request cancelled.
  useEffect(() => {
    if (mode !== 'records' || term.length < 2) { setRecords([]); setSearching(false); setSearchError(''); return }
    const ctrl = new AbortController()
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal, cache: 'no-store' })
        if (!res.ok) throw new Error(res.status === 401 ? 'Signed out: sign in again.' : 'Search failed.')
        const data = await res.json() as { results: RecordHit[] }
        setRecords(data.results); setSearchError('')
      } catch (e) {
        if ((e as Error).name !== 'AbortError') { setRecords([]); setSearchError((e as Error).message || 'Search failed.') }
      } finally {
        if (!ctrl.signal.aborted) setSearching(false)
      }
    }, 250)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [mode, term])

  const items: Item[] = mode === 'actions'
    ? actions.filter((a) => !term || norm(`${a.label} ${a.group}`).includes(norm(term))).map((a) => ({
        key: `a${a.id}`, label: a.label, sub: a.group,
        hint: a.keys[0] ? formatShortcut(a.keys[0], mac) : undefined,
        // Close first (focus goes back to the page), then run: an action that opens a dialog gets the right opener.
        run: () => { onClose(); setTimeout(a.run, 30) },
      }))
    : mode === 'records'
      ? records.map((r) => ({ key: `${r.kind}${r.id}`, label: r.title, sub: `${KIND_LABEL[r.kind]}${r.sub ? ` · ${r.sub}` : ''}`, run: () => onOpen(r.href) }))
      : pages.filter((x) => !term || norm(`${x.label} ${x.where}`).includes(norm(term))).map((x) => ({ key: x.href, label: x.label, sub: x.where, run: () => onOpen(x.href) }))

  useEffect(() => { setPos(0) }, [q, records])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${pos}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [pos])

  const empty = mode === 'records'
    ? (term.length < 2 ? 'Type 2 or more letters: an order or bill number, a retailer, an article code.'
      : searching ? 'Searching…' : searchError || 'Nothing found.')
    : mode === 'actions' ? (actions.length ? 'No action matches.' : 'This page has no actions.') : 'No page or tab matches.'

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={onClose}>
      <div ref={box} role="dialog" aria-modal="true" aria-label="Jump to a page, action or record" {...dialogProps}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setPos((p) => Math.min(p + 1, items.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setPos((p) => Math.max(p - 1, 0)) }
              else if (e.key === 'Home' && items.length) { e.preventDefault(); setPos(0) }
              else if (e.key === 'End' && items.length) { e.preventDefault(); setPos(items.length - 1) }
              else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && items[pos]) { e.preventDefault(); items[pos].run() }
            }}
            placeholder="Page or tab · > action · # order, retailer, article"
            aria-label="Page, action or record"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[pos] ? `palette-${pos}` : undefined}
            aria-autocomplete="list"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <ul ref={list} id="palette-list" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-2">
          {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground" role="presentation">{empty}</li>}
          {items.map((x, i) => (
            <li key={x.key} id={`palette-${i}`} data-index={i} role="option" aria-selected={i === pos}
              onMouseEnter={() => setPos(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={x.run}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm ${i === pos ? 'bg-accent text-accent-foreground' : 'text-foreground'}`}
            >
              <span className="min-w-0 truncate font-medium" data-no-translate={mode === 'records' || undefined}>{x.label}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="max-w-[14rem] truncate">{x.sub}</span>
                {x.hint && <kbd className="rounded border border-border px-1.5 text-[10px]" data-no-translate>{x.hint}</kbd>}
              </span>
            </li>
          ))}
        </ul>
        <p className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span><kbd className="font-semibold">&gt;</kbd> actions on this page</span>
          <span><kbd className="font-semibold">#</kbd> find an order, retailer or article</span>
          <span>↑↓ move · Enter open</span>
        </p>
      </div>
    </div>
  )
}
