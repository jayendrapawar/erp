'use client'

// Choose a party by typing (name, area, city or phone). ↑↓ move, Enter picks, Esc clears the list.
// A real combobox (ARIA), so it works with the keyboard alone and with a screen reader.

import { useId, useMemo, useRef, useState } from 'react'
import { fuzzyFilter } from '@/lib/fuzzy'
import type { PartyChoice } from '@/lib/payments/queries'

export function PartyPicker({ parties, value, onChange, label = 'Party', autoFocus, id }: {
  parties: PartyChoice[]
  value: PartyChoice | null
  onChange: (p: PartyChoice | null) => void
  label?: string
  autoFocus?: boolean
  id?: string
}) {
  const auto = useId()
  const inputId = id ?? `party-${auto}`
  const listId = `${inputId}-list`
  const [text, setText] = useState(value?.name ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(
    () => (text.trim() ? fuzzyFilter(parties, text, (p) => [p.name, p.area, p.city, p.phone]) : parties).slice(0, 12),
    [parties, text],
  )
  const pick = (p: PartyChoice) => { onChange(p); setText(p.name); setOpen(false) }

  if (value) {
    return (
      <div className="min-w-0">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="mt-1 flex h-11 items-center gap-2 rounded-xl border border-border bg-muted/40 px-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold" data-no-translate>{value.name}</span>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">{[value.area, value.city].filter(Boolean).join(', ')}</span>
          <button type="button" onClick={() => { onChange(null); setText(''); setTimeout(() => inputRef.current?.focus(), 0) }}
            className="shrink-0 rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-muted">Change</button>
        </div>
      </div>
    )
  }
  return (
    <div className="relative min-w-0">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        ref={inputRef} id={inputId} autoFocus={autoFocus} autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={open && results.length > 0} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        value={text} placeholder="Type name, area or phone…"
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter' && open && results[active]) { e.preventDefault(); pick(results[active]) }
          else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
        }}
        className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {open && results.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-xl">
          {results.map((p, i) => (
            <li key={p.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(p) }} onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${i === active ? 'bg-primary text-primary-foreground' : ''}`}>
              <span className="truncate font-medium" data-no-translate>{p.name}</span>
              <span className={`shrink-0 truncate text-xs ${i === active ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>{[p.area, p.city].filter(Boolean).join(', ') || p.phone}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
