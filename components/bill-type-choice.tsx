'use client'

// Bill type on the billing screens (owner, 23 Nov 2026): within the state (CGST + SGST), outside the
// state (IGST) or without GST. Starts from the retailer's type (Master → Retailers); the biller can
// change it for one bill. Arrow keys move between the choices (one radio group).

import type { TaxType } from '@/lib/billing/bill-totals'
import { TAX_TYPE_LABEL, TAX_TYPE_SHORT } from '@/lib/billing/bill-amounts'

const ORDER: TaxType[] = ['intra_state', 'inter_state', 'untaxed']
/** Button words short enough for the narrow Total panel (full name on hover and in the note). */
const BUTTON: Record<TaxType, string> = { intra_state: 'In state', inter_state: 'Out of state', untaxed: 'No GST' }

export function BillTypeChoice({ value, onChange, partyDefault, disabled, compact }: {
  value: TaxType
  onChange: (t: TaxType) => void
  /** The retailer's own type; a different choice is marked "changed". */
  partyDefault?: TaxType | null
  disabled?: boolean
  compact?: boolean
}) {
  const changed = !!partyDefault && partyDefault !== value
  return (
    <div className="min-w-0">
      <div role="radiogroup" aria-label="Bill type" className="flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {ORDER.map((t) => {
          const on = t === value
          return (
            <button key={t} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} disabled={disabled}
              title={TAX_TYPE_LABEL[t]}
              onClick={() => onChange(t)}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                if (!step) return
                e.preventDefault()
                const next = ORDER[(ORDER.indexOf(value) + step + ORDER.length) % ORDER.length]
                onChange(next)
                ;(e.currentTarget.parentElement?.querySelector(`[data-tax="${next}"]`) as HTMLElement | null)?.focus()
              }}
              data-tax={t}
              className={`min-w-0 flex-1 whitespace-nowrap rounded-lg px-1.5 font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${compact ? 'h-7 text-[11px]' : 'h-9 text-xs'} ${
                on ? (t === 'untaxed' ? 'bg-amber-500 text-white' : 'bg-primary text-primary-foreground') : 'text-muted-foreground hover:bg-background hover:text-foreground'
              }`}>
              {BUTTON[t]}
            </button>
          )
        })}
      </div>
      {changed && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          {`Changed for this bill — the party is "${TAX_TYPE_SHORT[partyDefault!]}" in the master.`}
        </p>
      )}
    </div>
  )
}
