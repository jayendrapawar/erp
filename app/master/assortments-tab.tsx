'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { applyAssortmentUpload, previewAssortmentUpload, retireAssortment, saveAssortment, type UploadPreview } from '@/app/actions/assortments'
import type { Assortment } from '@/lib/catalog/assortment-store'
import { DIVISIONS, SEGMENTS, SIZE_COLUMNS, codeSizes, formatSizes, validateAssortment } from '@/lib/catalog/assortments'
import { UploadGuide } from '@/components/upload-guide'
import { activeFilterCount, applyColumnFilters, FilterRow, FiltersButton, FilterSummary, type ColumnFilterDef, type FilterValues } from '@/components/column-filters'

const ASSORTMENT_FILTERS: ColumnFilterDef<Assortment>[] = [
  { key: 'division', label: 'Division', kind: 'select', options: DIVISIONS, get: a => a.division },
  { key: 'segment', label: 'Segment', kind: 'select', options: SEGMENTS, get: a => a.segment },
  { key: 'packing', label: 'Pairs', kind: 'text', get: a => String(a.packing) },
  { key: 'code', label: 'Code', kind: 'text', get: a => a.code },
  { key: 'sizes', label: 'Pairs per size', kind: 'text', placeholder: 'e.g. 6×4', get: a => formatSizes(a.sizes) },
  { key: 'version', label: 'Ver.', kind: 'text', get: a => `v${a.version}` },
  { key: 'note', label: 'Note', kind: 'text', get: a => a.note },
  { key: 'onlyFor', label: 'Only for', kind: 'text', placeholder: 'article code', get: a => a.onlyFor || 'any' },
]

const ASSORTMENT_COLUMNS = [
  { name: 'Division', required: true, example: 'Flite EVA', help: 'Sparx, Flite EVA, Flite PU or Bahamas.' },
  { name: 'Segment', required: true, example: 'Gents', help: 'Gents, Ladies, Kids or Baby.' },
  { name: 'Pairs per carton', required: true, example: '24', help: 'Total pairs in one carton (the proforma invoice\u2019s Pair/Ctn).' },
  { name: 'Assortment code', required: true, example: '610', help: 'Size range as on the carton: 610 = sizes 6\u201310, 305 = 3\u20135, 1101 = 11, 12, 13, 1.' },
  { name: '1 \u2026 13', required: true, example: '6', help: 'One column per size: pairs of that size in the carton (blank = none). They must add up to Pairs per carton.' },
  { name: 'Total', required: false, example: '24', help: 'Optional check: sum of the sizes.' },
  { name: 'Note', required: false, example: '', help: 'Optional remark.' },
  { name: 'Only for articles', required: false, example: 'HC003G, TR002G', help: 'Article codes this assortment is only for (blank = any article). A note like "Hawaii only: HC003G, TR002G" is read the same way. Another article with the same pairs is asked: use this assortment too, or enter a new one.' },
]

interface Props {
  initialAssortments: Assortment[]
  canEdit: boolean
}

interface Form {
  id?: number
  division: string
  newDivision: string
  segment: string
  packing: string
  code: string
  pairs: Record<string, string>
  note: string
  onlyFor: string
}

const NEW_DIVISION = '__new__'
const EMPTY: Form = { division: DIVISIONS[0], newDivision: '', segment: SEGMENTS[0], packing: '', code: '', pairs: {}, note: '', onlyFor: '' }
const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'
const labelCls = 'text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1'

const STATUS_STYLE = {
  new: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  changed: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  same: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
} as const
const STATUS_LABEL = { new: 'New', changed: 'New version', same: 'No change', error: 'Error' } as const

