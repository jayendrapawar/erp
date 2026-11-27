'use client'

// Inventory → Overview: old stock, cut size, non-moving / dead, top movers, size mix, reorder.
// One server call when the tab opens (2 queries); period and filters switch on the phone.

import { useEffect, useMemo, useState } from 'react'
import { getInventoryInsights } from '@/app/actions/inventory'
import type { CutRow, InsightVariant, InventoryInsights } from '@/lib/inventory/insights'

const num = new Intl.NumberFormat('en-IN')
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
const mfg = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })

type Section = 'old' | 'cut' | 'nonmoving' | 'dead' | 'movers' | 'reorder'
type CutFilter = 'short' | 'missing' | 'half'

export function OverviewTab({ onOpen }: { onOpen: (articleId: number) => void }) {
  const [data, setData] = useState<InventoryInsights | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [section, setSection] = useState<Section>('movers')
  const [period, setPeriod] = useState<7 | 30 | 90>(30)
  const [cutFilter, setCutFilter] = useState<CutFilter>('short')

  function load() {
    setLoading(true); setError('')
    getInventoryInsights().then(setData).catch(() => setError('Could not load the overview. Try again.')).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const cutRows = useMemo(() => {
    const rows = data?.cut.rows ?? []
    if (cutFilter === 'missing') return rows.filter((r) => r.missing.length > 0)
    if (cutFilter === 'half') return rows.filter((r) => r.short.length * 2 >= r.sizes.length)
    return rows
  }, [data, cutFilter])

  if (!data) {
    return (
      <div className="space-y-3">
        {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">{error} <button onClick={load} className="underline">Retry</button></p>
          : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}</div>}
      </div>
    )
  }

  const r = data.rules
  const historyDays = data.historySince ? Math.floor((Date.now() - new Date(data.historySince).getTime()) / 86_400_000) : 0
  const idleRows = data.idle.rows.filter((x) => (section === 'dead' ? x.idleDays >= r.deadDays : x.idleDays < r.deadDays))

  const cards: { id: Section; label: string; value: string; hint: string; tone?: 'warn' | 'bad' }[] = [
    { id: 'movers', label: 'Top selling (30 days)', value: `${num.format(data.movers[30].pairs)} pairs`, hint: data.movers[30].rows[0] ? `Best: ${data.movers[30].rows[0].artName} ${data.movers[30].rows[0].color}` : 'No sales yet' },
    { id: 'reorder', label: 'Reorder sizes', value: num.format(data.reorder.count), hint: `Less than ${r.reorderCoverDays} days of stock`, tone: data.reorder.count ? 'warn' : undefined },
    { id: 'cut', label: 'Cut size', value: num.format(data.cut.count), hint: 'Article colours with short sizes', tone: data.cut.count ? 'warn' : undefined },
    { id: 'old', label: `Old stock (${r.oldMonths}+ months)`, value: `${num.format(data.old.totals.old)} pairs`, hint: `${num.format(data.old.totals.m6to12)} pairs ${r.midMonths}–${r.oldMonths} months · ${num.format(data.old.totals.unknown)} age unknown`, tone: data.old.totals.old ? 'bad' : undefined },
    { id: 'nonmoving', label: `Non-moving (${r.nonMovingDays}+ days)`, value: num.format(data.idle.nonMoving.count), hint: `${num.format(data.idle.nonMoving.pairs)} pairs not sold`, tone: data.idle.nonMoving.count ? 'warn' : undefined },
    { id: 'dead', label: `Dead stock (${r.deadDays}+ days)`, value: num.format(data.idle.dead.count), hint: `${num.format(data.idle.dead.pairs)} pairs not sold`, tone: data.idle.dead.count ? 'bad' : undefined },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{`Updated ${new Date(data.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}</p>
        <button onClick={load} disabled={loading} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {data.historySince && historyDays < r.nonMovingDays && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
          {`Stock history starts ${day(data.historySince)}. Non-moving and dead stock appear once an article has gone ${r.nonMovingDays} days without a sale, and sales figures grow as billing continues.`}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <button key={c.id} onClick={() => setSection(c.id)}
            className={`rounded-xl border p-3 text-left transition-colors ${section === c.id ? 'border-foreground bg-muted/60' : 'border-border bg-card hover:bg-muted/40'}`}>
            <span className="block text-[11px] font-medium text-muted-foreground">{c.label}</span>
            <span className={`block text-lg font-bold ${c.tone === 'bad' ? 'text-red-600 dark:text-red-400' : c.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''}`}>{c.value}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{c.hint}</span>
          </button>
        ))}
      </div>

      {section === 'movers' && (
        <div className="space-y-4">
          <Segmented value={String(period)} onChange={(v) => setPeriod(Number(v) as 7 | 30 | 90)} options={[['7', '7 days'], ['30', '30 days'], ['90', '90 days']]} />
          <List empty="No pairs billed in this period.">
            {data.movers[period].rows.map((m, i) => (
              <Row key={m.articleId} v={m} onOpen={onOpen} right={<span className="text-sm font-bold">{`${num.format(m.sold)} sold`}</span>}
                lead={<span className="w-6 shrink-0 text-xs font-bold text-muted-foreground">{i + 1}</span>}>
                <SizeChips sizes={m.sizes.map((s) => ({ size: s.size, text: `${period === 7 ? s.sold7 : period === 30 ? s.sold30 : s.sold90}`, tone: s.pairs <= 0 ? 'bad' : undefined }))} caption="sold per size (red = none left)" />
              </Row>
            ))}
          </List>
          <MixTable title="Sizes: sales (30 days) vs stock" rows={data.sizes} keyLabel="Size" />
          <MixTable title="Colours selling most (30 days)" rows={data.colours} keyLabel="Colour" />
        </div>
      )}

      {section === 'reorder' && (
        <List empty="No size is running short against its sales.">
          <p className="px-3 pt-2 text-[11px] text-muted-foreground">{`Sizes whose stock covers less than ${r.reorderCoverDays} days at the last ${r.salesWindowDays} days' sales. Suggested pairs cover ${r.reorderTargetDays} days.`}</p>
          {data.reorder.rows.map((x) => (
            <button key={`${x.articleId}|${x.size}`} onClick={() => onOpen(x.articleId)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{`${x.artName} · ${x.color} · size ${x.size}`}</p>
                <p className="text-[11px] text-muted-foreground">{`${x.artCode} · ${x.pairs} in stock · ${x.sold30} sold in 30 days · ${x.pairs > 0 ? `${x.coverDays} days left` : 'out of stock'}`}</p>
              </div>
              <span className="shrink-0 rounded-lg bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">{`Order ${x.suggest}`}</span>
            </button>
          ))}
        </List>
      )}

      {section === 'cut' && (
        <div className="space-y-3">
          <Segmented value={cutFilter} onChange={(v) => setCutFilter(v as CutFilter)} options={[['short', 'Any size ≤ half'], ['missing', 'Sizes missing'], ['half', 'Half or more short']]} />
          <List empty="No article colour matches this filter.">
            {cutRows.map((c) => (
              <Row key={c.articleId} v={c} onOpen={onOpen} right={<span className="text-xs text-muted-foreground">{`${num.format(c.pairs)} pairs`}</span>}>
                <SizeChips sizes={c.sizes.map((s) => ({ size: s.size, text: String(s.pairs), tone: tone(c, s.size, s.pairs) }))} caption={`pairs per size · fullest ${c.fullest}`} />
              </Row>
            ))}
          </List>
        </div>
      )}

      {section === 'old' && (
        <List empty={`No pairs older than ${r.oldMonths} months (by the manufacturing month on the box).`}>
          {data.old.rows.map((o) => (
            <Row key={o.articleId} v={o} onOpen={onOpen} right={<span className="text-sm font-bold text-red-600 dark:text-red-400">{`${num.format(o.bands.old)} old`}</span>}>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {`${o.oldestMfg ? `Oldest made ${mfg(o.oldestMfg)} · ` : ''}${o.bands.m6to12} pairs ${r.midMonths}–${r.oldMonths} m · ${o.bands.lt6} under ${r.midMonths} m${o.bands.unknown ? ` · ${o.bands.unknown} age unknown` : ''}`}
              </p>
            </Row>
          ))}
        </List>
      )}

      {(section === 'nonmoving' || section === 'dead') && (
        <List empty={section === 'dead' ? `Nothing unsold for ${r.deadDays}+ days.` : `Nothing unsold for ${r.nonMovingDays}–${r.deadDays - 1} days.`}>
          {idleRows.map((x) => (
            <Row key={x.articleId} v={x} onOpen={onOpen} right={<span className={`text-sm font-bold ${section === 'dead' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}>{`${x.idleDays} days`}</span>}>
              <p className="mt-1 text-[11px] text-muted-foreground">{`${num.format(x.pairs)} pairs · ${x.lastSale ? `last sold ${day(x.lastSale)}` : `no sale since it came in (${day(x.since)})`}`}</p>
            </Row>
          ))}
        </List>
      )}
    </div>
  )
}

function tone(c: CutRow, size: string, pairs: number): 'bad' | 'warn' | undefined {
  if (pairs <= 0) return 'bad'
  return c.short.includes(size) ? 'warn' : undefined
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={`rounded-md px-3 py-1.5 font-medium ${value === v ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>{label}</button>
      ))}
    </div>
  )
}

function List({ children, empty }: { children: React.ReactNode; empty: string }) {
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : children ? [children] : []
  const hasRows = items.some((c) => typeof c === 'object' && c !== null && 'key' in c && (c as { key: unknown }).key != null)
  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-card">
      {children}
      {!hasRows && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{empty}</p>}
    </div>
  )
}

function Row({ v, onOpen, right, lead, children }: { v: InsightVariant; onOpen: (id: number) => void; right?: React.ReactNode; lead?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <button onClick={() => onOpen(v.articleId)} className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/40">
      {lead}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold" data-no-translate>{`${v.artName || v.artCode} · ${v.color || v.colorCode}`}</p>
        <p className="truncate text-[11px] text-muted-foreground">{[v.artCode, v.segment, v.division].filter(Boolean).join(' · ')}</p>
        {children}
      </div>
      <div className="shrink-0 pt-0.5">{right}</div>
    </button>
  )
}

function SizeChips({ sizes, caption }: { sizes: { size: string; text: string; tone?: 'bad' | 'warn' }[]; caption: string }) {
  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-1">
        {sizes.map((s) => (
          <span key={s.size} className={`inline-flex min-w-[2.5rem] flex-col items-center rounded-md border px-1.5 py-0.5 text-[10px] leading-tight ${
            s.tone === 'bad' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200'
              : s.tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
                : 'border-border bg-muted/40'}`}>
            <span className="text-muted-foreground">{s.size}</span>
            <span className="font-bold">{s.text}</span>
          </span>
        ))}
      </div>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{caption}</p>
    </div>
  )
}

function MixTable({ title, rows, keyLabel }: { title: string; rows: InventoryInsights['sizes']; keyLabel: string }) {
  const shown = rows.filter((x) => x.sold > 0 || x.pairs > 0)
  if (!shown.length) return null
  return (
    <div className="rounded-xl border border-border bg-card">
      <p className="px-3 pt-2.5 text-sm font-semibold">{title}</p>
      <p className="px-3 text-[11px] text-muted-foreground">Highlighted = selling ahead of its share of stock (order more of it).</p>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr><th className="px-3 py-1.5 text-left">{keyLabel}</th><th className="px-2 py-1.5 text-right">Sold</th><th className="px-2 py-1.5 text-right">% of sales</th><th className="px-2 py-1.5 text-right">In stock</th><th className="px-3 py-1.5 text-right">% of stock</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((x) => (
              <tr key={x.key} className={x.ahead ? 'bg-amber-50 font-semibold dark:bg-amber-950/30' : ''}>
                <td className="px-3 py-1.5" data-no-translate>{x.key}</td>
                <td className="px-2 py-1.5 text-right">{num.format(x.sold)}</td>
                <td className="px-2 py-1.5 text-right">{`${x.soldShare}%`}</td>
                <td className="px-2 py-1.5 text-right">{num.format(x.pairs)}</td>
                <td className="px-3 py-1.5 text-right">{`${x.stockShare}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
