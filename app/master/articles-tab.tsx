'use client'

import { useState, useMemo, useTransition, useRef, useEffect } from 'react'
import { applyColumnFilters, FilterRow, FiltersButton, FilterSummary, type ColumnFilterDef, type FilterValues } from '@/components/column-filters'
import { saveArticle, uploadArticleList, deleteArticle, getArticleSizes, getArticles, getArticleMrps, getMissingArticles, addSizeToArticleFromScans, setMissingArticleReview, setCatalogReviewItemStatus } from '@/app/actions/articles'
import type { CatalogReviewItem, ArticleUploadResult } from '@/app/actions/articles'
import { ARTICLE_UPLOAD_COLUMNS, articleTemplateCsv } from '@/lib/catalog/article-upload-columns'
import type { MissingArticle } from '@/lib/catalog/missing-articles'
import { expandSizeRange } from '@/lib/catalog/sizes'
import { DIVISIONS, SEGMENTS } from '@/lib/catalog/assortments'

const ARTICLE_FILTERS: ColumnFilterDef<Article>[] = [
  { key: 'name', label: 'Article name', kind: 'text', get: a => a.artName },
  { key: 'code', label: 'Article code', kind: 'text', get: a => a.artCode },
  { key: 'segment', label: 'Segment', kind: 'select', options: SEGMENTS, get: a => a.segment },
  { key: 'division', label: 'Division', kind: 'select', options: DIVISIONS, get: a => a.division },
  { key: 'color', label: 'Color', kind: 'text', get: a => a.color },
  { key: 'colorCode', label: 'Color code', kind: 'text', get: a => a.colorCode },
  { key: 'min', label: 'Min size', kind: 'text', get: a => a.minSize },
  { key: 'max', label: 'Max size', kind: 'text', get: a => a.maxSize },
]
const filterDef = (key: string) => ARTICLE_FILTERS.find(d => d.key === key)!
import { divisionForArticleCode } from '@/lib/qr-config'
import type { Article } from '@/app/actions/articles'
import { NewArticleDialog } from '@/components/scanner/new-article-dialog'
import { ArticlePhotosDialog } from '@/components/master/article-photos-dialog'
import { getArticlePhotoCounts } from '@/app/actions/article-photos'
import { parseQr } from '@/lib/qr-parser'

export type { Article }

type ArticleForm = {
  artName: string
  artCode: string
  color: string
  colorCode: string
  maxSize: string
  minSize: string
  customSizes: string
  segment: string
  division: string
}

const EMPTY_FORM: ArticleForm = {
  artName: '',
  artCode: '',
  color: '',
  colorCode: '',
  maxSize: '',
  minSize: '',
  customSizes: '',
  segment: '',
  division: '',
}

interface Props {
  initialArticles: Article[]
  initialMissingArticles: MissingArticle[]
  initialReviewItems?: CatalogReviewItem[]
  canReviewCatalog?: boolean
  onListChange?: (list: Article[]) => void
}

const REVIEW_KIND_LABEL: Record<string, string> = {
  colour_name_conflict: 'Colour name conflict',
  range_overlap: 'Overlapping size ranges',
  code_has_several_names: 'Code has several names',
  name_code_mismatch: 'Name does not match code',
  same_colour_name_different_code: 'Same colour, two colour codes',
  retired_variant_in_use: 'Retired, but has history',
  retired_size_in_use: 'Retired size has stock',
  brand_code_mismatch: 'Sparx code on another brand',
  invalid_row: 'Row not imported',
  invalid_size_range: 'Size range not valid',
}

