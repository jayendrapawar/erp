'use client'

// Warehouse Scanner → Stocktakes: every stocktake (open first), its totals, and Finish.
// Finishing: admin / supervisor only (everyone scans into the same godown stocktake).

import { useEffect, useState } from 'react'
import { finishSessionAction, listSessionsAction, refreshSessionAction } from '@/app/actions/scanner'
import type { SessionInfo } from '@/lib/inventory/stocktake-sessions'
import { Sheet, dayTimeIST, fieldCls, primaryBtn, secondaryBtn } from './sheet'

export function SessionTotalsView({ s }: { s: SessionInfo }) {
  const t = s.totals
  const cells: Array<[string, string]> = [
    ['Boxes scanned', String(t.boxes)],
    ['Cartons', t.cartons ? `${t.cartons} (${t.cartonPairs} pairs)` : '0'],
    ['Typed by hand', `${t.manualPairs} pairs`],
    ['Not in master', String(t.missing)],
    ['People', String(t.people)],
  ]
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-2xl font-bold">{`${t.pairs} pairs`}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {cells.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2"><dt className="text-muted-foreground">{k}</dt><dd className="font-semibold">{v}</dd></div>
        ))}
      </dl>
      {t.missing > 0 && <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">Boxes not in the article master are saved but not in stock until an admin links the article.</p>}
    </div>
  )
}

type FinishProps = { session: SessionInfo; canFinish: boolean; onClose: () => void; onFinished: (s: SessionInfo) => void }

/** Finish one count: fresh totals first, then a note and Finish. */
export function FinishCount({ session, canFinish, onClose, onFinished }: FinishProps) {
  const [s, setS] = useState(session)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    refreshSessionAction(session.id).then((r) => { if (r.ok && r.data.session) setS(r.data.session) }).catch(() => {})
  }, [session.id])

  async function finish() {
    setBusy(true); setError('')
    try {
      const r = await finishSessionAction(s.id, note)
      if (!r.ok) { setError(r.message); return }
      onFinished(r.data)
    } catch { setError('Not finished — check the internet and try again.') } finally { setBusy(false) }
  }

  return (
    <Sheet title={s.rackName ? `Finish counting ${s.rackName}?` : 'Finish the godown stocktake?'} onClose={onClose}>
      <p className="mb-3 text-xs text-muted-foreground">{`Started ${dayTimeIST(s.startedAt)} by ${s.startedByName}. Everyone's scans are included. After finishing, the next scan starts a new stocktake.`}</p>
      <SessionTotalsView s={s} />
      {canFinish ? (
        <>
          <label className="mt-3 block text-xs font-medium">Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. top shelf not done" className={`${fieldCls} mt-1`} disabled={busy} />
          </label>
          {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" data-primary onClick={finish} disabled={busy} className={`${primaryBtn} flex-1`}>{busy ? 'Finishing…' : 'Finish stocktake'}</button>
            <button type="button" data-autofocus onClick={onClose} className={secondaryBtn}>Keep counting</button>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Only an admin or supervisor can finish the stocktake.</p>
      )}
    </Sheet>
  )
}

type CountsProps = {
  currentId: number | null

  canFinishAny: boolean
  onClose: () => void
  onFinish: (s: SessionInfo) => void
}

export function CountsDialog({ currentId, canFinishAny, onClose, onFinish }: CountsProps) {
  const [rows, setRows] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  useEffect(() => {
    listSessionsAction().then((r) => (r.ok ? setRows(r.data) : setError(r.message))).catch(() => setError('Could not load the counts.'))
  }, [])

  return (
    <Sheet title="Stocktakes" onClose={onClose} wide>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {rows == null && !error && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
      {rows?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No stocktakes yet.</p>}
      <ul className="space-y-2">
        {rows?.map((s) => (
          <li key={s.id} className="rounded-xl border border-border">
            <button type="button" onClick={() => setOpenId(openId === s.id ? null : s.id)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate font-semibold" data-no-translate={s.rackName ? true : undefined}>{s.rackName ?? 'Godown stocktake'}</span>
                  <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${s.status === 'open' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-muted text-muted-foreground'}`}>
                    {s.status === 'open' ? (s.id === currentId ? 'Open (you are in it)' : 'Open') : 'Finished'}
                  </span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {s.status === 'open' ? `Since ${dayTimeIST(s.startedAt)} · ${s.startedByName}` : `${dayTimeIST(s.startedAt)} → ${dayTimeIST(s.finishedAt!)} · ${s.finishedByName ?? ''}`}
                </span>
              </span>
              <span className="shrink-0 text-sm font-bold">{`${s.totals.pairs} pairs`}</span>
            </button>
            {openId === s.id && (
              <div className="space-y-2 border-t border-border p-3">
                <SessionTotalsView s={s} />
                {s.status === 'open' && canFinishAny && (
                  <button type="button" onClick={() => onFinish(s)} className={`${secondaryBtn} w-full`}>Finish this stocktake</button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