/** Master → Assortments: pairs per size inside one carton, per division. Versioned and audited. */
export function AssortmentsTab({ initialAssortments, canEdit }: Props) {
  const [list, setList] = useState<Assortment[]>(initialAssortments)
  const [division, setDivision] = useState<string>('all')
  const [filters, setFilters] = useState<FilterValues>({})
  const [form, setForm] = useState<Form | null>(null)
  const [formError, setFormError] = useState('')
  const [retiring, setRetiring] = useState<Assortment | null>(null)
  const [retireReason, setRetireReason] = useState('')
  const [upload, setUpload] = useState<UploadPreview | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const [busy, start] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  const divisions = useMemo(() => [...new Set([...DIVISIONS, ...list.map(a => a.division)])], [list])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of list) m.set(a.division, (m.get(a.division) ?? 0) + 1)
    return m
  }, [list])
  const filtered = useMemo(() => applyColumnFilters(list.filter(a => division === 'all' || a.division === division), ASSORTMENT_FILTERS, filters), [list, division, filters])

  // ── Add / edit ─────────────────────────────────────────────
  const formInput = form && {
    division: form.division === NEW_DIVISION ? form.newDivision : form.division,
    segment: form.segment, packing: Number(form.packing), code: form.code, note: form.note, onlyFor: form.onlyFor,
    sizes: SIZE_COLUMNS.map(size => ({ size, pairs: form.pairs[size]?.trim() ? Number(form.pairs[size]) : 0 })),
  }
  const check = formInput ? validateAssortment(formInput, form!.division === NEW_DIVISION ? [...divisions, form!.newDivision.trim()] : divisions) : null
  const total = formInput ? formInput.sizes.reduce((n, s) => n + (Number.isFinite(s.pairs) ? s.pairs : 0), 0) : 0
  const rangeSizes = form ? codeSizes(form.code.trim().toUpperCase()) : null

  function openAdd() {
    setForm({ ...EMPTY, division: division !== 'all' ? division : EMPTY.division, segment: filters.segment && filters.segment !== '__blank__' ? filters.segment : EMPTY.segment })
    setFormError('')
  }
  function openEdit(a: Assortment) {
    setForm({ id: a.id, division: a.division, newDivision: '', segment: a.segment, packing: String(a.packing), code: a.code,
      pairs: Object.fromEntries(a.sizes.map(s => [s.size, String(s.pairs)])), note: a.note, onlyFor: a.onlyFor.split(',').filter(Boolean).join(', ') })
    setFormError('')
  }
  function save() {
    if (!form || !formInput || !check) return
    if (check.errors.length) { setFormError(check.errors.join(' ')); return }
    setFormError('')
    start(async () => {
      try {
        setList(await saveAssortment({ ...formInput, id: form.id, newDivision: form.division === NEW_DIVISION }))
        if (form.division === NEW_DIVISION) setDivision(check.value.division)
        setForm(null)
      } catch (e) { setFormError(e instanceof Error ? e.message : 'Could not save.') }
    })
  }
  function confirmRetire() {
    if (!retiring) return
    const id = retiring.id
    start(async () => {
      try { setList(await retireAssortment(id, retireReason)); setRetiring(null) }
      catch (e) { setFormError(e instanceof Error ? e.message : 'Could not remove.') }
    })
  }

  // ── Excel upload ───────────────────────────────────────────
  function chooseFile(f: File | undefined) {
    if (!f) return
    setUpload(null); setUploadMsg('')
    const fd = new FormData()
    fd.append('file', f)
    start(async () => {
      try { setUpload(await previewAssortmentUpload(fd)) }
      catch (e) { setUploadMsg(e instanceof Error ? e.message : 'Could not read the file.') }
      if (fileRef.current) fileRef.current.value = ''
    })
  }
  const tally = upload ? upload.lines.reduce((t, l) => ({ ...t, [l.status]: t[l.status] + 1 }), { new: 0, changed: 0, same: 0, error: 0 }) : null
  function applyUpload() {
    if (!upload) return
    start(async () => {
      try {
        const { result, list: next } = await applyAssortmentUpload(upload.rows, upload.fileName)
        setList(next)
        setUpload(null)
        setUploadMsg(`Saved: ${result.created} new, ${result.updated} new versions, ${result.unchanged} unchanged.`)
      } catch (e) { setUploadMsg(e instanceof Error ? e.message : 'Upload failed.') }
    })
  }

  const exportHref = `/api/assortments/export${division !== 'all' ? `?division=${encodeURIComponent(division)}` : ''}`

  return (
    <div>
      {/* Division chips */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {['all', ...divisions].map(d => (
          <button key={d} onClick={() => setDivision(d)}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${division === d ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`}>
            {d === 'all' ? `All (${list.length})` : `${d} (${counts.get(d) ?? 0})`}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <FiltersButton className="sm:hidden" defs={ASSORTMENT_FILTERS} values={filters} onChange={setFilters} />
        <div className="hidden sm:block"><FilterSummary values={filters} onChange={setFilters} shown={filtered.length} total={list.length} /></div>
        <a href={exportHref} className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted transition-colors">Download Excel</a>
        {canEdit && (
          <>
            <button onClick={() => { setUploadOpen(true); setUpload(null); setUploadMsg('') }} className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted transition-colors">Upload Excel</button>
            <button onClick={openAdd} className="rounded-lg bg-foreground text-background px-3 py-2 text-xs font-semibold hover:opacity-90 transition-opacity">+ Add</button>
            <UploadGuide
              title="How to upload assortments"
              steps={[
                'Download the template (or Download Excel for the current list) and fill one row per assortment.',
                'The first row must hold the column names below; the sheet \u201cHow to fill\u201d in the template explains them too.',
                'Tap Upload Excel and choose the file. You see every change first; nothing is saved until you confirm.',
                'A changed assortment is saved as a new version; cartons already received keep the old one.',
              ]}
              columns={ASSORTMENT_COLUMNS}
              templateHref="/api/assortments/export?template=1"
            />
          </>
        )}
      </div>

      {uploadMsg && !uploadOpen && <p className="mb-3 text-xs rounded-lg px-3 py-2 bg-muted text-foreground">{uploadMsg}</p>}

      {filtered.length === 0 && (
        <p className="text-center py-10 text-sm text-muted-foreground">
          {list.length === 0 ? 'No assortments yet. Download the template, fill it in Excel and upload it, or add one by hand.' : 'No assortments match.'}
        </p>
      )}

      {/* Phone: cards */}
      <div className="sm:hidden space-y-2">
        {filtered.map(a => (
          <div key={a.id} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-semibold text-sm text-foreground">{a.code} <span className="font-normal text-muted-foreground">· {a.packing} pairs</span></p>
              <span className="text-[11px] text-muted-foreground">{a.division} · {a.segment}</span>
            </div>
            <p className="mt-1 font-mono text-xs text-foreground">{formatSizes(a.sizes)}</p>
            {a.note && <p className="mt-1 text-xs text-muted-foreground">{a.note}</p>}
            {a.onlyFor && <p className="mt-1 text-xs font-mono text-amber-700 dark:text-amber-400" data-no-translate>{`Only for ${a.onlyFor.split(',').join(', ')}`}</p>}
            {canEdit && (
              <div className="flex gap-2 pt-2 mt-2 border-t border-border">
                <button onClick={() => openEdit(a)} className="flex-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">Edit</button>
                <button onClick={() => { setRetiring(a); setRetireReason('') }} className="flex-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-red-600 hover:bg-muted">Remove</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Desktop: table */}
      {(filtered.length > 0 || activeFilterCount(filters) > 0) && (
        <div className="hidden sm:block rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {['Division', 'Segment', 'Pairs', 'Code', 'Pairs per size', 'Ver.', 'Note', 'Only for', ...(canEdit ? [''] : [])].map(h => (
                    <th key={h} className="text-left px-3 py-2.5 font-medium text-muted-foreground text-xs">{h}</th>
                  ))}
                </tr>
                <FilterRow columns={[...ASSORTMENT_FILTERS, ...(canEdit ? [null] : [])]} values={filters} onChange={setFilters} firstCellClass="px-3" cellClass="px-3" />
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(a => (
                  <tr key={a.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 text-muted-foreground">{a.division}</td>
                    <td className="px-3 py-2 text-muted-foreground">{a.segment}</td>
                    <td className="px-3 py-2 tabular-nums">{a.packing}</td>
                    <td className="px-3 py-2 font-mono font-medium">{a.code}</td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{formatSizes(a.sizes)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">v{a.version}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-[180px] truncate" title={a.note}>{a.note || '—'}</td>
                    <td className="px-3 py-2 text-xs max-w-[200px]" data-no-translate>{a.onlyFor ? <span className="font-mono text-amber-700 dark:text-amber-400">{a.onlyFor.split(',').join(', ')}</span> : <span className="text-muted-foreground">any article</span>}</td>
                    {canEdit && (
                      <td className="px-3 py-2 whitespace-nowrap">
                        <button onClick={() => openEdit(a)} className="rounded-md border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted">Edit</button>
                        <button onClick={() => { setRetiring(a); setRetireReason('') }} className="ml-1 rounded-md border border-border px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-muted">Remove</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add / edit dialog */}
      {form && check && (
        <Modal title={form.id ? `Edit assortment ${form.code}` : 'Add assortment'} onClose={() => !busy && setForm(null)}
          footer={<>
            <button disabled={busy} onClick={() => setForm(null)} className="flex-1 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Cancel</button>
            <button disabled={busy || check.errors.length > 0} onClick={save} className="flex-1 rounded-lg bg-foreground text-background px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50">
              {busy ? 'Saving…' : form.id ? 'Save as new version' : 'Add'}
            </button>
          </>}>
          {formError && <p className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{formError}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="as-division" className={labelCls}>Division</label>
              <select id="as-division" disabled={!!form.id} value={form.division} onChange={e => setForm({ ...form, division: e.target.value })} className={inputCls}>
                {divisions.map(d => <option key={d} value={d}>{d}</option>)}
                <option value={NEW_DIVISION}>New division…</option>
              </select>
            </div>
            <div>
              <label htmlFor="as-segment" className={labelCls}>Segment</label>
              <select id="as-segment" disabled={!!form.id} value={form.segment} onChange={e => setForm({ ...form, segment: e.target.value })} className={inputCls}>
                {SEGMENTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {form.division === NEW_DIVISION && (
              <div className="col-span-2">
                <label htmlFor="as-newdiv" className={labelCls}>New division name</label>
                <input id="as-newdiv" value={form.newDivision} onChange={e => setForm({ ...form, newDivision: e.target.value })} className={inputCls} placeholder="e.g. Relaxo" />
              </div>
            )}
            <div>
              <label htmlFor="as-packing" className={labelCls}>Pairs per carton</label>
              <input id="as-packing" disabled={!!form.id} inputMode="numeric" value={form.packing} onChange={e => setForm({ ...form, packing: e.target.value.replace(/\D/g, '') })} className={inputCls} placeholder="30" />
            </div>
            <div>
              <label htmlFor="as-code" className={labelCls}>Assortment code</label>
              <input id="as-code" disabled={!!form.id} value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} className={`${inputCls} font-mono`} placeholder="608" />
            </div>
          </div>
          {form.id && <p className="text-[11px] text-muted-foreground">Division, segment, pairs and code stay fixed. To change them, remove this assortment and add a new one.</p>}

          <div>
            <p className={labelCls}>Pairs per size {rangeSizes && <span className="normal-case tracking-normal">· code {form.code} = sizes {rangeSizes.join(', ')}</span>}</p>
            <div className="grid grid-cols-7 gap-1.5">
              {SIZE_COLUMNS.map(size => {
                const inRange = !rangeSizes || rangeSizes.includes(size)
                return (
                  <label key={size} className={`rounded-lg border px-1 pt-0.5 pb-1 text-center ${inRange ? 'border-border' : 'border-dashed border-border/60 opacity-50'}`}>
                    <span className="block text-[10px] text-muted-foreground">{size}</span>
                    <input inputMode="numeric" aria-label={`Pairs of size ${size}`} value={form.pairs[size] ?? ''}
                      onChange={e => setForm({ ...form, pairs: { ...form.pairs, [size]: e.target.value.replace(/\D/g, '') } })}
                      className="w-full bg-transparent text-center text-sm tabular-nums focus:outline-none" />
                  </label>
                )
              })}
              <div className={`rounded-lg px-1 pt-0.5 pb-1 text-center ${form.packing && total !== Number(form.packing) ? 'bg-red-50 dark:bg-red-900/20' : 'bg-muted'}`}>
                <span className="block text-[10px] text-muted-foreground">Total</span>
                <span className="text-sm font-semibold tabular-nums">{total}{form.packing ? `/${form.packing}` : ''}</span>
              </div>
            </div>
          </div>
          <div>
            <label htmlFor="as-note" className={labelCls}>Note</label>
            <input id="as-note" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label htmlFor="as-onlyfor" className={labelCls}>Only for articles (optional)</label>
            <input id="as-onlyfor" value={form.onlyFor} onChange={e => setForm({ ...form, onlyFor: e.target.value })} placeholder="e.g. HC003G, TR002G — blank = any article" className={`${inputCls} font-mono`} />
            <p className="mt-1 text-[11px] text-muted-foreground">Used automatically only for these article codes. For another article with the same pairs, the app asks whether to use it too or enter a new one.</p>
          </div>
          {(check.errors.length > 0 || check.warnings.length > 0) && (form.packing || form.code) && (
            <ul className="text-xs space-y-0.5">
              {check.errors.map(m => <li key={m} className="text-red-600">• {m}</li>)}
              {check.warnings.map(m => <li key={m} className="text-amber-700 dark:text-amber-400">• {m}</li>)}
            </ul>
          )}
        </Modal>
      )}

      {/* Remove dialog */}
      {retiring && (
        <Modal title={`Remove assortment ${retiring.code}?`} onClose={() => !busy && setRetiring(null)}
          footer={<>
            <button disabled={busy} onClick={() => setRetiring(null)} className="flex-1 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Cancel</button>
            <button disabled={busy} onClick={confirmRetire} className="flex-1 rounded-lg bg-red-600 text-white px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50">{busy ? 'Removing…' : 'Remove'}</button>
          </>}>
          <p className="text-sm text-muted-foreground">{retiring.division} · {retiring.segment} · {retiring.packing} pairs · <span className="font-mono">{formatSizes(retiring.sizes)}</span></p>
          <p className="text-xs text-muted-foreground">It stops being offered but is kept as history.</p>
          {formError && <p className="text-xs text-red-600">{formError}</p>}
          <input value={retireReason} onChange={e => setRetireReason(e.target.value)} className={inputCls} placeholder="Reason (optional)" aria-label="Reason" />
        </Modal>
      )}

      {/* Upload dialog */}
      {uploadOpen && (
        <Modal wide title="Upload assortments from Excel" onClose={() => !busy && setUploadOpen(false)}
          footer={<>
            <button disabled={busy} onClick={() => setUploadOpen(false)} className="flex-1 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Close</button>
            {upload && upload.lines.length > 0 && (
              <button disabled={busy || !tally || tally.error > 0 || tally.new + tally.changed === 0} onClick={applyUpload}
                className="flex-1 rounded-lg bg-foreground text-background px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                {busy ? 'Saving…' : tally && tally.error > 0 ? 'Fix errors first' : `Save ${tally ? tally.new + tally.changed : 0} change(s)`}
              </button>
            )}
          </>}>
          <ol className="text-xs text-muted-foreground list-decimal pl-4 space-y-0.5">
            <li><a className="underline" href="/api/assortments/export?template=1">Download the empty template</a> or <a className="underline" href={exportHref}>the current list</a>.</li>
            <li>One row per assortment: Division, Segment, Pairs per carton, Assortment code, pairs under each size (1–13). Instructions are on the sheet “How to fill”.</li>
            <li>Upload it here. You will see every change before anything is saved.</li>
          </ol>
          <input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy}
            onChange={e => chooseFile(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium" />
          {busy && !upload && <p className="text-xs text-muted-foreground">Reading…</p>}
          {uploadMsg && <p className="text-xs rounded-lg px-3 py-2 bg-muted">{uploadMsg}</p>}
          {upload && upload.errors.length > 0 && (
            <ul className="text-xs text-red-600 space-y-0.5">{upload.errors.map(m => <li key={m}>• {m}</li>)}</ul>
          )}
          {upload && tally && upload.lines.length > 0 && (
            <>
              <p className="text-xs text-foreground">
                <span className="font-medium">{upload.fileName}</span>: {upload.lines.length} rows — {tally.new} new, {tally.changed} new version, {tally.same} no change, <span className={tally.error ? 'text-red-600 font-medium' : ''}>{tally.error} with errors</span>
              </p>
              <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border divide-y divide-border">
                {[...upload.lines].sort((a, b) => Number(b.status === 'error') - Number(a.status === 'error') || a.row - b.row).map(l => (
                  <div key={l.row} className="px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground w-12">Row {l.row}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[l.status]}`}>{STATUS_LABEL[l.status]}</span>
                      <span>{l.value.division} · {l.value.segment} · {Number.isFinite(l.value.packing) ? l.value.packing : '?'} · <span className="font-mono">{l.value.code}</span></span>
                    </div>
                    <p className="mt-0.5 font-mono">
                      {l.status === 'changed' && l.current ? <><span className="line-through text-muted-foreground">{formatSizes(l.current.sizes)}</span> → </> : null}
                      {formatSizes(l.value.sizes)}
                    </p>
                    {l.errors.map(m => <p key={m} className="text-red-600">• {m}</p>)}
                    {l.warnings.map(m => <p key={m} className="text-amber-700 dark:text-amber-400">• {m}</p>)}
                  </div>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

function Modal({ title, children, footer, onClose, wide }: { title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-2xl border border-border bg-background shadow-2xl max-h-[90vh] flex flex-col`} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border"><p className="font-semibold text-sm text-foreground">{title}</p></div>
        <div className="p-5 space-y-3 overflow-y-auto">{children}</div>
        <div className="flex gap-2 px-5 py-4 border-t border-border">{footer}</div>
      </div>
    </div>
  )
}
