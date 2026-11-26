'use client'

// Warehouse Scanner: count a sealed carton at stocktake (lib/inventory/stocktake-carton.ts).
// Shows the proposed pairs per size; the worker confirms it, chooses another, or types the pairs.
// "Don't count" drops a carton label scanned by mistake (nothing is saved).

import { useMemo, useState } from 'react'
import { SEGMENTS, describeOnlyFor, formatSizes } from '@/lib/catalog/assortments'
import type { AssortmentAnswer } from '@/lib/purchases/assortment-entry'
import type { StocktakeCartonAsk } from '@/lib/inventory/stocktake-carton'

const inputCls = 'rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring'

type Props = {
  ask: StocktakeCartonAsk
  /** Cartons scanned while this card is open (they come next). */
  waiting: number
  busy: boolean
  error: string
  onCount: (answer: AssortmentAnswer) => void
  onCancel: () => void
}

export function StocktakeCartonCard({ ask, waiting, busy, error, onCount, onCancel }: Props) {
  const single = ask.sizes.length === 1
  const [choice, setChoice] = useState<number | 'new' | null>(ask.proposal?.id ?? (ask.options.length && !single ? null : 'new'))
  const [segment, setSegment] = useState(ask.articleSegment ?? '')
  const [pairs, setPairs] = useState<Record<string, string>>(() => (single && ask.invoicePairs ? { [ask.sizes[0]]: String(ask.invoicePairs) } : {}))
  const total = useMemo(() => Object.values(pairs).reduce((n, v) => n + (Number(v) || 0), 0), [pairs])
  // The suggested one first, then the invoice's pairs per carton.
  const options = useMemo(() => [...ask.options].sort((a, b) =>
    Number(b.id === ask.proposal?.id) - Number(a.id === ask.proposal?.id)
    || Number(b.packing === ask.invoicePairs) - Number(a.packing === ask.invoicePairs)), [ask])
  const chosen = typeof choice === 'number' ? ask.options.find((o) => o.id === choice) ?? null : null
  const typedOk = total > 0 && (ask.invoicePairs == null || total === ask.invoicePairs) && (single || Boolean(segment))
  const ready = !busy && (chosen != null || (choice === 'new' && typedOk))
  const countPairs = chosen ? chosen.packing : total

  function count() {
    if (!ready) return
    if (chosen) onCount({ assortmentId: chosen.id, addArticle: !chosen.covers })
    else onCount({ newAssortment: { segment, sizes: ask.sizes.map((s) => ({ size: s, pairs: Number(pairs[s]) || 0 })).filter((s) => s.pairs > 0) } })
  }

  return (
    <section data-form className="space-y-3 rounded-xl border-2 border-sky-500/60 bg-sky-50/50 p-4 dark:bg-sky-950/20" aria-label="Count carton">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">Carton — count for stocktake</p>
        <p className="text-sm font-semibold" data-no-translate>{ask.label}</p>
        <p className="text-xs text-muted-foreground" data-no-translate>
          {[ask.articleName, ask.mrp != null ? `MRP ₹${ask.mrp.toFixed(2)}` : null, ask.division, ask.invoicePairs ? `${ask.invoicePairs} pairs per carton on earlier invoices` : null].filter(Boolean).join(' · ')}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">Count only a sealed carton. If it was opened and its boxes were scanned, don&apos;t count it.</p>
        {ask.warnings.map((w) => <p key={w} className="mt-1 text-xs text-amber-700 dark:text-amber-400">{w}</p>)}
      </div>

      <div className="space-y-1.5">
        {!single && <p className="text-sm font-medium">{ask.options.length ? 'Pairs in each size — check against the carton' : 'Pairs in each size'}</p>}
        {ask.options.length > 0 && !single && !ask.proposal && <p className="text-xs text-amber-700 dark:text-amber-400">More than one assortment fits. Choose the one in this carton.</p>}
        {!single && options.map((o) => (
          <label key={o.id} className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs ${choice === o.id ? 'border-foreground bg-background' : 'border-border'}`}>
            <input type="radio" name="stocktake-assortment" checked={choice === o.id} onChange={() => setChoice(o.id)} disabled={busy} className="mt-0.5" />
            <span>
              <span className="font-mono text-sm font-semibold">{formatSizes(o.sizes)}</span>
              <span className="ml-1.5 font-semibold">{`${o.packing} pairs`}</span>
              <span className="ml-1.5 text-muted-foreground">{o.segment}</span>
              {o.id === ask.proposal?.id && <span className="ml-1.5 rounded bg-green-100 px-1 py-px text-[10px] font-semibold text-green-800 dark:bg-green-900/40 dark:text-green-300">Suggested</span>}
              {ask.invoicePairs != null && o.packing !== ask.invoicePairs && <span className="block text-[11px] text-amber-700 dark:text-amber-400">{`Invoices show ${ask.invoicePairs} pairs for this carton`}</span>}
              {o.onlyFor && (
                <span className={`block text-[11px] ${o.covers ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}`} data-no-translate>
                  {o.covers ? `Only for ${describeOnlyFor(o.onlyFor)}` : `Only for ${describeOnlyFor(o.onlyFor)} — choosing it uses it for ${ask.articleCode} too`}
                </span>
              )}
            </span>
          </label>
        ))}
        {ask.options.length > 0 && !single && (
          <label className="flex items-center gap-2 px-2.5 text-xs">
            <input type="radio" name="stocktake-assortment" checked={choice === 'new'} onChange={() => setChoice('new')} disabled={busy} />
            <span>None of these is right: enter the pairs per size</span>
          </label>
        )}
        {choice === 'new' && (
          <div className="space-y-2 rounded-lg border border-border bg-background p-3">
            {!single && (
              <>
                <p className="text-xs text-muted-foreground">{ask.options.length ? 'Saved for this article in Master → Assortments (or, when the same pairs are already there, that one is used).' : 'No assortment for this carton in the master yet. Enter it once; it is saved to Master → Assortments for the next carton.'}</p>
                <label className="block text-xs">
                  <span className="mb-1 block font-medium">Segment</span>
                  <select value={segment} onChange={(e) => setSegment(e.target.value)} disabled={busy} className={`${inputCls} w-full`}>
                    <option value="">Choose…</option>
                    {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </>
            )}
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {ask.sizes.map((s) => (
                <label key={s} className="text-xs">
                  <span className="mb-0.5 block text-center font-medium">{`Size ${s}`}</span>
                  <input inputMode="numeric" value={pairs[s] ?? ''} onChange={(e) => setPairs((p) => ({ ...p, [s]: e.target.value.replace(/\D/g, '').slice(0, 3) }))} disabled={busy}
                    className={`${inputCls} w-full px-1 text-center`} placeholder="0" aria-label={`Pairs of size ${s}`} />
                </label>
              ))}
            </div>
            <p className={`text-xs font-medium ${typedOk ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {ask.invoicePairs != null ? `Total ${total} of ${ask.invoicePairs} pairs (from earlier invoices)` : `Total ${total} pairs`}
            </p>
          </div>
        )}
      </div>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
      <div className="flex gap-2">
        <button data-primary onClick={count} disabled={!ready} className="flex-1 rounded-lg bg-foreground px-3 py-2.5 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50">
          {busy ? 'Saving…' : countPairs > 0 ? `Count carton (+${countPairs} pairs)` : 'Count carton'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg border border-border px-3 py-2.5 text-sm font-semibold hover:bg-muted disabled:opacity-50">
          Don&apos;t count
        </button>
      </div>
      {waiting > 0 && <p className="text-[11px] text-muted-foreground">{`${waiting} more carton(s) scanned — they come next.`}</p>}
    </section>
  )
}