export function ArticlesTab({ initialArticles, initialMissingArticles, initialReviewItems = [], canReviewCatalog = false, onListChange }: Props) {
  const [articleList, setArticleList] = useState<Article[]>(initialArticles)
  const [reviewItems, setReviewItems] = useState(initialReviewItems)
  const [showClosedReviews, setShowClosedReviews] = useState(false)
  const [reviewBusy, setReviewBusy] = useState<number | null>(null)
  const [reviewMsg, setReviewMsg] = useState<string | null>(null)
  const [showRetired, setShowRetired] = useState(false)
  const openReviews = reviewItems.filter(i => i.status === 'open')
  const visibleReviews = showClosedReviews ? reviewItems : openReviews
  const retiredCount = articleList.filter(a => !a.active).length

  async function closeReview(item: CatalogReviewItem, status: 'resolved' | 'dismissed' | 'open') {
    const note = status === 'open' ? '' : window.prompt(status === 'resolved' ? 'What was decided or fixed?' : 'Why is this not a problem?', item.resolution ?? '')
    if (note === null) return
    setReviewBusy(item.id); setReviewMsg(null)
    try {
      setReviewItems(await setCatalogReviewItemStatus(item.id, status, note))
    } catch (e) {
      setReviewMsg(e instanceof Error ? e.message : 'Could not update the review item.')
    } finally { setReviewBusy(null) }
  }
  const [missingArticles, setMissingArticles] = useState(initialMissingArticles)
  const [mrpsByCode, setMrpsByCode] = useState<Record<string, string[]>>({})
  const [missingDialog, setMissingDialog] = useState<MissingArticle | null>(null)
  const mrpKey = (code: string) => code.trim().toUpperCase().replace(/\s+/g, ' ')

  useEffect(() => { getArticleMrps().then(setMrpsByCode).catch(() => setMrpsByCode({})) }, [])
  // Photos for the retailer shop: count per article colour (1 query), dialog per row.
  const [photoCounts, setPhotoCounts] = useState<Record<number, number>>({})
  const [photoTarget, setPhotoTarget] = useState<Article | null>(null)
  useEffect(() => { getArticlePhotoCounts().then(setPhotoCounts).catch(() => setPhotoCounts({})) }, [])

  const [showIgnored, setShowIgnored] = useState(false)
  const [missingBusy, setMissingBusy] = useState(false)
  const [missingMsg, setMissingMsg] = useState<string | null>(null)
  const openMissing = missingArticles.filter(m => m.reviewStatus !== 'ignored')
  const ignoredCount = missingArticles.length - openMissing.length
  const visibleMissing = showIgnored ? missingArticles : openMissing

  async function addMissingSize(item: MissingArticle, size: string) {
    setMissingBusy(true); setMissingMsg(null)
    try {
      const { resolved } = await addSizeToArticleFromScans(item.artCode, item.colorCode, size)
      setMissingMsg(`Size ${size} added to ${item.artCode} / ${item.colorCode}. ${resolved} waiting scan(s) are now in stock.`)
      await refreshMasterLists()
    } catch (e) {
      setMissingMsg(e instanceof Error ? e.message : 'Could not add the size.')
    } finally { setMissingBusy(false) }
  }

  async function toggleIgnore(item: MissingArticle) {
    const ignoring = item.reviewStatus !== 'ignored'
    const note = ignoring ? (window.prompt('Why ignore these scans? (for example: test labels)') ?? '') : ''
    setMissingBusy(true); setMissingMsg(null)
    try {
      await setMissingArticleReview(item.artCode, item.colorCode, ignoring ? 'ignored' : 'open', note)
      await refreshMasterLists()
    } catch (e) {
      setMissingMsg(e instanceof Error ? e.message : 'Could not update the review status.')
    } finally { setMissingBusy(false) }
  }

  async function refreshMasterLists() {
    const [articles, missing, mrps] = await Promise.all([getArticles(), getMissingArticles(), getArticleMrps()])
    updateArticles(articles)
    setMissingArticles(missing)
    setMrpsByCode(mrps)
  }

  function updateArticles(next: Article[]) {
    setArticleList(next)
    onListChange?.(next)
  }

  const [filters, setFilters] = useState<FilterValues>({})

  // ── Modal state ──
  const [modalMode, setModalMode] = useState<'add' | 'edit' | null>(null)
  const [editTarget, setEditTarget] = useState<Article | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Article | null>(null)
  const [form, setForm] = useState<ArticleForm>(EMPTY_FORM)
  const [colors, setColors] = useState<{ color: string; colorCode: string }[]>([
    { color: '', colorCode: '' }
  ])
  const [formError, setFormError] = useState('')
  const [isSaving, startSave] = useTransition()
  const [isDeleting, startDelete] = useTransition()

  // ── Article list upload (preview first, then add) ──
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [isImporting, startImport] = useTransition()
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadPreview, setUploadPreview] = useState<Extract<ArticleUploadResult, { ok: true }> | null>(null)
  const [showUploadHelp, setShowUploadHelp] = useState(false)

  function sendUpload(file: File, apply: boolean) {
    const form = new FormData()
    form.append('file', file)
    form.append('apply', apply ? '1' : '0')
    setImportMsg(null)
    startImport(async () => {
      try {
        const res = await uploadArticleList(form)
        if (!res.ok) { setImportMsg({ type: 'err', text: res.error }); setUploadFile(null); setUploadPreview(null); return }
        if (!apply) { setUploadFile(file); setUploadPreview(res); return }
        if (res.list) updateArticles(res.list)
        const s = res.summary
        const parts = [`Added ${s.added + s.addedPending} article colour(s).`]
        if (s.addedPending) parts.push(`${s.addedPending} of them have no colour code yet.`)
        if (s.filled) parts.push(`${s.filled} colour(s) got their colour code.`)
        if (s.segmentsSet) parts.push(`${s.segmentsSet} got their segment.`)
        parts.push(`${s.alreadyThere} were already in the master.`)
        if (res.resolvedScans) parts.push(`${res.resolvedScans} waiting box scan(s) moved into stock.`)
        setImportMsg({ type: 'ok', text: parts.join(' ') })
        setUploadFile(null); setUploadPreview(null)
      } catch (error) {
        setImportMsg({ type: 'err', text: `Upload failed: ${error instanceof Error ? error.message : 'check your connection and try again'}` })
      }
    })
  }

  function handleUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) sendUpload(file, false)
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([articleTemplateCsv()], { type: 'text/csv' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'article-list-template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const filtered = useMemo(() =>
    applyColumnFilters(showRetired ? articleList : articleList.filter(a => a.active), ARTICLE_FILTERS, filters)
  , [articleList, filters, showRetired])

  function openAdd() {
    setForm(EMPTY_FORM)
    setColors([{ color: '', colorCode: '' }])
    setFormError('')
    setEditTarget(null)
    setModalMode('add')
  }

  async function openEdit(a: Article) {
    setForm({
      artName:   a.artName,
      artCode:   a.artCode,
      color:     a.color,
      colorCode: a.colorCode,
      maxSize:   a.maxSize,
      minSize:   a.minSize,
      customSizes: '',
      segment:   a.segment ?? '',
      division:  a.division ?? '',
    })
    setColors([{ color: a.color, colorCode: a.colorCode }])
    setFormError('')
    setEditTarget(a)
    setModalMode('edit')

    try {
      const dbSizes = await getArticleSizes(a.id)
      // Sizes outside the min–max run (children's runs wrap: 11–5 = 11, 12, 13, 1 … 5).
      const range = expandSizeRange(a.minSize, a.maxSize)
      const inRange = new Set(range.ok ? range.sizes : [])
      const customs = dbSizes.filter(s => !inRange.has(s))
      const customSizesStr = customs.join(', ')
      setForm(f => ({ ...f, customSizes: customSizesStr }))
      setColors([{ color: a.color, colorCode: a.colorCode }])
    } catch {
      // Graceful fallback
    }
  }

  function handleSave() {
    if (!form.artName.trim()) { setFormError('Article name is required.'); return }
    
    if (modalMode === 'add') {
      if (!form.segment) { setFormError('Choose the segment (Gents, Ladies, Kids or Baby).'); return }
      if (!form.division) { setFormError('Choose the division.'); return }
      const emptyColorIdx = colors.findIndex(c => !c.color.trim())
      if (emptyColorIdx !== -1) {
        setFormError(`Color name is required (Color #${emptyColorIdx + 1}).`)
        return
      }
      const colorNames = colors.map(c => c.color.trim().toLowerCase())
      const uniqueColors = new Set(colorNames)
      if (uniqueColors.size !== colorNames.length) {
        setFormError('Duplicate color names are not allowed in the same article.')
        return
      }
    }
    
    setFormError('')

    startSave(async () => {
      try {
        let updated: Article[] = []
        if (modalMode === 'add') {
          for (const c of colors) {
            const payload = {
              artName: form.artName,
              artCode: form.artCode,
              color: c.color,
              colorCode: c.colorCode,
              minSize: form.minSize,
              maxSize: form.maxSize,
              customSizes: form.customSizes,
              segment: form.segment,
              division: form.division,
            }
            updated = await saveArticle(payload)
          }
        } else if (modalMode === 'edit' && editTarget) {
          const payload = {
            id: editTarget.id,
            artName: form.artName,
            artCode: form.artCode,
            color: form.color,
            colorCode: form.colorCode,
            minSize: form.minSize,
            maxSize: form.maxSize,
            customSizes: form.customSizes,
            segment: form.segment,
            division: form.division || null,
          }
          updated = await saveArticle(payload)
        }
        updateArticles(updated)
        setModalMode(null)
      } catch (e) {
        setFormError(e instanceof Error && e.message ? e.message : 'Failed to save article. Please try again.')
      }
    })
  }

  const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <div>
      {/* ── Hidden CSV file input ── */}
      <input
        ref={uploadInputRef}
        type="file"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="hidden"
        onChange={handleUploadFile}
      />

      {/* ── Toolbar ── */}
      {/* Filters: under each column heading on wide screens; a Filters button on phones. */}
      <FiltersButton className="mb-2 sm:hidden" defs={ARTICLE_FILTERS} values={filters} onChange={setFilters} />
      <div className="mb-2 hidden sm:block">
        <FilterSummary values={filters} onChange={setFilters} shown={filtered.length} total={showRetired ? articleList.length : articleList.filter(a => a.active).length} />
      </div>
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => uploadInputRef.current?.click()}
          disabled={isImporting}
          className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
        >
          {isImporting ? 'Reading…' : '↑ Upload Excel / CSV'}
        </button>
        <button onClick={() => setShowUploadHelp(v => !v)} className="text-xs text-muted-foreground underline underline-offset-2">
          {showUploadHelp ? 'Hide help' : 'How to upload'}
        </button>
        <button
          onClick={openAdd}
          className="ml-auto rounded-lg bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          + Add Article
        </button>
      </div>

      {showUploadHelp && (
        <section className="mb-4 rounded-xl border border-border bg-muted/30 p-4 text-sm">
          <h3 className="font-semibold">How to upload an article list</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Use an Excel file (.xlsx) or a CSV file. Only the first sheet is read.</li>
            <li>The first row must hold the column names below (any order; capitals and spaces do not matter). Other columns, like id, are ignored.</li>
            <li>One row per article colour. A colour with two size runs (for example 11–13 and 1–5) can be two rows.</li>
            <li>You see a preview first. Nothing is saved until you tap Add to master.</li>
            <li>Uploading never deletes or changes articles already in the master. Rows already there are skipped, so the same file can be uploaded again safely.</li>
          </ol>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-background">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-2 py-1.5 text-left">Column name</th>
                  <th className="px-2 py-1.5 text-left">Needed?</th>
                  <th className="px-2 py-1.5 text-left">Example</th>
                  <th className="px-2 py-1.5 text-left">What to enter</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ARTICLE_UPLOAD_COLUMNS.map(c => (
                  <tr key={c.name}>
                    <td className="px-2 py-1.5 font-mono font-semibold whitespace-nowrap" data-no-translate>{c.name}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{c.required ? 'Required' : 'Optional'}</td>
                    <td className="px-2 py-1.5 font-mono whitespace-nowrap" data-no-translate>{c.example}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{c.help}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={downloadTemplate} className="mt-3 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted">↓ Download template</button>
        </section>
      )}

      {uploadPreview && uploadFile && (
        <section className="mb-4 rounded-xl border border-sky-500/40 bg-sky-50/50 p-4 text-sm dark:bg-sky-950/20">
          <h3 className="font-semibold">Check before adding</h3>
          <p className="text-xs text-muted-foreground" data-no-translate>{uploadFile.name}</p>
          <ul className="mt-2 space-y-0.5 text-xs">
            <li>{`${uploadPreview.summary.rowsRead} rows read, ${uploadPreview.summary.articleCodes} article codes`}</li>
            <li className="font-medium">{`${uploadPreview.summary.added} new article colours with colour code`}</li>
            <li className="font-medium">{`${uploadPreview.summary.addedPending} new article colours without colour code (kept by colour name; code added at first scan)`}</li>
            {uploadPreview.summary.filled > 0 && <li className="font-medium">{`${uploadPreview.summary.filled} existing colours get their colour code`}</li>}
            <li>{`${uploadPreview.summary.alreadyThere} already in the master (skipped)`}</li>
            {uploadPreview.summary.segmentsSet > 0 && <li className="font-medium">{`${uploadPreview.summary.segmentsSet} existing article colours get their segment`}</li>}
            {uploadPreview.summary.segmentDiffers.length > 0 && <li className="text-amber-700 dark:text-amber-400">{`${uploadPreview.summary.segmentDiffers.length} have a different segment in the master (not changed; listed below)`}</li>}
            {uploadPreview.summary.problems.length > 0 && <li className="text-red-600 dark:text-red-400">{`${uploadPreview.summary.problems.length} row(s) cannot be read and will be skipped`}</li>}
          </ul>
          {uploadPreview.summary.segmentDiffers.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-background p-2 text-xs text-amber-700 dark:text-amber-400">
              {uploadPreview.summary.segmentDiffers.slice(0, 50).map((p, i) => <p key={i}>{p.message}</p>)}
            </div>
          )}
          {uploadPreview.summary.problems.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-background p-2 text-xs text-red-600 dark:text-red-400">
              {uploadPreview.summary.problems.slice(0, 50).map(p => <p key={p.rowNumber}>{p.message}</p>)}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              disabled={isImporting || uploadPreview.summary.added + uploadPreview.summary.addedPending + uploadPreview.summary.filled + uploadPreview.summary.segmentsSet === 0}
              onClick={() => sendUpload(uploadFile, true)}
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
            >
              {isImporting ? 'Adding…' : 'Add to master'}
            </button>
            <button disabled={isImporting} onClick={() => { setUploadFile(null); setUploadPreview(null) }} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>
          </div>
        </section>
      )}

      {/* Upload feedback */}
      {importMsg && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-xs font-medium ${
          importMsg.type === 'ok'
            ? 'bg-green-50 text-green-700 border border-green-200 dark:border-green-500/30 dark:bg-green-900/20 dark:text-green-400'
            : 'bg-red-50 text-red-700 border border-red-200 dark:border-red-500/30 dark:bg-red-900/20 dark:text-red-400'
        }`}>
          {importMsg.text}
        </div>
      )}

      {reviewItems.length > 0 && <section className="mb-5 rounded-xl border border-sky-500/30 p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">Catalogue review ({openReviews.length})</h3>
          {reviewItems.length > openReviews.length && (
            <button onClick={() => setShowClosedReviews(v => !v)} className="text-xs text-muted-foreground underline">
              {showClosedReviews ? 'Hide' : 'Show'} {reviewItems.length - openReviews.length} closed
            </button>
          )}
        </div>
        <p className="mb-3 text-xs text-muted-foreground">Conflicts the catalogue import found and did not guess about. Fix the article in the editor if needed, then close the item with a note.</p>
        {reviewMsg && <p className="mb-2 rounded-lg bg-muted px-3 py-2 text-xs">{reviewMsg}</p>}
        {visibleReviews.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting for review.</p> : <div className="max-h-96 space-y-2 overflow-y-auto">
          {visibleReviews.map(item => <div key={item.id} className="rounded-lg bg-muted/40 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono font-semibold">{item.artCode || '—'}{item.colorCode ? ` / ${item.colorCode}` : ''}</span>
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-900 dark:bg-sky-900/30 dark:text-sky-200">{REVIEW_KIND_LABEL[item.kind] ?? item.kind}</span>
              {item.status !== 'open' && <span className="text-xs text-muted-foreground">{item.status}{item.resolution ? `: ${item.resolution}` : ''}</span>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{item.message}</p>
            {canReviewCatalog && <div className="mt-2 flex gap-2">
              {item.status === 'open' ? <>
                <button disabled={reviewBusy === item.id} onClick={() => closeReview(item, 'resolved')} className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50">Resolved</button>
                <button disabled={reviewBusy === item.id} onClick={() => closeReview(item, 'dismissed')} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground disabled:opacity-50">Not a problem</button>
              </> : <button disabled={reviewBusy === item.id} onClick={() => closeReview(item, 'open')} className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50">Re-open</button>}
            </div>}
          </div>)}
        </div>}
      </section>}

      {retiredCount > 0 && <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{retiredCount} retired article{retiredCount === 1 ? '' : 's'} (not in the approved catalogue) {showRetired ? 'shown' : 'hidden'}.</span>
        <button onClick={() => setShowRetired(v => !v)} className="underline">{showRetired ? 'Hide retired' : 'Show retired'}</button>
      </div>}

      {openMissing.length === 0 && !showIgnored && ignoredCount > 0 && (
        <p className="mb-4 text-xs text-muted-foreground">
          {`${ignoredCount} ignored missing article(s).`} <button onClick={() => setShowIgnored(true)} className="underline">Show</button>
        </p>
      )}
      {(openMissing.length > 0 || (showIgnored && ignoredCount > 0)) && <section className="mb-5 rounded-xl border border-amber-500/30 p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">Missing articles ({openMissing.length})</h3>
          {ignoredCount > 0 && (
            <button onClick={() => setShowIgnored(v => !v)} className="text-xs text-muted-foreground underline">
              {showIgnored ? 'Hide' : 'Show'} {ignoredCount} ignored
            </button>
          )}
        </div>
        <p className="mb-3 text-xs text-muted-foreground">Boxes scanned during the stocktake whose article, colour or size is not in the master. They are saved but not counted in stock until linked. Linking posts all of them at once; nobody needs to rescan.</p>
        {missingMsg && <p className="mb-2 rounded-lg bg-muted px-3 py-2 text-xs">{missingMsg}</p>}
        {visibleMissing.length === 0 ? <p className="text-sm text-muted-foreground">No scanned boxes are waiting for the article master.</p> : <div className="space-y-2">
          {visibleMissing.map((item) => <div key={`${item.artCode}|${item.colorCode}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-3 text-sm">
            <span className="font-mono font-semibold">{item.artCode} / {item.colorCode || '—'}</span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">{item.kind === 'missing_article' ? 'Unknown article or colour' : 'Size not configured'}</span>
            <span>{item.boxCount} {item.boxCount === 1 ? 'box' : 'boxes'}</span>
            <span>Sizes: {item.sizes.join(', ') || '—'}</span>
            <span>MRPs: {item.mrps.join(', ') || '—'}</span>
            <span className="text-xs text-muted-foreground">Seen {new Date(item.firstSeen).toLocaleDateString()}–{new Date(item.lastSeen).toLocaleDateString()} by {item.scannedBy.join(', ') || '—'}</span>
            {item.reviewStatus === 'ignored' && <span className="text-xs text-muted-foreground">Ignored{item.reviewNote ? `: ${item.reviewNote}` : ''}</span>}
            <span className="ml-auto flex flex-wrap gap-2">
              {item.kind === 'missing_size' && item.sizes.map(size => (
                <button key={size} disabled={missingBusy} onClick={() => addMissingSize(item, size)} className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50">Add size {size}</button>
              ))}
              {item.kind === 'missing_article' && (
                <button disabled={!item.rawQr || missingBusy} onClick={() => setMissingDialog(item)} className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50">Create / Link</button>
              )}
              <button disabled={missingBusy} onClick={() => toggleIgnore(item)} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground disabled:opacity-50">
                {item.reviewStatus === 'ignored' ? 'Reopen' : 'Ignore'}
              </button>
            </span>
          </div>)}
        </div>}
      </section>}
      {missingDialog && <NewArticleDialog
        rawQr={missingDialog.rawQr}
        parsed={parseQr(missingDialog.rawQr)}
        mode="unknown"
        saveScan={false}
        initialSizes={missingDialog.sizes.join(', ') || undefined}
        onClose={() => setMissingDialog(null)}
        onSaveLater={async () => false}
        onLinked={async () => { setMissingDialog(null); await refreshMasterLists() }}
      />}

      {filtered.length === 0 && (
        <p className="text-center py-10 text-sm text-muted-foreground">No articles found</p>
      )}

      {/* ── Mobile: card list ── */}
      <div className="sm:hidden space-y-3">
        {filtered.map(a => (
          <div key={a.id} className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-3">
              <div className="min-w-0">
                <p className="font-semibold text-base text-foreground truncate">{a.artName || '—'}<StatusBadge a={a} /></p>
                {a.artCode && <p className="text-xs text-muted-foreground font-mono mt-0.5">{a.artCode}{mrpsByCode[mrpKey(a.artCode)]?.length ? ` · MRPs ${mrpsByCode[mrpKey(a.artCode)].join(', ')}` : ''}</p>}
              </div>
              {!a.colorCode && a.color && (
                <span className="shrink-0 rounded-full border border-amber-300 dark:border-amber-500/30 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">{`${a.color} · code pending`}</span>
              )}
              {a.colorCode && (
                <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border border-border bg-muted">
                  <span
                    className="w-3 h-3 rounded-full border border-border"
                    style={{ backgroundColor: a.colorCode.startsWith('#') ? a.colorCode : undefined }}
                  />
                  {a.color || a.colorCode}
                </span>
              )}
            </div>
            <div className="px-4 pb-3 flex gap-4 text-sm">
              <div>
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block">Segment</span>
                <span className="text-foreground font-medium">{a.segment || '—'}</span>
              </div>
              {a.minSize && (
                <div>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block">Min Size</span>
                  <span className="text-foreground font-medium">{a.minSize}</span>
                </div>
              )}
              {a.maxSize && (
                <div>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block">Max Size</span>
                  <span className="text-foreground font-medium">{a.maxSize}</span>
                </div>
              )}
            </div>
            <div className="border-t border-border px-4 py-3 flex gap-2">
              <button
                onClick={() => setPhotoTarget(a)}
                className="flex-1 rounded-xl border border-border bg-background py-2.5 text-sm font-medium hover:bg-muted active:scale-95 transition-all"
              >
                Photos{photoCounts[a.id] ? ` (${photoCounts[a.id]})` : ''}
              </button>
              <button
                onClick={() => openEdit(a)}
                className="flex-1 rounded-xl border border-border bg-background py-2.5 text-sm font-medium hover:bg-muted active:scale-95 transition-all"
              >
                Edit
              </button>
              <button
                onClick={() => setDeleteTarget(a)}
                className="flex-1 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400 py-2.5 text-sm font-medium hover:bg-red-100 active:scale-95 transition-all"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Desktop: table ── */}
      <div className="hidden sm:block rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left pl-4 pr-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">#</th>
                <th className="text-left px-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">Article Name</th>
                <th className="text-left px-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">Article Code</th>
                <th className="text-left px-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">Segment</th>
                <th className="text-left px-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">Division</th>
                <th className="text-left px-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">Color</th>
                <th className="text-left px-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">Color Code</th>
                <th className="text-left px-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">Min Size</th>
                <th className="text-left px-2 py-2.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">Max Size</th>
                <th className="pr-4 pl-2 py-2.5 w-[210px] text-right">Actions</th>
              </tr>
              <FilterRow
                columns={[null, filterDef('name'), filterDef('code'), filterDef('segment'), filterDef('division'), filterDef('color'), filterDef('colorCode'), filterDef('min'), filterDef('max'), null]}
                values={filters}
                onChange={setFilters}
              />
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(a => (
                <tr key={a.id} className="hover:bg-muted/30 transition-colors">
                  <td className="pl-4 pr-2 py-3 font-mono text-xs text-muted-foreground whitespace-nowrap">{a.id}</td>
                  <td className="px-2 py-3 max-w-[160px]">
                    <p className="font-medium text-foreground truncate text-sm" title={a.retiredReason ?? a.artName}>{a.artName || '—'}<StatusBadge a={a} /></p>
                  </td>
                  <td className="px-2 py-3 font-mono text-xs text-foreground whitespace-nowrap">{a.artCode || '—'}{mrpsByCode[mrpKey(a.artCode)]?.length ? <span className="block font-sans text-[10px] text-muted-foreground">MRPs: {mrpsByCode[mrpKey(a.artCode)].join(', ')}</span> : null}</td>
                  <td className="px-2 py-3 text-sm text-foreground whitespace-nowrap">{a.segment || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-2 py-3 text-sm text-foreground whitespace-nowrap">{a.division || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-2 py-3 text-sm text-foreground whitespace-nowrap">{a.color || '—'}</td>
                  <td className="px-2 py-3 whitespace-nowrap">
                    {a.colorCode ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                        {a.colorCode.startsWith('#') && (
                          <span
                            className="w-3 h-3 rounded-sm border border-border inline-block"
                            style={{ backgroundColor: a.colorCode }}
                          />
                        )}
                        {a.colorCode}
                      </span>
                    ) : a.color ? <span className="text-xs text-amber-700 dark:text-amber-400">pending</span> : '—'}
                  </td>
                  <td className="px-2 py-3 text-sm text-muted-foreground whitespace-nowrap">{a.minSize || '—'}</td>
                  <td className="px-2 py-3 text-sm text-muted-foreground whitespace-nowrap">{a.maxSize || '—'}</td>
                  <td className="pr-4 pl-2 py-3 w-[210px]">
                    <div className="flex items-center gap-1.5 justify-end">
                      <button onClick={() => setPhotoTarget(a)} className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${photoCounts[a.id] ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 dark:hover:bg-emerald-500/25' : 'border-border hover:bg-muted'}`}>Photos{photoCounts[a.id] ? ` (${photoCounts[a.id]})` : ''}</button>
                      <button onClick={() => openEdit(a)} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap">Edit</button>
                      <button onClick={() => setDeleteTarget(a)} className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 hover:bg-red-100 text-red-600 dark:text-red-400 px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add / Edit Modal ── */}
      {modalMode && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setModalMode(null)}
        >
          <div
            className={`w-full ${modalMode === 'add' ? 'sm:max-w-3xl' : 'sm:max-w-lg'} rounded-t-3xl sm:rounded-2xl border border-border bg-background shadow-2xl overflow-hidden`}
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle (mobile only) */}
            <div className="sm:hidden flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>

            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 flex items-center justify-center rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 shrink-0">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-foreground tracking-tight">
                    {modalMode === 'add' ? 'Add Article' : 'Edit Article'}
                  </h3>
                </div>
              </div>
              <button
                onClick={() => setModalMode(null)}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors"
              >
                <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto max-h-[75vh] sm:max-h-[80vh]">
              {formError && (
                <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{formError}</p>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Article Name *</label>
                  <input
                    value={form.artName}
                    onChange={e => setForm(f => ({ ...f, artName: e.target.value }))}
                    className={inputCls}
                    placeholder="Enter article name"
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Article Code</label>
                  <input
                    value={form.artCode}
                    onChange={e => {
                      const code = e.target.value
                      // New article: suggest the division from the code until the admin picks one.
                      setForm(f => ({ ...f, artCode: code, division: modalMode === 'add' && (!f.division || f.division === divisionForArticleCode(f.artCode)) ? divisionForArticleCode(code) : f.division }))
                    }}
                    className={inputCls}
                    placeholder="e.g. AC-2024"
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Segment</label>
                  <select
                    value={form.segment}
                    onChange={e => setForm(f => ({ ...f, segment: e.target.value }))}
                    className={inputCls}
                  >
                    <option value="">Not set</option>
                    {SEGMENTS.map(sg => <option key={sg} value={sg}>{sg}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Division</label>
                  <select
                    value={form.division}
                    onChange={e => setForm(f => ({ ...f, division: e.target.value }))}
                    className={inputCls}
                  >
                    <option value="">Not set</option>
                    {DIVISIONS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                  {modalMode === 'add' && form.division && form.division === divisionForArticleCode(form.artCode) && (
                    <p className="mt-1 text-[11px] text-muted-foreground">Suggested from the article code. Change it if this article is from another division.</p>
                  )}
                </div>

                {modalMode === 'add' ? (
                  <div className="col-span-2 space-y-5">

                    {/* ── Sizes section ── */}
                    <div className="border-t border-border pt-4 mt-2">
                      <span className="text-sm font-semibold text-foreground block mb-3">Sizes</span>
                      <div className="rounded-xl border border-border bg-muted/10 p-4 grid grid-cols-3 gap-4">
                        <div>
                          <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Min Size</label>
                          <input
                            value={form.minSize}
                            onChange={e => setForm(f => ({ ...f, minSize: e.target.value }))}
                            className={inputCls}
                            placeholder="e.g. 6"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Max Size</label>
                          <input
                            value={form.maxSize}
                            onChange={e => setForm(f => ({ ...f, maxSize: e.target.value }))}
                            className={inputCls}
                            placeholder="e.g. 12"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Custom Sizes</label>
                          <input
                            value={form.customSizes}
                            onChange={e => setForm(f => ({ ...f, customSizes: e.target.value }))}
                            className={inputCls}
                            placeholder="e.g. 2, 5"
                          />
                        </div>
                      </div>
                    </div>

                    {/* ── Colors section ── */}
                    <div>
                      <div className="flex items-end justify-between mb-3">
                        <div>
                          <span className="text-sm font-semibold text-foreground block">Colors</span>
                          <span className="text-xs text-muted-foreground block mt-0.5">Color name &amp; code for each variant.</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setColors(prev => [...prev, { color: '', colorCode: '' }])}
                          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-muted transition-colors flex items-center gap-1"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                          Add Color
                        </button>
                      </div>

                    <div className="border border-border rounded-xl p-3 bg-muted/10 space-y-3">
                      {/* Grid Headers */}
                      <div className="hidden sm:grid grid-cols-12 gap-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-2 pb-1 border-b border-border/60">
                        <div className="col-span-5">Color Name *</div>
                        <div className="col-span-6">Color Code</div>
                        <div className="col-span-1 text-center">Del</div>
                      </div>

                      <div className="space-y-3.5 max-h-[250px] overflow-y-auto pr-1">
                        {colors.map((c, idx) => (
                          <div key={idx} className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-3 items-center bg-background sm:bg-transparent border border-border sm:border-transparent p-3 sm:p-0 rounded-lg sm:rounded-none">

                            <div className="col-span-1 sm:col-span-5">
                              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sm:hidden block mb-1">Color Name *</label>
                              <input
                                value={c.color}
                                onChange={e => {
                                  const next = [...colors]
                                  next[idx] = { ...next[idx], color: e.target.value }
                                  setColors(next)
                                }}
                                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                placeholder="e.g. Red"
                              />
                            </div>

                            <div className="col-span-1 sm:col-span-6">
                              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sm:hidden block mb-1">Color Code</label>
                              <input
                                value={c.colorCode}
                                onChange={e => {
                                  const next = [...colors]
                                  next[idx] = { ...next[idx], colorCode: e.target.value }
                                  setColors(next)
                                }}
                                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                placeholder="e.g. #FF0000"
                              />
                            </div>

                            <div className="col-span-1 sm:col-span-1 flex justify-end sm:justify-center items-center pt-2 sm:pt-0 border-t border-border/40 sm:border-transparent">
                              {colors.length > 1 ? (
                                <button
                                  type="button"
                                  onClick={() => setColors(prev => prev.filter((_, i) => i !== idx))}
                                  className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg border border-border sm:border-transparent hover:border-red-200 transition-all"
                                  title="Remove color"
                                >
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                </button>
                              ) : (
                                <span className="text-xs text-muted-foreground/60 select-none hidden sm:inline">—</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>{/* end colors card */}
                    </div>{/* end colors section */}
                  </div>
                ) : (
                  <>
                    <div className="col-span-1">
                      <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Color Name *</label>
                      <input
                        value={form.color}
                        onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                        className={inputCls}
                        placeholder="e.g. Red"
                      />
                    </div>
                    <div className="col-span-1">
                      <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Color Code</label>
                      <input
                        value={form.colorCode}
                        onChange={e => setForm(f => ({ ...f, colorCode: e.target.value }))}
                        className={inputCls}
                        placeholder="e.g. #FF0000 or C01"
                      />
                    </div>
                    <div className="col-span-1">
                      <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Min Size</label>
                      <input
                        value={form.minSize}
                        onChange={e => setForm(f => ({ ...f, minSize: e.target.value }))}
                        className={inputCls}
                        placeholder="e.g. S or 28"
                      />
                    </div>
                    <div className="col-span-1">
                      <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Max Size</label>
                      <input
                        value={form.maxSize}
                        onChange={e => setForm(f => ({ ...f, maxSize: e.target.value }))}
                        className={inputCls}
                        placeholder="e.g. XXL or 44"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1.5">Custom Sizes (comma-separated)</label>
                      <input
                        value={form.customSizes}
                        onChange={e => setForm(f => ({ ...f, customSizes: e.target.value }))}
                        className={inputCls}
                        placeholder="e.g. 2, 5"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex gap-3 px-5 py-4 border-t border-border bg-muted/10">
              <button
                type="button"
                onClick={() => setModalMode(null)}
                disabled={isSaving}
                className="flex-1 rounded-xl border border-border px-4 py-3 text-sm font-semibold hover:bg-muted transition-all disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="flex-1 rounded-xl bg-foreground text-background px-4 py-3 text-sm font-bold hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center"
              >
                {isSaving ? 'Saving…' : modalMode === 'add' ? 'Add Article' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {photoTarget && (
        <ArticlePhotosDialog
          article={{ id: photoTarget.id, artName: photoTarget.artName, artCode: photoTarget.artCode, color: photoTarget.color, colorCode: photoTarget.colorCode }}
          onClose={() => setPhotoTarget(null)}
          onCountChange={(id, n) => setPhotoCounts((c) => ({ ...c, [id]: n }))}
        />
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-2xl m-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-foreground mb-2">Delete Article</h3>
            <p className="text-sm text-muted-foreground mb-6">
              Are you sure you want to delete <span className="font-semibold text-foreground">&quot;{deleteTarget.artName}&quot;</span> ({deleteTarget.color || 'no color'})? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={isDeleting}
                className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium hover:bg-muted transition-all disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  startDelete(async () => {
                    try {
                      const updated = await deleteArticle(deleteTarget.id)
                      updateArticles(updated)
                      setDeleteTarget(null)
                    } catch {
                      setFormError('Failed to delete article. Please try again.')
                      setDeleteTarget(null)
                    }
                  })
                }}
                disabled={isDeleting}
                className="flex-1 rounded-xl bg-red-600 text-white py-2.5 text-sm font-semibold hover:bg-red-700 active:scale-95 transition-all disabled:opacity-50"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ a }: { a: Article }) {
  if (!a.active) return <span title={a.retiredReason ?? undefined} className="ml-2 rounded-full bg-muted px-2 py-0.5 align-middle text-[10px] font-medium text-muted-foreground">Retired</span>
  if (a.reviewStatus === 'needs_review') return <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 align-middle text-[10px] font-medium text-sky-900 dark:bg-sky-900/30 dark:text-sky-200">Needs review</span>
  return null
}
