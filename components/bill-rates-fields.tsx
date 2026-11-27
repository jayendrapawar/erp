'use client'

// Bill discount and GST rates on one bill (owner, 24 Nov 2026): they show the defaults (Master → Bill
// template) for the chosen bill type and change only when typed. A changed box is marked; Reset puts
// the defaults back. Only the taxes the bill type has are shown.

import { billRatesFor, type BillRates, type TaxType } from '@/lib/billing/bill-totals'

/** What was typed, as text (so a box can be empty while typing). */
export type RateEdits = Partial<Record<keyof BillRates, string>>

const LABEL: Record<keyof BillRates, string> = { discountPct: 'Bill disc', cgstPct: 'CGST', sgstPct: 'SGST', igstPct: 'IGST' }

/** The rates the bill uses, and a message when a typed value is not 0–100 %. */
export function resolveRates(taxType: TaxType, defaults: BillRates, edits: RateEdits): { rates: BillRates; changed: boolean; error: string } {
  const base = billRatesFor(taxType, defaults)
  const out = { ...base }
  let error = '', changed = false
  for (const k of Object.keys(edits) as (keyof BillRates)[]) {
    const raw = edits[k]
    if (raw === undefined) continue
    const v = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(v) || v < 0 || v > 100) { error ||= `${LABEL[k]} % must be between 0 and 100.`; continue }
    out[k] = Math.round(v * 100) / 100
    if (out[k] !== base[k]) changed = true
  }
  return { rates: out, changed, error }
}

export function BillRatesFields({ taxType, defaults, edits, onChange, disabled, compact }: {
  taxType: TaxType
  defaults: BillRates
  edits: RateEdits
  onChange: (e: RateEdits) => void
  disabled?: boolean
  compact?: boolean
}) {
  const base = billRatesFor(taxType, defaults)
  const keys: (keyof BillRates)[] = taxType === 'intra_state' ? ['discountPct', 'cgstPct', 'sgstPct']
    : taxType === 'inter_state' ? ['discountPct', 'igstPct'] : ['discountPct']
  const anyEdit = keys.some((k) => edits[k] !== undefined && Number(edits[k]) !== base[k])
  return (
    <div className={compact ? 'flex flex-wrap items-center gap-x-2 gap-y-1.5' : 'grid grid-cols-3 items-end gap-2'} role="group" aria-label="Bill discount and GST rates">
      {keys.map((k) => {
        const typed = edits[k]
        const edited = typed !== undefined && Number(typed) !== base[k]
        const bad = typed !== undefined && (typed.trim() === '' || !(Number(typed) >= 0 && Number(typed) <= 100))
        return (
          <label key={k} className={`text-[11px] text-muted-foreground ${compact ? 'flex items-center gap-1' : 'block min-w-0'}`} title={`Default ${base[k]} %`}>
            {`${LABEL[k]} %`}
            <input type="number" inputMode="decimal" min={0} max={100} step={0.01} disabled={disabled}
              value={typed ?? String(base[k])}
              onChange={(e) => onChange({ ...edits, [k]: e.target.value })}
              className={`${compact ? 'h-7 w-14' : 'mt-0.5 h-8 w-full'} rounded-lg border bg-background px-1 text-center text-sm tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${
                bad ? 'border-red-500' : edited ? 'border-amber-500 bg-amber-500/10' : 'border-input'
              }`} />
          </label>
        )
      })}
      {anyEdit && (
        <button type="button" onClick={() => onChange({})} disabled={disabled}
          className={`text-[11px] font-semibold text-amber-700 underline hover:no-underline dark:text-amber-300 ${compact ? "" : "col-span-3 justify-self-end"}`}>
          Reset
        </button>
      )}
    </div>
  )
}
