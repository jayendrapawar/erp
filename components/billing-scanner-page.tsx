'use client'

import { playAlreadyScanned, playScanOk } from '@/lib/scan-sound'
import jsQR from 'jsqr'
import {
  useCallback, useEffect, useId, useImperativeHandle, useMemo,
  useRef, useState, forwardRef,
} from 'react'
import { fuzzyFilter } from '@/lib/fuzzy'
import { buildInvoiceHtml } from '@/lib/bill-html'
import { SCAN_INTERVAL_MS, SCAN_MAX_DIM } from '@/components/scanner/constants'
import { Button } from '@/components/ui/button'
import { isValidWarehouseQr, parseQr, type ParsedQr } from '@/lib/qr-parser'
import { PageNav } from '@/components/page-nav'
import { NewArticleDialog } from '@/components/scanner/new-article-dialog'
import {
  discardDirectBillDraft, generateDirectBillFromDraft, getOpenDirectBillDrafts, openDirectBillDraft,
  removeFromDirectBill, saveDirectBillDraft, scanIntoDirectBill, startDirectBillDraft,
} from '@/app/actions/billing'
import type { DraftHeader, DraftSummary, GeneratedBill, MasterMatch } from '@/lib/billing/bill-stock'

function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Network problem.')

// ── Vendor type ────────────────────────────────────────────────────────────────

export interface BillingVendor {
  id: string
  name: string
  code: string | null   // area
  phone: string | null
  address: string | null
}

// ── Bill line ──────────────────────────────────────────────────────────────────
// Key = artNumber__mrpCents — same article at different MRP → separate line.

interface BillLine {
  key: string       // artNumber__mrpCents
  artNumber: string
  mrp: number
  division: string
  qty: number
  boxCodes: string[]
  /** Boxes on this line that the warehouse never scanned into stock (Direct Billing). */
  notInStock: number
}

