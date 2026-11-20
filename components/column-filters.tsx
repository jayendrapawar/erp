'use client'

// Per-column filters for lists (owner, 20 Nov 2026: replaces the single search bar).
// Wide screens: a row of filter boxes under the table headings (<FilterRow>).
// Phones (cards, no columns): a "Filters" button with a badge that opens the same filters (<FiltersButton>).
// Text filters match "contains", ignoring case, spaces and dashes (ss101 finds SS-101).

import { useState } from 'react'

export interface ColumnFilterDef<T> {
  key: string
  label: string
  /** 'text' = contains; 'select' = one of the options (blank option = all). */
  kind: 'text' | 'select'
  get: (row: T) => string | null | undefined
  options?: readonly string[]
  placeholder?: string
}

export type FilterValues = Record<string, string>

/** "(blank)" option value for select filters: rows with no value. */
export const BLANK = '__blank__'

const squash = (v: unknown) => String(v ?? '').toLowerCase().replace(/[\s\-_/.]+/g, '')

export function applyColumnFilters<T>(rows: T[], defs: readonly ColumnFilterDef<T>[], values: FilterValues): T[] {
  const active = defs.filter(d => (values[d.key] ?? '').trim() !== '')
  if (!active.length) return rows
  return rows.filter(row => active.every(d => {
    const want = values[d.key].trim()
    const have = d.get(row)
    if (d.kind === 'select') return want === BLANK ? !String(have ?? '').trim() : String(have ?? '').toLowerCase() === want.toLowerCase()
    return squash(have).includes(squash(want))
  }))
}

export const activeFilterCount = (values: FilterValues) => Object.values(values).filter(v => (v ?? '').trim() !== '').length

const boxCls = 'w-full min-w-[4rem] rounded-md border border-border bg-background px-2 py-1 text-xs font-normal normal-case tracking-normal text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring'

function FilterInput<T>({ def, value, onChange }: { def: ColumnFilterDef<T>; value: string; onChange: (v: string) => void }) {
  if (def.kind === 'select') {
    return (
      <select value={value} onChange={e => onChange(e.target.value)} aria-label={`Filter ${def.label}`} className={boxCls}>
        <option value="">All</option>
        {(def.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        <option value={BLANK}>(blank)</option>
      </select>
    )
  }
  return (
    <input type="search" value={value} onChange={e => onChange(e.target.value)} aria-label={`Filter ${def.label}`}
      placeholder={def.placeholder ?? 'Filter…'} className={boxCls} />
  )
}

/** A table-head row: one filter cell per column (null = no filter for that column). */
export function FilterRow<T>({ columns, values, onChange, firstCellClass = 'pl-4 pr-2', cellClass = 'px-2' }: {
  columns: (ColumnFilterDef<T> | null)[]
  values: FilterValues
  onChange: (values: FilterValues) => void
  firstCellClass?: string
  cellClass?: string
}) {
  return (
    <tr className="border-b border-border bg-muted/20">
      {columns.map((def, i) => (
        <th key={def?.key ?? `x${i}`} className={`${i === 0 ? firstCellClass : cellClass} py-1.5 text-left align-top`}>
          {def ? <FilterInput def={def} value={values[def.key] ?? ''} onChange={v => onChange({ ...values, [def.key]: v })} /> : null}
        </th>
      ))}
    </tr>
  )
}

/** Phones: a "Filters" button with a count; opens the same filters as a small form. */
export function FiltersButton<T>({ defs, values, onChange, className = '' }: {
  defs: readonly ColumnFilterDef<T>[]
  values: FilterValues
  onChange: (values: FilterValues) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const n = activeFilterCount(values)
  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className={`rounded-lg border px-3 py-2 text-xs font-medium ${n ? 'border-foreground bg-muted' : 'border-border hover:bg-muted'}`}>
          {n ? `Filters (${n})` : 'Filters'}
        </button>
        {n > 0 && <button type="button" onClick={() => onChange({})} className="text-xs underline">Clear</button>}
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-3">
          {defs.map(d => (
            <label key={d.key} className="text-[11px] font-medium text-muted-foreground">
              <span className="mb-0.5 block">{d.label}</span>
              <FilterInput def={d} value={values[d.key] ?? ''} onChange={v => onChange({ ...values, [d.key]: v })} />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/** Wide screens, card lists (no table columns): the filters as a row of labelled boxes. */
export function FilterBar<T>({ defs, values, onChange, className = '' }: {
  defs: readonly ColumnFilterDef<T>[]
  values: FilterValues
  onChange: (values: FilterValues) => void
  className?: string
}) {
  const n = activeFilterCount(values)
  return (
    <div className={`hidden items-end gap-2 sm:flex ${className}`}>
      <div className="grid flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${defs.length}, minmax(0, 1fr))` }}>
        {defs.map(d => (
          <label key={d.key} className="text-[11px] font-medium text-muted-foreground">
            <span className="mb-0.5 block">{d.label}</span>
            <FilterInput def={d} value={values[d.key] ?? ''} onChange={v => onChange({ ...values, [d.key]: v })} />
          </label>
        ))}
      </div>
      {n > 0 && <button type="button" onClick={() => onChange({})} className="pb-1.5 text-xs underline">Clear</button>}
    </div>
  )
}

/** Wide screens: shows how many filters are on, with Clear (the filter boxes are in the table). */
export function FilterSummary({ values, onChange, shown, total }: { values: FilterValues; onChange: (v: FilterValues) => void; shown: number; total: number }) {
  const n = activeFilterCount(values)
  if (!n) return null
  return (
    <p className="text-xs text-muted-foreground">
      {`${shown} of ${total} shown · ${n} filter(s) on`} <button type="button" onClick={() => onChange({})} className="underline">Clear filters</button>
    </p>
  )
}
