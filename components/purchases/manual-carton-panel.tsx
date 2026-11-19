'use client'

// Purchases → Receive → Manual entry: for a carton whose label is damaged or will not scan.
// 1. Scan one pair box from the carton (camera, USB scanner, or type its code).
// 2. Choose the carton's size range from the open proforma invoice lines (pairs per carton come
//    from the invoice, never typed).
// 3. Contents by size: the line's assortment, one from the master, or typed here (saved to the master).
// See lib/purchases/manual-carton.ts.

import { useEffect, useMemo, useState } from 'react'
import { manualCartonOptionsAction, receiveManualCartonAction } from '@/app/actions/purchases'
import { SEGMENTS, formatSizes } from '@/lib/catalog/assortments'
import type { ManualBox, ManualLine } from '@/lib/purchases/manual-carton'
import type { ReceiveOutcome } from '@/lib/purchases/store'

const inputCls = 'rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring'
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

type Props = {
  /** Codes read by the Receive screen's camera / USB scanner while this panel waits for a box. */
  registerBoxHandler: (fn: ((raw: string) => void) | null) => void
  cameraActive: boolean
  onStartCamera: () => void
  onResult: (raw: string, out: ReceiveOutcome) => void
  onClose: () => void
}

export function ManualCartonPanel({ registerBoxHandler, cameraActive, onStartCamera, onResult, onClose }: Props) {
  const [typed, setTyped] = useState('')
  const [box, setBox] = useState<ManualBox | null>(null)
  const [lines, setLines] = useState<ManualLine[]>([])
  const [lineId, setLineId] = useState<number | null>(null)
  const [choice, setChoice] = useState<number | 'new' | null>(null)
  const [segment, setSegment] = useState('')
  const [pairs, setPairs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function readBox(raw: string) {
    setBusy(true); setError('')
    try {
      const res = await manualCartonOptionsAction(raw)
      if (!res.ok) { setError(res.message); return }
      setBox(res.box)
      setLines(res.lines)
      setSegment(res.box.segment ?? '')
      const fitting = res.lines.filter((l) => l.fitsBox)
      setLineId(fitting.length === 1 ? fitting[0].lineId : null)
    } catch (e) {
      setError(errText(e, 'Could not read the box. Try again.'))
    } finally { setBusy(false) }
  }

  // While waiting for the box, codes from the camera / USB scanner come here.
  useEffect(() => {
    registerBoxHandler(box ? null : (raw) => { void readBox(raw) })
    return () => registerBoxHandler(null)
  }, [box, registerBoxHandler])

  const line = lines.find((l) => l.lineId === lineId) ?? null

  // Contents: the line's own assortment, the only one that fits, or the one for the article's segment.
  useEffect(() => {
    if (!line) { setChoice(null); return }
    if (line.assortment || line.single) { setChoice(null); return }
    if (line.options.length === 1) { setChoice(line.options[0].id); return }
    const bySeg = line.options.filter((o) => o.segment === box?.segment)
    if (bySeg.length === 1) { setChoice(bySeg[0].id); return }
    setChoice(line.options.length === 0 ? 'new' : null)
    setPairs({})
  }, [line, box?.segment])

  const total = useMemo(() => Object.values(pairs).reduce((n, v) => n + (Number(v) || 0), 0), [pairs])
  const needsContents = Boolean(line && !line.assortment && !line.single)
  const canReceive = Boolean(line && !busy && (!needsContents
    || (typeof choice === 'number')
    || (choice === 'new' && segment && total === line.pairsPerCarton)))

  async function receive() {
    if (!line || !box) return
    setBusy(true); setError('')
    try {
      const out = await receiveManualCartonAction({
        rawBox: box.raw, clientEventId: uuid(), lineId: line.lineId,
        assortmentId: typeof choice === 'number' ? choice : null,
        newAssortment: choice === 'new' ? { segment, sizes: line.sizes.map((s) => ({ size: s, pairs: Number(pairs[s]) || 0 })).filter((s) => s.pairs > 0) } : null,
      })
      if (out.status === 'needs_assortment') { setChoice('new'); setError(out.message); return }
      onResult(box.raw, out)
      if (out.status === 'received') onClose()
      else setError(out.message)
    } catch (e) {
      setError(errText(e, 'Not saved — try again.'))
    } finally { setBusy(false) }
  }

  return (
    <section className="space-y-3 rounded-xl border border-sky-500/40 bg-sky-50/40 p-4 dark:bg-sky-950/20" aria-label="Manual carton entry">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Manual carton entry</h3>
          <p className="text-xs text-muted-foreground">For a carton whose label is damaged or will not scan.</p>
        </div>
        <button onClick={onClose} disabled={busy} className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-muted">Cancel</button>
      </div>

      {!box ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">1. Scan one pair box from this carton</p>
          <p className="text-xs text-muted-foreground">The box label gives the article, colour, MRP and manufacturing date.</p>
          {!cameraActive && <button onClick={onStartCamera} className="w-full rounded-lg bg-foreground px-3 py-2.5 text-sm font-semibold text-background hover:opacity-90">Scan with camera</button>}
          <form onSubmit={(e) => { e.preventDefault(); if (typed.trim()) void readBox(typed.trim()) }} className="flex gap-2">
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="…or type the box code" aria-label="Box code" className={`${inputCls} flex-1 text-xs font-mono`} />
            <button type="submit" disabled={!typed.trim() || busy} className="rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50">{busy ? 'Reading…' : 'Read'}</button>
          </form>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-background p-3 text-xs sm:grid-cols-3">
            <div><span className="block text-muted-foreground">Article</span><span className="font-semibold" data-no-translate>{box.articleName ? `${box.articleName} · ` : ''}{box.articleCode}</span></div>
            <div><span className="block text-muted-foreground">Colour code</span><span className="font-semibold" data-no-translate>{box.colourCode}</span></div>
            <div><span className="block text-muted-foreground">Box size</span><span className="font-semibold">{box.size}</span></div>
            <div><span className="block text-muted-foreground">MRP</span><span className="font-semibold">{box.mrp != null ? `₹${box.mrp}` : '—'}</span></div>
            <div><span className="block text-muted-foreground">Mfg</span><span className="font-semibold">{box.mfg ?? '—'}</span></div>
            <div><span className="block text-muted-foreground">Segment</span><span className="font-semibold">{box.segment ?? 'Not set'}</span></div>
          </div>
          <button onClick={() => { setBox(null); setLines([]); setLineId(null); setTyped('') }} disabled={busy} className="text-xs underline">Scan a different box</button>

          {lines.length === 0 ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {`${box.articleCode} ${box.colourCode} is not on any open proforma invoice (or all its cartons are already received). Pairs per carton come from the invoice, so this carton cannot be entered by hand. Upload the invoice first, or scan its boxes into stock with the warehouse scanner.`}
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">2. Carton size range</p>
              {lines.map((l) => (
                <label key={l.lineId} className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs ${lineId === l.lineId ? 'border-foreground bg-background' : 'border-border'} ${l.fitsBox ? 'cursor-pointer' : 'opacity-50'}`}>
                  <input type="radio" name="manual-line" disabled={!l.fitsBox || busy} checked={lineId === l.lineId} onChange={() => setLineId(l.lineId)} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-semibold">{`Sizes ${l.sizeFrom}–${l.sizeTo} · ${l.pairsPerCarton} pairs per carton`}</span>
                    <span className="block text-muted-foreground">{`Bill ${l.refNo} · ${day(l.billDate)} · ${l.received} of ${l.cartons} cartons received · MRP ₹${l.mrp}`}</span>
                    {!l.fitsBox && <span className="block text-amber-700 dark:text-amber-400">{`Box size ${box.size} is not in this range`}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}

          {line && (
            <div className="space-y-2">
              <p className="text-sm font-medium">3. Pairs in each size</p>
              {line.single ? (
                <p className="text-xs">{`Single-size carton: all ${line.pairsPerCarton} pairs are size ${line.sizeFrom}.`}</p>
              ) : line.assortment ? (
                <p className="text-xs">{`From the bill: ${line.assortment.segment} · ${formatSizes(line.assortment.sizes)}`}</p>
              ) : (
                <div className="space-y-1.5">
                  {line.options.map((o) => (
                    <label key={o.id} className="flex items-center gap-2 text-xs">
                      <input type="radio" name="manual-assortment" checked={choice === o.id} onChange={() => setChoice(o.id)} />
                      <span>{`${o.segment} · ${formatSizes(o.sizes)}`}</span>
                    </label>
                  ))}
                  {line.options.length > 0 && (
                    <label className="flex items-center gap-2 text-xs">
                      <input type="radio" name="manual-assortment" checked={choice === 'new'} onChange={() => setChoice('new')} />
                      <span>None of these: enter the pairs per size</span>
                    </label>
                  )}
                  {choice === 'new' && (
                    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
                      {line.options.length === 0 && <p className="text-xs text-muted-foreground">This assortment is not in the master yet. Enter it once; it is saved to Master → Assortments for the next carton.</p>}
                      <label className="block text-xs">
                        <span className="mb-1 block font-medium">Segment</span>
                        <select value={segment} onChange={(e) => setSegment(e.target.value)} className={`${inputCls} w-full`}>
                          <option value="">Choose…</option>
                          {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </label>
                      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                        {line.sizes.map((s) => (
                          <label key={s} className="text-xs">
                            <span className="mb-0.5 block text-center font-medium">{`Size ${s}`}</span>
                            <input inputMode="numeric" value={pairs[s] ?? ''} onChange={(e) => setPairs((p) => ({ ...p, [s]: e.target.value.replace(/\D/g, '') }))}
                              className={`${inputCls} w-full px-1 text-center`} placeholder="0" aria-label={`Pairs of size ${s}`} />
                          </label>
                        ))}
                      </div>
                      <p className={`text-xs font-medium ${total === line.pairsPerCarton ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}>
                        {`Total ${total} of ${line.pairsPerCarton} pairs (from the invoice)`}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
      {box && lines.length > 0 && (
        <button onClick={receive} disabled={!canReceive} className="w-full rounded-lg bg-foreground px-3 py-2.5 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50">
          {busy ? 'Saving…' : 'Receive carton'}
        </button>
      )}
    </section>
  )
}
