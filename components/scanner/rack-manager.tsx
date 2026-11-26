'use client'

// Warehouse Scanner → Manage racks (admin, supervisor): add, rename, switch off / on.
// A rack is never deleted (old counts point at it); a rack switched off is no longer offered.

import { useEffect, useState } from 'react'
import { listAllRacksAction, saveRackAction } from '@/app/actions/scanner'
import type { Rack } from '@/lib/inventory/stocktake-sessions'
import { Sheet, fieldCls, primaryBtn, secondaryBtn } from './sheet'

export function RackManager({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [racks, setRacks] = useState<Rack[] | null>(null)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    listAllRacksAction().then((r) => (r.ok ? setRacks(r.data) : setError(r.message))).catch(() => setError('Could not load the racks.'))
  }, [])

  async function save(input: { id?: number; name: string; active?: boolean }) {
    setBusy(true); setError('')
    try {
      const r = await saveRackAction(input)
      if (!r.ok) { setError(r.message); return false }
      setRacks((list) => {
        const rest = (list ?? []).filter((x) => x.id !== r.data.id)
        return [...rest, r.data].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      })
      onChanged()
      return true
    } catch { setError('Not saved — check the internet and try again.'); return false } finally { setBusy(false) }
  }

  return (
    <Sheet title="Manage racks" onClose={onClose}>
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && await save({ name })) setName('') }}>
        <label htmlFor="new-rack" className="sr-only">New rack</label>
        <input id="new-rack" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} placeholder="New rack, e.g. Rack A1" className={fieldCls} disabled={busy} autoComplete="off" />
        <button type="submit" data-primary disabled={busy || !name.trim()} className={primaryBtn}>Add</button>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-3 divide-y divide-border rounded-xl border border-border">
        {racks == null && <p className="p-4 text-center text-sm text-muted-foreground">Loading…</p>}
        {racks?.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No racks yet.</p>}
        {racks?.map((r) => (
          <div key={r.id} className="flex items-center gap-2 px-3 py-2">
            {editing?.id === r.id ? (
              <form className="flex flex-1 gap-2" onSubmit={async (e) => { e.preventDefault(); if (await save({ id: r.id, name: editing.name })) setEditing(null) }}>
                <input value={editing.name} onChange={(e) => setEditing({ id: r.id, name: e.target.value })} maxLength={50} aria-label="Rack name" className={fieldCls} disabled={busy} autoFocus />
                <button type="submit" disabled={busy || !editing.name.trim()} className={primaryBtn}>Save</button>
              </form>
            ) : (
              <>
                <span className={`min-w-0 flex-1 truncate text-sm font-medium ${r.active ? '' : 'text-muted-foreground line-through'}`} data-no-translate>{r.name}</span>
                <button type="button" onClick={() => setEditing({ id: r.id, name: r.name })} disabled={busy} className="rounded-lg px-2 py-1.5 text-xs font-semibold hover:bg-muted">Rename</button>
                <button type="button" onClick={() => save({ id: r.id, name: r.name, active: !r.active })} disabled={busy} className="rounded-lg px-2 py-1.5 text-xs font-semibold hover:bg-muted">
                  {r.active ? 'Switch off' : 'Switch on'}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Racks are never deleted: switch off one that is no longer used. Old counts keep its name.</p>
      <button type="button" onClick={onClose} className={`${secondaryBtn} mt-3 w-full`}>Done</button>
    </Sheet>
  )
}
