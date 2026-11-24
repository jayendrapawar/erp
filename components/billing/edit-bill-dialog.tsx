'use client'

// Edit bill by scanning (owner, 24 Nov 2026). Opens from a billed bill (Biller → bill → Edit bill).
// Two modes: "Add" puts a scanned box on the bill, "Remove" takes a box on the bill off. Every scan is
// checked on the screen (0 server calls); the new lines and total show at once. Save sends all the
// changes in one call (lib/billing/edit-bill.ts): same bill number and date, stock, amounts, ledger and
// money already set against the bill follow.
//
// Keyboard: the Scan box keeps the cursor (USB / Bluetooth scanners type the code + Enter). "+" or "-"
// typed in the empty Scan box switches Add / Remove. Ctrl+Enter saves, Esc closes.

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { getBillForEdit, saveBillEdit } from '@/app/actions/billing'
import type { BillForEdit, EditedBill } from '@/lib/billing/edit-bill'
import { applyBoxChanges, type EditBox, type EditLine } from '@/lib/billing/bill-edit'
import { readBoxLabel, type BoxLabel } from '@/lib/billing/box-label'
import { computeBillTotals, ratesBp } from '@/lib/billing/bill-totals'
import { playAlreadyScanned, playScanOk } from '@/lib/scan-sound'
import { DialogKeys } from '@/components/dialog-keys'

type Mode = 'add' | 'remove'
type Note = { kind: 'ok' | 'err'; text: string } | null

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const rs = (paise: number) => inr.format(paise / 100)
const boxName = (b: { articleCode: string; colourCode?: string | null; sizeLabel?: string | null }) =>
  [b.articleCode, b.colourCode, b.sizeLabel ? `size ${b.sizeLabel}` : ''].filter(Boolean).join(' · ')