function lineKey(art: string, mrp: number) {
  return `${art}__${Math.round(mrp * 100)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchCombobox — identical to salesman-dashboard
// ─────────────────────────────────────────────────────────────────────────────

interface SearchComboboxProps<T> {
  id?: string
  label: string
  required?: boolean
  placeholder: string
  inputValue: string
  onInputChange: (v: string) => void
  onSelect: (item: T) => void
  onClear: () => void
  results: T[]
  loading: boolean
  renderOption: (item: T, active: boolean) => React.ReactNode
  getKey: (item: T) => string | number
  disabled?: boolean
  dropUp?: boolean
}

interface SearchComboboxHandle {
  focus: () => void
}

const SearchCombobox = forwardRef(function SearchComboboxInner<T>(
  {
    id, label, required, placeholder, inputValue, onInputChange,
    onSelect, onClear, results, loading, renderOption, getKey, disabled,
    dropUp = true,
  }: SearchComboboxProps<T>,
  ref: React.Ref<SearchComboboxHandle>,
) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  useImperativeHandle(ref, () => ({
    focus: () => { inputRef.current?.focus(); inputRef.current?.select() },
  }))

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  useEffect(() => {
    if (!open || !listRef.current) return
    const activeEl = listRef.current.children[activeIdx] as HTMLElement | undefined
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  useEffect(() => {
    if (results.length > 0) {
      setActiveIdx(0)
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [results])

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { setOpen(true); e.preventDefault() }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[activeIdx]
      if (item) { onSelect(item); setOpen(false); inputRef.current?.blur() }
    } else if (e.key === 'Escape') {
      setOpen(false); inputRef.current?.blur()
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground mb-1.5">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <div className="relative flex items-center">
        <svg className="absolute left-3 w-4 h-4 text-muted-foreground pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && results[activeIdx] ? `${listId}-${activeIdx}` : undefined}
          value={inputValue}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
          onChange={e => { onInputChange(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          className="w-full rounded-xl border border-border bg-background pl-9 pr-9 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        />
        {inputValue && !disabled && (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => { onClear(); setOpen(false) }}
            className="absolute right-3 text-muted-foreground hover:text-foreground"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label={label}
          className={`absolute z-50 w-full rounded-xl border border-border bg-card shadow-xl overflow-hidden max-h-60 overflow-y-auto ${
            dropUp
              ? 'bottom-full mb-1 flex flex-col-reverse'
              : 'top-full mt-1'
          }`}
        >
          {loading && <li className="px-4 py-3 text-sm text-muted-foreground">Searching…</li>}
          {!loading && results.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted-foreground">No results found</li>
          )}
          {!loading && results.map((item, i) => (
            <li
              key={getKey(item)}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIdx}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={e => { e.preventDefault(); onSelect(item); setOpen(false); inputRef.current?.blur() }}
              className={`px-4 py-2.5 text-sm cursor-pointer transition-colors ${i === activeIdx ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {renderOption(item, i === activeIdx)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}) as <T>(props: SearchComboboxProps<T> & { ref?: React.Ref<SearchComboboxHandle> }) => React.ReactElement

// ── Props ──────────────────────────────────────────────────────────────────────

export type DirectBillGenerated = GeneratedBill & {
  shopkeeperName: string
  shopkeeperPhone: string | null
  shopkeeperAddress: string | null
}

interface Props {
  vendors: BillingVendor[]
  /** Article numbers for manual-entry search combobox */
  articles?: string[]
  /**
   * Direct Billing mode (biller dashboard): every scan is saved to a server draft at once, so a
   * bill left by mistake stays as a draft. "Generate" creates the bill and takes its boxes out of
   * stock, then calls this.
   */
  onBillGenerated?: (data: DirectBillGenerated) => void
  /** Suppress the full-page chrome (header, sign-out) when embedded */
  embedded?: boolean
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function BillingScannerPage({ vendors, articles = [], onBillGenerated, embedded }: Props) {

  // Guard: vendors may briefly be undefined during SSR/hydration
  const safeVendors = vendors ?? []

  // ── Vendor search ──────────────────────────────────────────────────────────
  const [skQuery, setSkQuery]               = useState('')
  const [selectedVendor, setSelectedVendor] = useState<BillingVendor | null>(null)

  const skResults = useMemo<BillingVendor[]>(() => {
    if (!skQuery.trim()) return safeVendors.slice(0, 20)
    return fuzzyFilter(
      safeVendors,
      skQuery,
      v => [v.name, v.code, v.phone, v.address],
    ).slice(0, 20)
  }, [skQuery, safeVendors])

  // ── Bill lines ─────────────────────────────────────────────────────────────
  const [billLines, setBillLines] = useState<BillLine[]>([])
  // Synchronous copy, so rapid scans see each other before React re-renders.
  const billLinesRef = useRef<BillLine[]>([])
  function commitLines(next: BillLine[]) { billLinesRef.current = next; setBillLines(next) }

  // ── Direct Billing drafts (server) ─────────────────────────────────────────
  const directBill = !!onBillGenerated
  const [draftId, setDraftId] = useState<number | null>(null)
  const draftIdRef = useRef<number | null>(null)
  const draftPromiseRef = useRef<Promise<number> | null>(null)
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [pendingScans, setPendingScans] = useState(0)

  function refreshDrafts() {
    if (!directBill) return
    getOpenDirectBillDrafts().then(setDrafts).catch(() => {})
  }
  useEffect(() => {
    refreshDrafts()
  }, [])

  /** The server draft for this bill, created on first need (one request even if called twice). */
  function ensureDraft(): Promise<number> {
    if (draftIdRef.current) return Promise.resolve(draftIdRef.current)
    if (!draftPromiseRef.current) {
      draftPromiseRef.current = startDirectBillDraft({})
        .then((id) => { draftIdRef.current = id; setDraftId(id); return id })
        .catch((e) => { draftPromiseRef.current = null; throw e })
    }
    return draftPromiseRef.current
  }

  function dropBox(key: string, raw: string) {
    commitLines(billLinesRef.current
      .map((l) => (l.key === key ? { ...l, qty: l.qty - 1, boxCodes: l.boxCodes.filter((c) => c !== raw), notInStock: Math.min(l.notInStock, l.qty - 1) } : l))
      .filter((l) => l.qty > 0))
  }

  async function persistScan(key: string, raw: string, art: string) {
    setPendingScans((n) => n + 1)
    try {
      const id = await ensureDraft()
      const out = await scanIntoDirectBill(id, raw, newUuid())
      if (out.status === 'added') {
        if (!out.inStock) {
          commitLines(billLinesRef.current.map((l) => (l.key === key ? { ...l, notInStock: l.notInStock + 1 } : l)))
        }
        if (out.master.status !== 'known') noteNewArticle(raw, art, out.master, out.canCreateArticle)
        else if (!out.inStock) showWarning(`${art}: this box was not scanned into stock — it will go out as Unscanned dispatch.`)
      } else {
        dropBox(key, raw)
        showWarning(out.message)
        if (out.status === 'on_other_bill') playAlreadyScanned()
      }
    } catch (e) {
      dropBox(key, raw)
      showError(`Scan not saved (${errMsg(e)}) — scan the box again.`)
    } finally {
      setPendingScans((n) => n - 1)
    }
  }

  // ── New article detection (same form as the warehouse scanner) ────────────
  // The box is already on the bill. If its article/colour is not in the master, an admin gets the
  // New Article form (adds it to the master only; no stock scan); a biller gets a warning and the
  // box appears in Master → Articles → Missing articles. Asked once per article/colour per bill.
  const [articleDialog, setArticleDialog] = useState<{ rawQr: string; parsed: ParsedQr; mode: 'unknown' | 'new_colour'; existingName?: string } | null>(null)
  const articleDialogRef = useRef(false)
  const articleNotedRef = useRef<Set<string>>(new Set())

  function noteNewArticle(raw: string, art: string, master: Exclude<MasterMatch, { status: 'known' }>, canCreate: boolean) {
    const parsed = parseQr(raw)
    const key = `${parsed.articleCode}|${parsed.colorCode}`
    if (articleNotedRef.current.has(key)) return
    articleNotedRef.current.add(key)
    if (canCreate && !articleDialogRef.current) {
      articleDialogRef.current = true
      scanPausedRef.current = true
      setArticleDialog({ rawQr: raw, parsed, mode: master.status, existingName: master.status === 'new_colour' ? master.artName : undefined })
      return
    }
    showWarning(master.status === 'new_colour'
      ? `${art}: new colour, not in the article master. It stays on the bill; an admin can add it in Master → Articles → Missing articles.`
      : `${art}: new article, not in the article master. It stays on the bill; an admin can add it in Master → Articles → Missing articles.`)
  }

  function closeArticleDialog(linked: boolean) {
    articleDialogRef.current = false
    setArticleDialog(null)
    if (linked) showSuccess('Article added to the master.')
    setTimeout(() => { if (!articleDialogRef.current) scanPausedRef.current = false }, 800)
  }

  function resetLocal() {
    articleNotedRef.current = new Set()
    commitLines([])
    setSelectedVendor(null)
    setSkQuery('')
    setLineDiscPct(30)
    draftIdRef.current = null
    draftPromiseRef.current = null
    setDraftId(null)
    refreshDrafts()
  }

  async function resumeDraft(id: number) {
    if (pendingScans > 0) { showWarning('Still saving scans — try again in a moment.'); return }
    try {
      const d = await openDirectBillDraft(id)
      const lines: BillLine[] = []
      const put = (art: string, mrp: number, division: string, qty: number, raw: string | null, inStock: boolean) => {
        const key = lineKey(art, mrp)
        let l = lines.find((x) => x.key === key)
        if (!l) { l = { key, artNumber: art, mrp, division, qty: 0, boxCodes: [], notInStock: 0 }; lines.push(l) }
        l.qty += qty
        if (raw) { l.boxCodes.push(raw); if (!inStock) l.notInStock++ }
      }
      for (const sc of d.scans) {
        const p = isValidWarehouseQr(sc.raw) ? parseQr(sc.raw) : null
        put(p?.articleCode || sc.articleCode, p?.mrp ?? sc.mrp ?? 0, p?.division ?? '', 1, sc.raw, sc.inStock)
      }
      for (const m of d.manualLines) put(m.artNumber, m.mrp, '', m.qty, null, true)
      draftIdRef.current = id
      draftPromiseRef.current = Promise.resolve(id)
      setDraftId(id)
      commitLines(lines)
      const v = safeVendors.find((x) => x.name === d.shopkeeperName)
        ?? (d.shopkeeperName ? { id: `draft-${id}`, name: d.shopkeeperName, code: null, phone: d.shopkeeperPhone, address: d.shopkeeperAddress } : null)
      setSelectedVendor(v)
      setSkQuery(v?.name ?? '')
      setLineDiscPct(d.lineDiscPct)
      showSuccess(`Draft resumed: ${d.scans.length} boxes`)
    } catch (e) {
      showError(errMsg(e))
      refreshDrafts()
    }
  }

  async function discardDraftById(id: number) {
    if (!window.confirm('Discard this draft? Its boxes are freed; nothing is billed.')) return
    try {
      await discardDirectBillDraft(id)
      if (draftIdRef.current === id) resetLocal()
      else refreshDrafts()
    } catch (e) { showError(errMsg(e)) }
  }

  // ── Camera / scan refs ─────────────────────────────────────────────────────
  const videoRef            = useRef<HTMLVideoElement>(null)
  const canvasRef           = useRef<HTMLCanvasElement>(null)
  const scanCanvasRef       = useRef<HTMLCanvasElement | null>(null)
  const streamRef           = useRef<MediaStream | null>(null)
  const flashlightStreamRef = useRef<MediaStream | null>(null)
  const lastScanTimeRef     = useRef<number>(0)
  const scanningRef         = useRef(false)
  const scanPausedRef       = useRef(false)
  const fileInputRef        = useRef<HTMLInputElement>(null)

  const [isCameraActive, setIsCameraActive]     = useState(false)
  const [isFlashlightOn, setIsFlashlightOn]     = useState(false)
  const [qrDetected, setQrDetected]             = useState(false)
  const [uploadProcessing, setUploadProcessing] = useState(false)
  // ── Scan box: USB / Bluetooth scanners type the code + Enter. The Scan box keeps the cursor;
  // keys typed while nothing has the cursor are sent to it, so a scan is never lost.
  const scanInputRef = useRef<HTMLInputElement>(null)
  const [scanValue, setScanValue] = useState('')
  const [scanFocused, setScanFocused] = useState(false)
  const [lastAdded, setLastAdded] = useState<{ key: string; raw: string } | null>(null)
  function focusScan() { setTimeout(() => scanInputRef.current?.focus({ preventScroll: true }), 30) }
  function submitScan() {
    const code = scanValue.trim()
    setScanValue('')
    if (code) handleQrDecode(code)
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return
      if (articleDialogRef.current || document.querySelector('[role="dialog"]')) return
      const input = scanInputRef.current
      if (!input) return
      event.preventDefault()
      input.focus({ preventScroll: true })
      setScanValue(v => v + event.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // On a computer the Scan box has the cursor from the start.
  // (The panel can mount hidden behind a tab: focus it again when it becomes visible.)
  useEffect(() => {
    if (window.matchMedia('(pointer: coarse)').matches) return
    focusScan()
    const input = scanInputRef.current
    if (!input || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting) && (document.activeElement === document.body || !document.activeElement)) focusScan()
    })
    io.observe(input)
    return () => io.disconnect()
  }, [])

  // ── Banners ────────────────────────────────────────────────────────────────
  const [lastResult, setLastResult] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  // ── Manual entry ───────────────────────────────────────────────────────────
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [manualArt, setManualArt] = useState('')
  const [manualMrp, setManualMrp] = useState('')
  const [manualQty, setManualQty] = useState<number | ''>(1)

  // Article search for manual entry
  const [artQuery, setArtQuery] = useState('')
  const [artSelected, setArtSelected] = useState(false)

  const artResults = useMemo(() => {
    if (!artQuery.trim()) return articles.slice(0, 20)
    return fuzzyFilter(articles, artQuery, a => [a]).slice(0, 20)
  }, [artQuery, articles])

  // ── Bill number — timestamp-based (YYMMDDHHmmss), no state needed ─────────

  // ── Delete confirm ─────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      scanningRef.current = false
      if (flashlightStreamRef.current) flashlightStreamRef.current.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Banner helpers ─────────────────────────────────────────────────────────

  function showSuccess(msg: string) { setLastResult({ tone: 'ok', text: msg }) }
  function showWarning(msg: string) { setLastResult({ tone: 'warn', text: msg }) }
  function showError(msg: string) { setLastResult({ tone: 'err', text: msg }) }

  // ── Undo / one box less ────────────────────────────────────────────────────
  async function undoLastScan() {
    const last = lastAdded
    if (!last) return
    setLastAdded(null)
    if (directBill && draftIdRef.current) {
      try { await removeFromDirectBill(draftIdRef.current, [last.raw]) }
      catch (e) { showError(`Could not undo: ${errMsg(e)}`); return }
    }
    dropBox(last.key, last.raw)
    showWarning('Last scan removed from the bill.')
    focusScan()
  }

  /** One box less on a line: a box added by hand first, else the last scanned box (freed on the server). */
  async function decrementLine(key: string) {
    const line = billLinesRef.current.find(l => l.key === key)
    if (!line) return
    if (line.qty > line.boxCodes.length) {
      commitLines(billLinesRef.current.map(l => (l.key === key ? { ...l, qty: l.qty - 1 } : l)).filter(l => l.qty > 0))
      return
    }
    const raw = line.boxCodes[line.boxCodes.length - 1]
    if (directBill && draftIdRef.current) {
      try { await removeFromDirectBill(draftIdRef.current, [raw]) }
      catch (e) { showError(`Could not remove: ${errMsg(e)}`); return }
    }
    if (lastAdded?.raw === raw) setLastAdded(null)
    dropBox(key, raw)
  }

  // ── Bill line management ───────────────────────────────────────────────────

  function addScannedBox(art: string, mrp: number, division: string, rawQr: string) {
    const key = lineKey(art, mrp)
    const boxCode = rawQr.split('-').pop() ?? rawQr
    const prev = billLinesRef.current
    if (prev.some(l => l.boxCodes.some(c => (c.split('-').pop() ?? c) === boxCode))) {
      showWarning(`Box already scanned: ${art}`)
      playAlreadyScanned()
      return
    }
    const existing = prev.find(l => l.key === key)
    commitLines(existing
      ? prev.map(l => l.key === key ? { ...l, qty: l.qty + 1, boxCodes: [...l.boxCodes, rawQr] } : l)
      : [...prev, { key, artNumber: art, mrp, division, qty: 1, boxCodes: [rawQr], notInStock: 0 }])
    showSuccess(existing ? `+1 box: ${art} @ ₹${mrp.toFixed(2)} (now ${(existing.qty + 1)} boxes)` : `Added: ${art} @ ₹${mrp.toFixed(2)}`)
    setLastAdded({ key, raw: rawQr })
    playScanOk()
    if (directBill) void persistScan(key, rawQr, art)
  }

  function addManualLine(art: string, mrp: number, division: string, qty: number) {
    const key = lineKey(art, mrp)
    const prev = billLinesRef.current
    const existing = prev.find(l => l.key === key)
    commitLines(existing
      ? prev.map(l => l.key === key ? { ...l, qty: l.qty + qty } : l)
      : [...prev, { key, artNumber: art, mrp, division, qty, boxCodes: [], notInStock: 0 }])
    showSuccess(`Added ${qty}× ${art} @ ₹${mrp.toFixed(2)}`)
  }

  async function removeLine(key: string) {
    setDeleteTarget(null)
    const line = billLinesRef.current.find(l => l.key === key)
    if (directBill && draftIdRef.current && line && line.boxCodes.length) {
      try { await removeFromDirectBill(draftIdRef.current, line.boxCodes) }
      catch (e) { showError(`Could not remove: ${errMsg(e)}`); return }
    }
    commitLines(billLinesRef.current.filter(l => l.key !== key))
  }

  async function clearBill() {
    setDeleteTarget(null)
    // Direct Billing: "Clear All" discards the saved draft and frees its boxes.
    if (directBill && draftIdRef.current) {
      try { await discardDirectBillDraft(draftIdRef.current) }
      catch (e) { showError(`Could not clear: ${errMsg(e)}`); return }
      resetLocal()
      return
    }
    commitLines([])
  }

  // ── QR decode → bill ───────────────────────────────────────────────────────

  function handleQrDecode(raw: string) {
    if (articleDialogRef.current) {
      showWarning('Finish or close the New Article form first, then scan again.')
      return
    }
    if (!isValidWarehouseQr(raw)) {
      showWarning('QR code format not recognised — only warehouse box QR codes are accepted.')
      return
    }
    const p = parseQr(raw)
    addScannedBox(p.articleCode, p.mrp, p.division, raw)
  }

  // ── Camera helpers ─────────────────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      if (!videoRef.current) { stream.getTracks().forEach(t => t.stop()); return }
      videoRef.current.srcObject = stream
      streamRef.current = stream
      setIsCameraActive(true)
      scanningRef.current = true
      const video = videoRef.current
      const startLoop = () => scanLoop(video)
      if (video.readyState >= 2) startLoop()
      else video.addEventListener('loadeddata', startLoop, { once: true })
    } catch {
      showError('Camera permission denied or unavailable.')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stopCamera() {
    scanningRef.current = false
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
    setIsCameraActive(false)
  }

  function scanLoop(video: HTMLVideoElement) {
    if (!scanningRef.current) return
    if (video.videoWidth === 0 || video.videoHeight === 0) { requestAnimationFrame(() => scanLoop(video)); return }
    if (scanPausedRef.current) { requestAnimationFrame(() => scanLoop(video)); return }

    const now = performance.now()
    if (now - lastScanTimeRef.current < SCAN_INTERVAL_MS) { requestAnimationFrame(() => scanLoop(video)); return }
    lastScanTimeRef.current = now

    let sc = scanCanvasRef.current
    const scale = Math.min(1, SCAN_MAX_DIM / Math.max(video.videoWidth, video.videoHeight))
    const sw = Math.round(video.videoWidth * scale)
    const sh = Math.round(video.videoHeight * scale)
    if (!sc || sc.width !== sw || sc.height !== sh) {
      sc = document.createElement('canvas'); sc.width = sw; sc.height = sh; scanCanvasRef.current = sc
    }
    const sctx = sc.getContext('2d', { willReadFrequently: true })
    if (!sctx) { requestAnimationFrame(() => scanLoop(video)); return }

    sctx.drawImage(video, 0, 0, sw, sh)
    try {
      const imageData = sctx.getImageData(0, 0, sw, sh)
      const code = jsQR(imageData.data, imageData.width, imageData.height)
      if (code) {
        scanPausedRef.current = true; setQrDetected(true)
        // Stays paused while the New Article form is open.
        setTimeout(() => { if (!articleDialogRef.current) scanPausedRef.current = false; setQrDetected(false) }, 2000)
        handleQrDecode(code.data)
      }
    } catch { /* ignore */ }
    requestAnimationFrame(() => scanLoop(video))
  }

  async function toggleFlashlight() {
    if (!isFlashlightOn) {
      try {
        let track: MediaStreamTrack | undefined
        if (streamRef.current) { track = streamRef.current.getVideoTracks()[0] }
        else {
          const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
          flashlightStreamRef.current = s; track = s.getVideoTracks()[0]
        }
        if (!track) return
        await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] })
        setIsFlashlightOn(true)
      } catch {
        if (flashlightStreamRef.current) { flashlightStreamRef.current.getTracks().forEach(t => t.stop()); flashlightStreamRef.current = null }
        showWarning('Flashlight not supported on this device.')
      }
    } else {
      const track = (streamRef.current ?? flashlightStreamRef.current)?.getVideoTracks()[0]
      if (track) track.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] }).catch(() => {})
      if (flashlightStreamRef.current) { flashlightStreamRef.current.getTracks().forEach(t => t.stop()); flashlightStreamRef.current = null }
      setIsFlashlightOn(false)
    }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']
    if (!allowed.includes(file.type)) { showError('Invalid image file type.'); if (fileInputRef.current) fileInputRef.current.value = ''; return }
    setUploadProcessing(true)
    try {
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close()
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(imageData.data, imageData.width, imageData.height)
      if (!code) { showError('No QR code found in image.'); return }
      handleQrDecode(code.data)
    } catch { showError('Could not process image.') }
    finally { setUploadProcessing(false); if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  // ── Manual entry submit ────────────────────────────────────────────────────

  function handleManualAdd(e: React.FormEvent) {
    e.preventDefault()
    const art = manualArt.trim().toUpperCase()
    const mrp = parseFloat(manualMrp) || 0
    const qty = Number(manualQty) || 1
    if (!art) { showError('Article number is required.'); return }
    addManualLine(art, mrp, '', qty)
    setManualQty(1)
    setManualArt('')
    setArtQuery('')
    setArtSelected(false)
  }

  // ── Group lines by artNumber (for display & print) ─────────────────────────
  const billGroups = useMemo(() => {
    const groups: { artNumber: string; lines: BillLine[] }[] = []
    const seen = new Map<string, BillLine[]>()
    for (const line of billLines) {
      if (!seen.has(line.artNumber)) {
        const g: BillLine[] = []
        seen.set(line.artNumber, g)
        groups.push({ artNumber: line.artNumber, lines: g })
      }
      seen.get(line.artNumber)!.push(line)
    }
    return groups
  }, [billLines])

  // ── Print (and optionally persist to DB as emergency bill) ─────────────────

  const [isSaving, setIsSaving] = useState(false)

  async function handlePrint() {
    if (!selectedVendor) { showError('Please select a vendor first.'); return }
    if (billLines.length === 0) { showError('No items scanned yet.'); return }

    // Build MrpLine[] from billLines (each BillLine already has artNumber + mrp + qty)
    const lines = billLines.map(l => ({ artNumber: l.artNumber, mrp: l.mrp, qty: l.qty }))

    // Direct Billing: generate from the saved draft (takes the boxes out of stock), then Receipts.
    if (onBillGenerated) {
      if (pendingScans > 0) { showWarning('Still saving scans — try again in a moment.'); return }
      setIsSaving(true)
      try {
        const id = await ensureDraft()
        const header = draftHeader()
        const res = await generateDirectBillFromDraft(id, header)
        onBillGenerated({ ...res, shopkeeperName: header.shopkeeperName, shopkeeperPhone: header.shopkeeperPhone, shopkeeperAddress: header.shopkeeperAddress })
        resetLocal()
        if (res.stock.unscanned_dispatch > 0) showWarning(`Bill ${res.orderNumber} saved. ${res.stock.unscanned_dispatch} box(es) went out as Unscanned dispatch.`)
      } catch (e) {
        showError(`Bill not generated: ${errMsg(e)} It is still saved as a draft.`)
      } finally {
        setIsSaving(false)
      }
      return
    }

    // Standalone /billing page — open print window directly
    const html = buildInvoiceHtml({
      vendor: {
        name:    selectedVendor.name,
        phone:   selectedVendor.phone,
        area:    selectedVendor.code,
        address: selectedVendor.address,
      },
      order:       { orderNumber: '', billedAt: new Date() },
      lines,
      lineDiscPct: LINE_DISC_PCT,
    })

    const win = window.open('', '_blank', 'width=860,height=1000')
    if (!win) { showError('Pop-up blocked. Please allow pop-ups for this site.'); return }
    win.document.write(html); win.document.close(); win.focus()
    win.onload = () => win.print()
  }

  // ── Fixed charges ─────────────────────────────────────────────────────────
  const DISC_PCT = 4.75
  const CGST_PCT = 2.50
  const SGST_PCT = 2.50

  // Per-unit column discount — user-configurable via the Bill tab input
  const [lineDiscPct, setLineDiscPct] = useState<number | ''>(30)
  const LINE_DISC_PCT = lineDiscPct === '' ? 30 : Number(lineDiscPct)

  // ── Direct Billing: keep the draft's retailer, discount and hand-typed lines saved ──
  const manualLinesForServer = useMemo(
    () => billLines.map(l => ({ artNumber: l.artNumber, mrp: l.mrp, qty: l.qty - l.boxCodes.length })).filter(l => l.qty > 0),
    [billLines],
  )
  function draftHeader(): DraftHeader {
    return {
      shopkeeperName: selectedVendor?.name ?? '',
      shopkeeperPhone: selectedVendor?.phone ?? null,
      shopkeeperAddress: selectedVendor?.address ?? null,
      lineDiscPct: LINE_DISC_PCT,
      manualLines: manualLinesForServer,
    }
  }
  const headerKey = JSON.stringify(draftHeader())
  useEffect(() => {
    if (!directBill) return
    if (!draftIdRef.current && !selectedVendor && manualLinesForServer.length === 0) return
    const header = JSON.parse(headerKey) as DraftHeader
    const t = setTimeout(() => {
      ensureDraft().then((id) => saveDirectBillDraft(id, header)).catch(() => { /* retried on the next change; generate reports errors */ })
    }, 700)
    return () => clearTimeout(t)
  }, [headerKey])

  const totalQty   = billLines.reduce((s, l) => s + l.qty, 0)
  // Sub Total uses the discounted rate (same formula as printed invoice)
  const subTotal   = billLines.reduce((s, l) => s + Math.ceil(l.mrp * (1 - LINE_DISC_PCT / 100)) * l.qty, 0)
  const discAmt    = Math.round(subTotal * DISC_PCT / 100 * 100) / 100
  const afterDisc  = subTotal - discAmt
  const cgstAmt    = Math.round(afterDisc * CGST_PCT / 100 * 100) / 100
  const sgstAmt    = Math.round(afterDisc * SGST_PCT / 100 * 100) / 100
  const netAmt     = Math.round((afterDisc + cgstAmt + sgstAmt) * 100) / 100

  const otherDrafts = drafts.filter(d => d.id !== draftId)

  // ── Render ─────────────────────────────────────────────────────────────────
  // Designed for the biller (owner, 20 Nov 2026): the Scan box keeps the cursor so a USB / Bluetooth
  // scanner always lands in the bill; the bill, totals and Generate stay in view while scanning.

  // Undo stays available while the last added box is still on the bill (also after a warning).
  const canUndo = !!lastAdded && billLines.some(l => l.boxCodes.includes(lastAdded.raw))
  const canGenerate = !!selectedVendor && billLines.length > 0 && !isSaving && pendingScans === 0
  const generateHint = !selectedVendor ? 'Choose the retailer to generate the bill.'
    : billLines.length === 0 ? 'Scan boxes to start the bill.'
    : pendingScans > 0 ? 'Saving scans…' : ''
  const TONE = {
    ok: 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200',
    err: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200',
  }

  return (
    <div className={embedded ? 'space-y-4 pb-24 lg:pb-0' : 'min-h-screen bg-background p-3 sm:p-4 md:p-6 pb-24 lg:pb-6'}>
      <div className={embedded ? 'space-y-4' : 'mx-auto max-w-6xl space-y-4'}>

        {!embedded && (
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Billing</h1>
            <PageNav />
          </div>
        )}

        {/* ── Drafts: one line; tap to open ── */}
        {directBill && (draftId != null || otherDrafts.length > 0) && (
          <section aria-label="Saved drafts" className="rounded-2xl border border-border bg-card">
            <button type="button" onClick={() => setDraftsOpen(o => !o)} aria-expanded={draftsOpen}
              className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
              <span className="text-sm font-semibold text-foreground">
                {otherDrafts.length > 0 ? `Draft bills (${otherDrafts.length})` : 'Draft bills'}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {draftId != null && <span>{pendingScans > 0 ? `This bill: draft #${draftId} · saving…` : `This bill: draft #${draftId}`}</span>}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-4 w-4 transition-transform ${draftsOpen ? 'rotate-180' : ''}`} aria-hidden>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </button>
            {draftsOpen && (
              <div className="space-y-2 border-t border-border p-3">
                {draftId != null && billLines.length > 0 && (
                  <button type="button" onClick={() => { resetLocal(); setDraftsOpen(false); focusScan() }} disabled={pendingScans > 0}
                    className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50">
                    Start a new bill (keep this as draft)
                  </button>
                )}
                {otherDrafts.length === 0 && <p className="text-xs text-muted-foreground">No other saved drafts.</p>}
                {otherDrafts.length > 0 && (
                  <ul className="max-h-[45dvh] divide-y divide-border overflow-y-auto rounded-xl border border-border">
                    {otherDrafts.map(d => (
                      <li key={d.id} className="flex items-center gap-2 px-3 py-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground truncate">{d.shopkeeperName || 'No retailer yet'} <span className="text-muted-foreground">· #{d.id}</span></p>
                          <p className="text-[11px] text-muted-foreground">
                            {d.boxes} box{d.boxes === 1 ? '' : 'es'}{d.manualPairs ? ` + ${d.manualPairs} typed` : ''} · {d.billerName || '—'} · {new Date(d.updatedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                        <button type="button" onClick={() => { setDraftsOpen(false); void resumeDraft(d.id).then(focusScan) }} className="rounded-lg bg-foreground text-background px-2.5 py-1 text-xs font-semibold">Resume</button>
                        <button type="button" onClick={() => discardDraftById(d.id)} className="rounded-lg border border-border px-2.5 py-1 text-xs text-destructive hover:bg-muted">Discard</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
          {/* ════════ LEFT: retailer, scan, manual ════════ */}
          <div className="space-y-4 min-w-0">

            {/* Retailer */}
            <section aria-labelledby="retailer-heading" className="rounded-2xl border border-border bg-card p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 id="retailer-heading" className="text-sm font-semibold">1. Retailer</h2>
                {selectedVendor && (
                  <button type="button" onClick={() => { setSelectedVendor(null); setSkQuery('') }} className="text-xs font-medium text-primary hover:underline">Change</button>
                )}
              </div>
              {!selectedVendor ? (
                <SearchCombobox<BillingVendor>
                  id="vendor-search"
                  label="Search retailer"
                  required
                  placeholder="Type retailer name, area or phone…"
                  inputValue={skQuery}
                  onInputChange={setSkQuery}
                  onSelect={v => { setSelectedVendor(v); setSkQuery(v.name); focusScan() }}
                  onClear={() => { setSelectedVendor(null); setSkQuery('') }}
                  results={skResults}
                  loading={false}
                  getKey={v => v.id}
                  renderOption={(v, active) => (
                    <div className="flex items-center justify-between gap-4">
                      <span className={`font-medium ${active ? 'text-primary-foreground' : 'text-foreground'}`}>{v.name}</span>
                      <span className={`text-xs font-mono ${active ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>{v.code ?? v.address ?? ''}</span>
                    </div>
                  )}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">{selectedVendor.name[0].toUpperCase()}</div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{selectedVendor.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{[selectedVendor.code, selectedVendor.phone, selectedVendor.address].filter(Boolean).join(' · ')}</p>
                  </div>
                </div>
              )}
            </section>

            {/* Scan */}
            <section aria-labelledby="scan-heading" className="rounded-2xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 id="scan-heading" className="text-sm font-semibold">2. Scan boxes</h2>
                <button type="button" onClick={() => scanInputRef.current?.focus()}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${scanFocused ? 'bg-emerald-600 text-white' : 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200'}`}>
                  {scanFocused ? '● Scanner ready' : 'Click here to scan'}
                </button>
              </div>
              <form onSubmit={e => { e.preventDefault(); submitScan() }}>
                <label htmlFor="scan-box" className="sr-only">Scan box</label>
                <input
                  ref={scanInputRef}
                  id="scan-box"
                  value={scanValue}
                  onChange={e => setScanValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Tab' && scanValue.trim()) { e.preventDefault(); submitScan() } }}
                  onFocus={() => setScanFocused(true)}
                  onBlur={() => setScanFocused(false)}
                  autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="done"
                  placeholder="Scan the box QR — or type the code and press Enter"
                  className={`h-12 w-full rounded-xl border-2 bg-background px-3 font-mono text-sm focus:outline-none ${scanFocused ? 'border-emerald-500' : 'border-border'}`}
                />
              </form>

              {lastResult && (
                <div className={`rounded-xl border px-3 py-2.5 ${TONE[lastResult.tone]}`} role="status" aria-live="polite">
                  <p className="text-sm font-semibold">{lastResult.text}</p>
                  {canUndo && (
                    <button type="button" onClick={undoLastScan} disabled={pendingScans > 0} className="mt-1 text-xs underline disabled:opacity-50">Undo last scan</button>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={isCameraActive ? stopCamera : startCamera}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${isCameraActive ? 'border border-border hover:bg-muted' : 'bg-foreground text-background hover:opacity-90'}`}>
                  {isCameraActive ? 'Stop camera' : 'Scan with camera'}
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                <button type="button" disabled={uploadProcessing || isCameraActive} onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
                  {uploadProcessing ? 'Reading…' : 'QR photo'}
                </button>
                {isCameraActive && (
                  <button type="button" onClick={toggleFlashlight} aria-pressed={isFlashlightOn}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium ${isFlashlightOn ? 'border-yellow-400 bg-yellow-50 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200' : 'border-border hover:bg-muted'}`}>
                    {isFlashlightOn ? '⚡ Light on' : '⚡ Light'}
                  </button>
                )}
              </div>
              <div className={`relative overflow-hidden rounded-lg bg-black aspect-[4/3] sm:aspect-video ${isCameraActive ? '' : 'hidden'}`}>
                <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
                <canvas ref={canvasRef} className="hidden" />
                {isCameraActive && <div className={`pointer-events-none absolute inset-0 rounded-lg border-4 ${qrDetected ? 'border-green-400 animate-pulse' : 'border-white/20'}`} />}
              </div>
            </section>

            {/* Box without QR */}
            <details className="rounded-2xl border border-border bg-card p-4 [&_summary::-webkit-details-marker]:hidden">
              <summary className="cursor-pointer list-none text-sm font-semibold">Box without QR? Add by hand ▾</summary>
              <form onSubmit={e => { handleManualAdd(e); focusScan() }} className="mt-3 space-y-2">
                <div className="relative">
                  <label htmlFor="b-art" className="text-xs font-medium text-muted-foreground">Article</label>
                  <input id="b-art" type="text" autoComplete="off" value={artQuery} placeholder="Search article…"
                    onChange={e => { setArtQuery(e.target.value); setManualArt(e.target.value.toUpperCase()); setArtSelected(false) }}
                    onFocus={() => setArtSelected(false)}
                    className="mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                  {artQuery && !artSelected && artResults.length > 0 && (
                    <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-card shadow-xl">
                      {artResults.map(a => (
                        <li key={a} onMouseDown={e => { e.preventDefault(); setArtQuery(a); setManualArt(a.toUpperCase()); setArtSelected(true) }}
                          className="cursor-pointer px-3 py-1.5 font-mono text-sm hover:bg-muted">{a}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="text-xs font-medium text-muted-foreground">MRP (₹)
                    <input type="number" min="0" step="0.01" value={manualMrp} onChange={e => setManualMrp(e.target.value)} placeholder="0.00"
                      className="mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                  </label>
                  <label className="text-xs font-medium text-muted-foreground">Boxes
                    <input type="number" min="1" value={manualQty} onChange={e => setManualQty(e.target.value === '' ? '' : parseInt(e.target.value) || 1)}
                      className="mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                  </label>
                  <button type="submit" className="mt-4 h-9 rounded-lg bg-foreground px-3 text-sm font-semibold text-background hover:opacity-90">Add</button>
                </div>
              </form>
            </details>
          </div>

          {/* ════════ RIGHT: the bill ════════ */}
          <section aria-labelledby="bill-heading" className="min-w-0 rounded-2xl border border-border bg-card lg:sticky lg:top-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 id="bill-heading" className="text-sm font-semibold">3. Bill{selectedVendor ? ` — ${selectedVendor.name}` : ''}</h2>
                <p className="text-xs text-muted-foreground">{`${billLines.length} line(s) · ${totalQty} box(es)`}</p>
              </div>
              <label className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
                Disc %
                <input type="number" min="0" max="100" step="0.5" value={lineDiscPct}
                  onChange={e => setLineDiscPct(e.target.value === '' ? '' : Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                  onBlur={() => { if (lineDiscPct === '') setLineDiscPct(30) }}
                  className="h-6 w-14 rounded border border-input bg-background px-1.5 text-center text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
              </label>
              {billLines.length > 0 && (
                <button type="button" onClick={() => setDeleteTarget('__all__')} className="rounded-lg border border-border px-2.5 py-1 text-xs text-destructive hover:bg-muted">Clear all</button>
              )}
            </div>

            {billLines.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">No boxes yet. Scan a box — it appears here at once.</p>
            ) : (
              <div className="max-h-[55vh] overflow-y-auto lg:max-h-[50vh]">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border/60 text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Article</th>
                      <th className="px-2 py-2 text-right font-medium">MRP</th>
                      <th className="px-2 py-2 text-right font-medium">Rate</th>
                      <th className="px-2 py-2 text-center font-medium">Boxes</th>
                      <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Amount</th>
                      <th className="w-8 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {billGroups.map(group => group.lines.map((line, i) => {
                      const rate = Math.ceil(line.mrp * (1 - LINE_DISC_PCT / 100))
                      return (
                        <tr key={line.key} className="border-b border-border/40">
                          <td className="px-3 py-2 align-top">
                            {i === 0 && <span className="whitespace-nowrap text-xs font-bold text-foreground" data-no-translate>{group.artNumber}</span>}
                            {line.notInStock > 0 && <span className="block whitespace-nowrap text-[10px] text-amber-700 dark:text-amber-400" title="Not scanned into stock: goes out as Unscanned dispatch">{`${line.notInStock} not in stock`}</span>}
                            {line.qty > line.boxCodes.length && <span className="block text-[10px] text-muted-foreground">{`${line.qty - line.boxCodes.length} added by hand`}</span>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right text-xs text-muted-foreground tabular-nums">₹{line.mrp.toFixed(2)}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-right text-xs tabular-nums">₹{rate.toFixed(2)}</td>
                          <td className="px-2 py-2">
                            <div className="flex items-center justify-center gap-1">
                              <button type="button" onClick={() => decrementLine(line.key)} disabled={pendingScans > 0} aria-label={`One box less of ${line.artNumber}`}
                                className="flex h-6 w-6 items-center justify-center rounded-md border border-border text-sm hover:bg-muted disabled:opacity-40">−</button>
                              <span className="w-6 text-center font-bold tabular-nums">{line.qty}</span>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right text-xs font-medium tabular-nums">₹{(rate * line.qty).toFixed(2)}</td>
                          <td className="px-2 py-2 text-right">
                            <button type="button" onClick={() => setDeleteTarget(line.key)} aria-label={`Remove ${line.artNumber}`} className="text-muted-foreground hover:text-destructive">✕</button>
                          </td>
                        </tr>
                      )
                    }))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="space-y-1 border-t border-border px-4 py-3 text-xs">
              <div className="flex justify-between text-muted-foreground"><span>{`Sub total (${totalQty} boxes)`}</span><span className="tabular-nums">₹{subTotal.toFixed(2)}</span></div>
              <div className="flex justify-between text-red-600"><span>{`Discount (${DISC_PCT}%)`}</span><span className="tabular-nums">− ₹{discAmt.toFixed(2)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>{`CGST (${CGST_PCT}%)`}</span><span className="tabular-nums">+ ₹{cgstAmt.toFixed(2)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>{`SGST (${SGST_PCT}%)`}</span><span className="tabular-nums">+ ₹{sgstAmt.toFixed(2)}</span></div>
              <div className="flex justify-between pt-1 text-base font-bold text-foreground"><span>Net payable</span><span className="tabular-nums">₹{netAmt.toFixed(2)}</span></div>
            </div>
            <div className="hidden px-4 pb-4 lg:block">
              {generateHint && <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">{generateHint}</p>}
              <button type="button" onClick={() => { void handlePrint().then(focusScan) }} disabled={!canGenerate}
                className="w-full rounded-xl bg-purple-600 px-4 py-3 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50">
                {isSaving ? 'Generating…' : onBillGenerated ? 'Generate bill → Receipts' : 'Generate & print bill'}
              </button>
            </div>
          </section>
        </div>

        {/* Phones: totals and Generate stay at the bottom */}
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-3 py-2.5 backdrop-blur lg:hidden pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <div className="min-w-0 flex-1 text-xs">
              <p className="font-semibold text-foreground">{`${totalQty} box(es) · ₹${netAmt.toFixed(2)}`}</p>
              <p className="truncate text-muted-foreground">{generateHint || (selectedVendor?.name ?? '')}</p>
            </div>
            <button type="button" onClick={() => { void handlePrint() }} disabled={!canGenerate}
              className="shrink-0 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {isSaving ? 'Generating…' : 'Generate bill'}
            </button>
          </div>
        </div>

        {articleDialog && (
          <NewArticleDialog
            rawQr={articleDialog.rawQr}
            parsed={articleDialog.parsed}
            mode={articleDialog.mode}
            existingName={articleDialog.existingName}
            saveScan={false}
            closeLabel="Close (the box stays on the bill)"
            onClose={() => { closeArticleDialog(false); focusScan() }}
            onSaveLater={async () => { closeArticleDialog(false); focusScan(); return true }}
            onLinked={async () => { closeArticleDialog(true); focusScan() }}
          />
        )}

        {/* ── Confirm dialog ── */}
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-background p-6 shadow-xl">
              <h3 className="text-base font-semibold">{deleteTarget === '__all__' ? 'Clear all items?' : 'Remove this line?'}</h3>
              <p className="text-sm text-muted-foreground">
                {deleteTarget === '__all__'
                  ? directBill ? 'The draft is discarded and its boxes are freed. Nothing is billed.' : 'All scanned items will be removed from the bill.'
                  : 'All boxes of this line are removed from the bill.'}
              </p>
              <div className="flex gap-2 pt-1">
                <Button variant="destructive" className="flex-1" onClick={() => { void (deleteTarget === '__all__' ? clearBill() : removeLine(deleteTarget)).then(focusScan) }}>
                  {deleteTarget === '__all__' ? 'Clear all' : 'Remove'}
                </Button>
                <Button variant="outline" className="flex-1" onClick={() => { setDeleteTarget(null); focusScan() }}>Cancel</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
