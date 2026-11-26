'use client'

// Warehouse Scanner → Type by hand: a box whose label is damaged or unreadable. Counted as
// UNSCANNED stock (not QR-verified). Stays open for the next size; offline entries wait on the phone.

import { useState, type FormEvent } from 'react'
import { Sheet, fieldCls, primaryBtn, secondaryBtn } from './sheet'

export interface ManualValues { art: string; colour: string; size: string; qty: number; mrp: number | null; mfgMonth: number | null; mfgYear: number | null; notes: string }

type Props = {
  rackName: string
  onSave: (v: ManualValues) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  onClose: () => void
}

export function ManualEntryDialog({ rackName, onSave, onClose }: Props) {
  const [f, setF] = useState({ art: '', colour: '', size: '', qty: '', mrp: '', mfgMonth: '', mfgYear: '', notes: '' })
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const qty = f.qty ? Number.parseInt(f.qty, 10) : 1
    if (!f.art.trim() || !f.size.trim()) { setMsg({ ok: false, text: 'Article code and size are required.' }); return }
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000) { setMsg({ ok: false, text: 'Pairs must be a whole number from 1 to 10000.' }); return }
    setBusy(true); setMsg(null)
    try {
      const r = await onSave({
        art: f.art.trim().toUpperCase(), colour: f.colour.trim().toUpperCase(), size: f.size.trim().toUpperCase(), qty,
        mrp: f.mrp ? Number(f.mrp) : null,
        mfgMonth: f.mfgMonth ? Number.parseInt(f.mfgMonth, 10) : null, mfgYear: f.mfgYear ? Number.parseInt(f.mfgYear, 10) : null,
        notes: f.notes.trim(),
      })
      setMsg({ ok: r.ok, text: r.message })
      // Next size of the same article.
      if (r.ok) setF((p) => ({ ...p, size: '', qty: '' }))
    } finally { setBusy(false) }
  }

  return (
    <Sheet title="Type a box by hand" onClose={onClose}>
      <p className="mb-3 text-xs text-muted-foreground">
        For a box whose label cannot be read. Counted for <span className="font-semibold text-foreground" data-no-translate>{rackName}</span> as hand-counted stock.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-medium">Article code
            <input value={f.art} onChange={set('art')} required autoCapitalize="characters" autoComplete="off" className={`${fieldCls} mt-1 font-mono uppercase`} placeholder="e.g. PUG105G" disabled={busy} />
          </label>
          <label className="text-xs font-medium">Colour code
            <input value={f.colour} onChange={set('colour')} autoCapitalize="characters" autoComplete="off" className={`${fieldCls} mt-1 font-mono uppercase`} placeholder="e.g. BKRD" disabled={busy} />
          </label>
          <label className="text-xs font-medium">Size
            <input value={f.size} onChange={set('size')} required inputMode="numeric" autoComplete="off" className={`${fieldCls} mt-1`} placeholder="e.g. 7" disabled={busy} />
          </label>
          <label className="text-xs font-medium">Pairs
            <input value={f.qty} onChange={(e) => setF((p) => ({ ...p, qty: e.target.value.replace(/\D/g, '') }))} inputMode="numeric" autoComplete="off" className={`${fieldCls} mt-1`} placeholder="1" disabled={busy} />
          </label>
        </div>
        {more ? (
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs font-medium">MRP ₹
              <input value={f.mrp} onChange={set('mrp')} inputMode="decimal" className={`${fieldCls} mt-1`} placeholder="0.00" disabled={busy} />
            </label>
            <label className="text-xs font-medium">Mfg month
              <input value={f.mfgMonth} onChange={set('mfgMonth')} inputMode="numeric" maxLength={2} className={`${fieldCls} mt-1`} placeholder="MM" disabled={busy} />
            </label>
            <label className="text-xs font-medium">Mfg year
              <input value={f.mfgYear} onChange={set('mfgYear')} inputMode="numeric" maxLength={4} className={`${fieldCls} mt-1`} placeholder="YYYY" disabled={busy} />
            </label>
            <label className="col-span-3 text-xs font-medium">Note
              <input value={f.notes} onChange={set('notes')} maxLength={200} className={`${fieldCls} mt-1`} placeholder="e.g. label torn" disabled={busy} />
            </label>
          </div>
        ) : (
          <button type="button" onClick={() => setMore(true)} className="text-xs font-semibold text-sky-700 underline dark:text-sky-300">+ MRP, manufacture month, note</button>
        )}
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : 'bg-red-500/10 text-red-700 dark:text-red-300'}`}>{msg.text}</p>}
        <div className="flex gap-2">
          <button type="submit" data-primary disabled={busy} className={`${primaryBtn} flex-1`}>{busy ? 'Saving…' : 'Add to count'}</button>
          <button type="button" onClick={onClose} className={secondaryBtn}>Done</button>
        </div>
      </form>
    </Sheet>
  )
}