export function EditBillDialog({ orderId, onClose, onSaved }: {
  orderId: number
  onClose: () => void
  onSaved: (r: EditedBill) => void
}) {
  const [bill, setBill] = useState<BillForEdit | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('add')
  const [added, setAdded] = useState<BoxLabel[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [note, setNote] = useState<Note>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [saving, startSave] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    getBillForEdit(orderId)
      .then((b) => { if (live) setBill(b) })
      .catch((e) => { if (live) setLoadErr(e instanceof Error ? e.message : 'Could not open the bill.') })
    return () => { live = false }
  }, [orderId])

  const focusScan = () => setTimeout(() => inputRef.current?.focus(), 0)
  useEffect(() => { if (bill) focusScan() }, [bill])

  const onBill = useMemo(() => new Map((bill?.boxes ?? []).map((b) => [b.dedupeKey, b])), [bill])

  // New lines and total, worked out the same way the server will.
  const preview = useMemo(() => {
    if (!bill) return null
    try {
      const rem: EditBox[] = removed.map((k) => { const b = onBill.get(k)!; return { dedupeKey: k, articleCode: b.articleCode, mrp: b.mrp } })
      const lines = applyBoxChanges(bill.lines, added.map((b) => ({ dedupeKey: b.dedupeKey, articleCode: b.articleCode, mrp: b.mrp })), rem)
      const totals = computeBillTotals(lines, bill.lineDiscPct, bill.taxType, ratesBp(bill.rates))
      return { lines, totals, error: null as string | null }
    } catch (e) {
      return { lines: [] as EditLine[], totals: null, error: e instanceof Error ? e.message : 'These changes do not fit the bill.' }
    }
  }, [bill, added, removed, onBill])

  const changed = added.length + removed.length > 0

  function say(kind: 'ok' | 'err', text: string) {
    setNote({ kind, text })
    if (kind === 'ok') playScanOk(); else playAlreadyScanned()
  }

  function scan(rawInput: string) {
    const raw = rawInput.trim()
    if (!raw || !bill) return
    setSaveErr(null)
    const l = readBoxLabel(raw)
    if (!l.ok) { say('err', l.message); return }
    const box = l.box, key = box.dedupeKey
    if (mode === 'add') {
      if (added.some((b) => b.dedupeKey === key)) return say('err', `Already scanned on: ${boxName(box)}`)
      if (removed.includes(key)) { setRemoved((r) => r.filter((k) => k !== key)); return say('ok', `Back on the bill: ${boxName(box)}`) }
      if (onBill.has(key)) return say('err', `Already on this bill: ${boxName(box)}`)
      if (box.mrp == null) return say('err', `No MRP on this label (${box.articleCode}). It cannot be added here.`)
      setAdded((a) => [...a, box])
      return say('ok', `Added: ${boxName(box)} · MRP ${box.mrp}`)
    }
    if (added.some((b) => b.dedupeKey === key)) { setAdded((a) => a.filter((b) => b.dedupeKey !== key)); return say('ok', `Scan on undone: ${boxName(box)}`) }
    if (removed.includes(key)) return say('err', `Already scanned off: ${boxName(box)}`)
    if (!onBill.has(key)) return say('err', `This box is not on this bill: ${boxName(box)}`)
    setRemoved((r) => [...r, key])
    return say('ok', `Taken off: ${boxName(onBill.get(key)!)}`)
  }

  function close() {
    if (saving) return
    if (changed && !window.confirm('Close without saving? The scanned changes will be lost.')) { focusScan(); return }
    onClose()
  }

  function save() {
    if (!bill || !changed || saving || preview?.error) return
    setSaveErr(null)
    startSave(async () => {
      try {
        const r = await saveBillEdit(orderId, added.map((b) => b.raw), removed)
        onSaved(r)
      } catch (e) {
        setSaveErr(e instanceof Error ? e.message : 'Could not save. Check the connection and try again.')
        focusScan()
      }
    })
  }

  const oldQty = bill?.lines.reduce((s, l) => s + l.qty, 0) ?? 0
  const newTotal = preview?.totals?.grandTotalPaise ?? bill?.grandTotalPaise ?? 0
  const diff = bill ? newTotal - bill.grandTotalPaise : 0
  const qtyBefore = (l: EditLine) => bill?.lines.find((o) => o.artNumber === l.artNumber && Math.abs(o.mrp - l.mrp) < 0.005)?.qty ?? 0

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <DialogKeys onClose={close} label="Edit bill" canClose={!saving} />
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
          <button type="button" onClick={close} aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card hover:bg-muted">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">Edit bill {bill?.billNo ?? ''}</p>
            <p className="truncate text-xs text-muted-foreground">{bill?.shopkeeperName ?? 'Loading…'}</p>
          </div>
        </div>

        {loadErr && <p role="alert" className="m-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">{loadErr}</p>}
        {!bill && !loadErr && <p className="p-6 text-center text-sm text-muted-foreground">Opening the bill…</p>}

        {bill && (
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {/* Left: mode + scan + changes */}
            <div className="flex min-w-0 flex-col gap-3">
              <div role="radiogroup" aria-label="Scan mode" className="grid grid-cols-2 gap-2">
                {(['add', 'remove'] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m}
                    onClick={() => { setMode(m); setNote(null); focusScan() }}
                    className={`rounded-xl border px-3 py-3 text-sm font-semibold transition-colors ${mode === m
                      ? (m === 'add' ? 'border-green-600 bg-green-600 text-white' : 'border-red-600 bg-red-600 text-white')
                      : 'border-border bg-card text-foreground hover:bg-muted'}`}>
                    {m === 'add' ? '+ Add boxes' : '− Remove boxes'}
                  </button>
                ))}
              </div>

              <form onSubmit={(e) => { e.preventDefault(); scan(code); setCode('') }}>
                <label htmlFor="edit-bill-scan" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Scan box to {mode === 'add' ? 'add to' : 'take off'} the bill <span className="text-muted-foreground/70">(type + or − to switch)</span>
                </label>
                <input id="edit-bill-scan" ref={inputRef} value={code} autoComplete="off" spellCheck={false}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (!code && (e.key === '+' || e.key === '-')) { e.preventDefault(); setMode(e.key === '+' ? 'add' : 'remove'); setNote(null) }
                    else if (e.key === 'Tab' && code.trim()) { e.preventDefault(); scan(code); setCode('') }
                  }}
                  placeholder="Scan or type the QR text, then Enter"
                  className={`w-full rounded-xl border-2 bg-background px-3 py-3 font-mono text-sm focus:outline-none ${mode === 'add' ? 'border-green-600/60 focus:border-green-600' : 'border-red-600/60 focus:border-red-600'}`} />
              </form>

              {note && (
                <p role="status" className={`rounded-lg px-3 py-2 text-sm ${note.kind === 'ok' ? 'bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-400' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-400'}`}>
                  {note.text}
                </p>
              )}

              <div className="rounded-xl border border-border bg-card">
                <p className="border-b border-border px-4 py-2.5 text-sm font-semibold text-foreground">
                  Changes <span className="font-normal text-muted-foreground">({added.length} on · {removed.length} off)</span>
                </p>
                {!changed && <p className="px-4 py-5 text-center text-sm text-muted-foreground">Nothing scanned yet. The bill has {bill.boxes.length} scanned box{bill.boxes.length === 1 ? '' : 'es'}.</p>}
                <ul className="divide-y divide-border">
                  {added.map((b) => (
                    <li key={`a-${b.dedupeKey}`} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <span className="w-5 font-bold text-green-600">+</span>
                      <span className="min-w-0 flex-1 truncate">{boxName(b)} <span className="text-muted-foreground">· ₹{b.mrp}</span></span>
                      <button type="button" onClick={() => { setAdded((a) => a.filter((x) => x.dedupeKey !== b.dedupeKey)); focusScan() }}
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline">Undo</button>
                    </li>
                  ))}
                  {removed.map((k) => { const b = onBill.get(k)!; return (
                    <li key={`r-${k}`} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <span className="w-5 font-bold text-red-600">−</span>
                      <span className="min-w-0 flex-1 truncate">{boxName(b)} <span className="text-muted-foreground">· ₹{b.mrp ?? 0}</span></span>
                      <button type="button" onClick={() => { setRemoved((r) => r.filter((x) => x !== k)); focusScan() }}
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline">Undo</button>
                    </li>
                  ) })}
                </ul>
              </div>
            </div>

            {/* Right: the bill after the changes */}
            <div className="flex min-w-0 flex-col gap-3">
              <div className="rounded-xl border border-border bg-card">
                <p className="border-b border-border px-4 py-2.5 text-sm font-semibold text-foreground">Bill after changes</p>
                {preview?.error
                  ? <p role="alert" className="px-4 py-4 text-sm text-red-600 dark:text-red-400">{preview.error}</p>
                  : (
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr><th className="px-4 py-2 text-left font-medium">Article</th><th className="px-3 py-2 text-right font-medium">MRP</th><th className="px-4 py-2 text-right font-medium">Qty</th></tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {preview?.lines.map((l, i) => { const d = l.qty - qtyBefore(l); return (
                          <tr key={`${l.artNumber}-${l.mrp}-${i}`} className={d ? 'bg-muted/30' : ''}>
                            <td className="px-4 py-1.5 font-medium">{l.artNumber}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{l.mrp}</td>
                            <td className="px-4 py-1.5 text-right tabular-nums font-semibold">
                              {l.qty}{d !== 0 && <span className={`ml-1 text-xs ${d > 0 ? 'text-green-600' : 'text-red-600'}`}>({d > 0 ? `+${d}` : d})</span>}
                            </td>
                          </tr>
                        ) })}
                        {bill.lines.filter((o) => !preview?.lines.some((l) => l.artNumber === o.artNumber && Math.abs(l.mrp - o.mrp) < 0.005)).map((o, i) => (
                          <tr key={`gone-${i}`} className="bg-muted/30 text-muted-foreground line-through">
                            <td className="px-4 py-1.5">{o.artNumber}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{o.mrp}</td>
                            <td className="px-4 py-1.5 text-right tabular-nums">0 <span className="text-xs text-red-600 no-underline">(−{o.qty})</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>
              <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
                <div className="flex justify-between text-muted-foreground"><span>Pairs</span><span className="tabular-nums">{oldQty} → {preview?.totals?.totalQty ?? oldQty}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Bill total now</span><span className="tabular-nums">{rs(bill.grandTotalPaise)}</span></div>
                <div className="mt-1 flex justify-between text-base font-bold text-foreground">
                  <span>New total</span>
                  <span className="tabular-nums">{rs(newTotal)}{diff !== 0 && <span className={`ml-2 text-sm ${diff > 0 ? 'text-green-600' : 'text-red-600'}`}>({diff > 0 ? '+' : '−'}{rs(Math.abs(diff))})</span>}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Same bill number and date. Boxes taken off go back to stock. Any payment already set against this bill stays set against it.</p>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        {bill && (
          <div className="shrink-0 border-t border-border px-4 py-3">
            {saveErr && <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-400">{saveErr}</p>}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={close} disabled={saving}
                className="rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold hover:bg-muted disabled:opacity-50">Close</button>
              <button type="button" data-primary onClick={save} disabled={!changed || saving || !!preview?.error}
                className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {saving ? 'Saving…' : `Save changes${changed ? ` (${added.length} on, ${removed.length} off)` : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
