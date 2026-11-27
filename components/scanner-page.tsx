'use client'

// Warehouse Scanner (owner, 26 Nov 2026; docs/architecture/warehouse-scanner.md).
// The godown has no fixed areas: loose pairs, open cartons and sealed cartons are mixed. So the
// screen opens straight into the ONE godown stocktake (the first scan starts it) and anything can be scanned in any
// order: a pair's box QR counts +1 at once; a carton QR asks "sealed (count its pairs) or open (scan
// its pairs)". A rack / area is optional. One request per scan (POST /api/scanner/scan); scans never
// wait for each other. Offline scans stay on the phone and are sent when the internet is back.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Camera, CameraOff, ChevronDown, Flashlight, ImageUp, Keyboard, ListChecks, MapPin, MoreHorizontal, RefreshCw, Settings2, WifiOff, BarChart3 } from 'lucide-react'
import { playAlreadyScanned, playNewArticle, playScanOk } from '@/lib/scan-sound'
import { addManualEntry, countStocktakeCartonAction, deleteScan, undoStocktakeCartonAction } from '@/app/actions/scan'
import { getScannerBoot, refreshSessionAction, type ScannerUser } from '@/app/actions/scanner'
import type { FeedItem, Rack, SessionInfo, SessionTotals } from '@/lib/inventory/stocktake-sessions'
import type { ScanReply } from '@/lib/inventory/scanner-scan'
import type { StocktakeCartonAsk } from '@/lib/inventory/stocktake-carton'
import type { AssortmentAnswer } from '@/lib/purchases/assortment-entry'
import { formatSizes } from '@/lib/catalog/assortments'
import { isCartonQr, isValidWarehouseQr, parseQr, type ParsedQr } from '@/lib/qr-parser'
import { enqueue, getQueue, removeFromQueue, type OfflineEntry } from '@/lib/offline-queue'
import { syncQueue } from '@/lib/sync-engine'
import { useOnline } from '@/lib/use-online'
import { useScanForwarder, useScannerScreen } from '@/lib/shortcuts'
import { PageNav } from '@/components/page-nav'
import { NewArticleDialog } from '@/components/scanner/new-article-dialog'
import { StocktakeCartonCard } from '@/components/scanner/stocktake-carton-card'
import { decodeQrImage, useQrScanner } from '@/components/scanner/use-qr-scanner'
import { RackManager } from '@/components/scanner/rack-manager'
import { ScanFeed, entryFromItem, feedTitle, type FeedEntry } from '@/components/scanner/scan-feed'
import { ManualEntryDialog, type ManualValues } from '@/components/scanner/manual-entry-dialog'
import { CountsDialog, FinishCount } from '@/components/scanner/counts-dialog'
import { Sheet, dayTimeIST, fieldCls, primaryBtn, secondaryBtn, timeIST } from '@/components/scanner/sheet'

const STOCKTAKE_KEY = 'shayona.scanner.stocktake'
const AREA_KEY = 'shayona.scanner.area'
const PAGE_SAVED_KEY = 'shayona.scanner.pageSavedAt'
/** A scan with no answer by then is kept on the phone (sent again later). */
const SCAN_TIMEOUT_MS = 8000
/** Totals refresh while this phone is scanning: every 30 s, only if it scanned in the last 5 min (Neon can sleep otherwise). */
const LIVE_EVERY_MS = 30_000
const LIVE_WHILE_ACTIVE_MS = 5 * 60_000
/** Must match PAGES_CACHE in public/sw.js. */
const PAGES_CACHE = 'shayona-pages-v5'
type Flash = { tone: 'ok' | 'warn' | 'err'; text: string }
type SheetName = null | 'manual' | 'counts' | 'racks' | 'offline' | 'more' | 'area'
type CartonAsk = { id: string; raw: string; ask: StocktakeCartonAsk }

const EMPTY_TOTALS: SessionTotals = { pairs: 0, boxes: 0, manualPairs: 0, cartons: 0, cartonPairs: 0, missing: 0, people: 0 }

function readNumber(key: string): number | null {
  try { const n = Number(localStorage.getItem(key)); return Number.isInteger(n) && n > 0 ? n : null } catch { return null }
}
function readText(key: string): string | null {
  try { return localStorage.getItem(key) || null } catch { return null }
}
function write(key: string, v: string | number | null) {
  try { if (v == null || v === '') localStorage.removeItem(key); else localStorage.setItem(key, String(v)) } catch { /* storage unavailable */ }
}
const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

/** Server rows replace saved local rows; rows still saving / offline / refused stay (by clientEventId). */
function mergeFeed(local: FeedEntry[], server: FeedItem[]): FeedEntry[] {
  const fromServer = server.map(entryFromItem)
  const known = new Set(fromServer.map((e) => e.key))
  const keep = local.filter((e) => !known.has(e.key) && e.state !== 'saved' && e.state !== 'missing')
  return [...keep, ...fromServer].sort((a, b) => b.at - a.at).slice(0, 100)
}

export function ScannerPage() {
  // Plain-key shortcuts are off on this screen so a scanner machine's keys always reach the Scan box.
  useScannerScreen()

  const [user, setUser] = useState<ScannerUser | null>(null)
  const [racks, setRacks] = useState<Rack[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // The open stocktake's id (kept on the phone so scanning works offline too; null = the server picks the open one).
  const stocktakeRef = useRef<number | null>(null)
  const [session, setSession] = useState<SessionInfo | null>(null)
  // Optional rack / area the next scans are tagged with.
  const [area, setAreaState] = useState<string | null>(null)
  const areaRef = useRef<string | null>(null)
  const [feed, setFeed] = useState<FeedEntry[]>([])
  const [flash, setFlash] = useState<Flash | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sheet, setSheet] = useState<SheetName>(null)
  const [finishing, setFinishing] = useState<SessionInfo | null>(null)
  const [offlineQueue, setOfflineQueue] = useState<OfflineEntry[]>([])
  const [syncing, setSyncing] = useState(false)

  // Boxes already counted on this phone in this stocktake (instant "already scanned" without a request).
  const seenRef = useRef(new Map<string, string>()) // identity → clientEventId
  // When this phone last scanned or saved something (live totals only while scanning).
  const lastActivityRef = useRef(0)

  // Boxes whose article is new (admin): the new-article dialog.
  const [newArticle, setNewArticle] = useState<{ raw: string; id: string; parsed: ParsedQr; mode: 'unknown' | 'new_colour'; existingName?: string } | null>(null)
  // Carton labels waiting for "sealed or open?" (first scanned first).
  const [cartons, setCartons] = useState<CartonAsk[]>([])
  const cartonKeysRef = useRef(new Set<string>())
  const [cartonBusy, setCartonBusy] = useState(false)
  const [cartonError, setCartonError] = useState('')
  // Undo one row.
  const [undo, setUndo] = useState<FeedItem | null>(null)
  const [undoReason, setUndoReason] = useState('')
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoError, setUndoError] = useState('')

  // The camera keeps running but decodes nothing while a card or dialog is open.
  const modalOpen = Boolean(newArticle || cartons.length || sheet || undo || finishing)
  const modalOpenRef = useRef(false)
  useEffect(() => { modalOpenRef.current = modalOpen }, [modalOpen])

  const setArea = useCallback((a: string | null) => { areaRef.current = a; setAreaState(a); write(AREA_KEY, a) }, [])

  const say = useCallback((tone: Flash['tone'], text: string) => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
    setFlash({ tone, text })
    flashTimer.current = setTimeout(() => setFlash(null), tone === 'ok' ? 3000 : 6000)
  }, [])

  const addTotals = useCallback((d: Partial<SessionTotals>) => {
    setSession((s) => {
      if (!s) return s
      const t = { ...s.totals }
      for (const [k, v] of Object.entries(d) as Array<[keyof SessionTotals, number]>) t[k] = Math.max(0, t[k] + v)
      return { ...s, totals: t }
    })
  }, [])

  const patchEntry = useCallback((key: string, patch: Partial<FeedEntry>) => {
    setFeed((f) => f.map((e) => (e.key === key ? { ...e, ...patch } : e)))
  }, [])
  const pushEntry = useCallback((e: FeedEntry) => setFeed((f) => [e, ...f.filter((x) => x.key !== e.key)].slice(0, 100)), [])

  const refreshOffline = useCallback(async () => { try { setOfflineQueue(await getQueue()) } catch { /* IndexedDB unavailable */ } }, [])

  const applySession = useCallback((s: SessionInfo, items: FeedItem[]) => {
    const same = stocktakeRef.current === s.id
    stocktakeRef.current = s.id
    write(STOCKTAKE_KEY, s.id)
    if (!same) seenRef.current.clear()
    setSession(s)
    setFeed((f) => mergeFeed(same ? f : [], items))
  }, [])

  /** No stocktake open (none yet, or it was finished): the next scan starts one. */
  const clearSession = useCallback(() => {
    stocktakeRef.current = null
    write(STOCKTAKE_KEY, null)
    seenRef.current.clear()
    setSession(null)
    setFeed([])
  }, [])

  /** Opening the screen: the open stocktake, if any. Creates nothing. One request. */
  const loadBoot = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const b = await getScannerBoot()
      setUser(b.user); setRacks(b.racks)
      if (b.session) applySession(b.session, b.feed); else clearSession()
    } catch {
      setLoadError('Could not load. Check the internet and try again.')
    } finally { setLoading(false) }
  }, [applySession, clearSession])

  /** Fresh totals (everyone's scans) and my list. One request. */
  const refreshSession = useCallback(async () => {
    const id = stocktakeRef.current
    if (!id || !navigator.onLine) return
    try {
      const r = await refreshSessionAction(id)
      if (!r.ok || stocktakeRef.current !== id) return
      const s = r.data.session
      if (!s || s.status === 'finished') {
        if (s) say('warn', `The stocktake was finished by ${s.finishedByName ?? 'an admin'}: ${s.totals.pairs} pairs. The next scan starts a new one.`)
        clearSession()
        return
      }
      setSession(s)
      setFeed((f) => mergeFeed(f, r.data.feed))
    } catch { /* shown on the next refresh */ }
  }, [clearSession, say])

  /** The server put a scan into stocktake `id` (a new one, or one this phone had not heard of): follow it. */
  const followStocktake = useCallback((id: number | null | undefined) => {
    if (!id || id === stocktakeRef.current) return
    stocktakeRef.current = id
    write(STOCKTAKE_KEY, id)
    void refreshSession()
  }, [refreshSession])

  const handleSync = useCallback(async () => {
    const q = await getQueue().catch(() => [] as OfflineEntry[])
    if (!q.some((e) => e.status === 'pending' || e.status === 'syncing')) return
    setSyncing(true)
    try {
      const r = await syncQueue()
      if (r.synced) say('ok', `${r.synced} scan(s) saved from this phone.`)
      if (r.duplicates) say('warn', `${r.duplicates} scan(s) from this phone were already counted.`)
      await refreshOffline()
      await refreshSession()
    } finally { setSyncing(false) }
  }, [refreshOffline, refreshSession, say])

  const online = useOnline(() => { void (session ? handleSync() : loadBoot().then(handleSync)) })

  // Opening the screen.
  useEffect(() => {
    stocktakeRef.current = readNumber(STOCKTAKE_KEY)
    const a = readText(AREA_KEY)
    areaRef.current = a; setAreaState(a)
    void refreshOffline()
    if (!navigator.onLine) { setLoading(false); return }
    void loadBoot().then(() => handleSync())
  }, [])

  // Back to this screen (phone unlocked, tab switched): fresh totals, one request.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshSession() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refreshSession])

  // Other phones' scans in the total: every 30 s while this phone is scanning (scanned in the last
  // 5 minutes) and the screen is visible. A phone left open but idle sends nothing, so Neon can sleep.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return
      if (Date.now() - lastActivityRef.current > LIVE_WHILE_ACTIVE_MS) return
      void refreshSession()
    }, LIVE_EVERY_MS)
    return () => clearInterval(t)
  }, [refreshSession])

  // Opening the scanner with no internet: the app's worker serves its saved copy of this page, but it
  // saves one only on a full page load, not when the page was reached from the menu. Save it here,
  // at most once a day per phone (a redirect, e.g. signed out, is never saved).
  useEffect(() => {
    if (!navigator.onLine || !('caches' in window)) return
    const last = Number(readText(PAGE_SAVED_KEY) ?? 0)
    if (Date.now() - last < 24 * 3600_000) return
    void (async () => {
      try {
        const res = await fetch('/scanner', { credentials: 'same-origin', headers: { Accept: 'text/html' } })
        if (!res.ok || res.redirected) return
        await (await caches.open(PAGES_CACHE)).put('/scanner', res)
        write(PAGE_SAVED_KEY, Date.now())
      } catch { /* try again next time */ }
    })()
  }, [])

  // ── Scanning ────────────────────────────────────────────────────────────

  /**
   * One scan → one request. No answer within SCAN_TIMEOUT_MS (Wi-Fi without internet, very slow
   * network) → 'offline': the scan is kept on the phone and sent again later. Safe even if the slow
   * request did reach the server: the same clientEventId never adds the pair twice.
   */
  async function postScan(raw: string, id: string, extra: { saveUnknown?: boolean } = {}): Promise<(ScanReply & { sessionId?: number | null }) | 'offline'> {
    lastActivityRef.current = Date.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), SCAN_TIMEOUT_MS)
    try {
      const res = await fetch('/api/scanner/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ raw, clientEventId: id, sessionId: stocktakeRef.current, flag: areaRef.current, deviceAt: new Date().toISOString(), ...extra }),
      })
      if (res.status >= 500) return 'offline'
      const reply = (await res.json()) as ScanReply & { sessionId?: number | null }
      followStocktake(reply.sessionId)
      return reply
    } catch { return 'offline' } finally { clearTimeout(timer) }
  }

  async function keepOnPhone(raw: string, id: string, p: ParsedQr) {
    await enqueue({
      tempId: id, entryType: 'scan', rawQrCode: raw, artNumber: p.articleCode, colorNumber: p.colorCode, sizeNumber: p.size,
      mrp: p.mrp || undefined, mfgMonth: p.mfgMonth || undefined, mfgYear: p.mfgYear || undefined, quantity: 1,
      flag: areaRef.current ?? undefined, sessionId: stocktakeRef.current ?? undefined, scannedByName: user?.name ?? '', savedAt: Date.now(), status: 'pending',
    })
    void refreshOffline()
    patchEntry(id, { state: 'offline', detail: 'No internet — kept on this phone, sent when online.' })
    addTotals({ boxes: 1, pairs: 1 })
    playScanOk()
  }

  function handleReply(raw: string, id: string, p: ParsedQr, r: ScanReply) {
    switch (r.kind) {
      case 'saved': {
        const e = entryFromItem(r.item)
        patchEntry(id, { ...e, key: id })
        if (!r.replay) addTotals({ boxes: 1, pairs: 1, missing: r.item.resolution === 'resolved' ? 0 : 1 })
        if (r.item.resolution === 'resolved') playScanOk(); else playNewArticle()
        return
      }
      case 'duplicate':
        patchEntry(id, { state: 'duplicate', detail: `Already scanned by ${r.scannedByName}${r.scannedAt ? ` at ${timeIST(r.scannedAt)}` : ''}.` })
        playAlreadyScanned()
        return
      case 'rejected':
        seenRef.current.delete(p.identity)
        patchEntry(id, { state: 'error', detail: r.message })
        playAlreadyScanned()
        return
      case 'unknown':
        patchEntry(id, { state: 'asking', detail: r.mode === 'new_colour' ? `New colour of ${r.existingName ?? 'a known article'} — fill in the details.` : 'New article — fill in the details.' })
        setNewArticle({ raw, id, parsed: p, mode: r.mode, existingName: r.existingName })
        playNewArticle()
        return
      case 'carton':
        setFeed((f) => f.filter((e) => e.key !== id))
        takeCartonCheck(raw, r.check)
        return
    }
  }

  /** Any label, any order: a pair's box QR counts at once; a carton QR asks sealed or open. */
  async function handleCode(rawIn: string) {
    const raw = rawIn.trim()
    if (!raw) return
    if (isCartonQr(raw)) { void handleCarton(raw); return }
    if (!isValidWarehouseQr(raw)) { say('err', 'This QR code is not a box or carton label.'); playAlreadyScanned(); return }
    const p = parseQr(raw)
    if (p.identity && seenRef.current.has(p.identity)) {
      say('warn', `${p.articleCode} ${p.colorCode} size ${p.size} is already in your list — not counted again.`)
      playAlreadyScanned()
      return
    }
    const id = crypto.randomUUID()
    if (p.identity) seenRef.current.set(p.identity, id)
    pushEntry({ key: id, state: 'saving', title: feedTitle({ type: 'box', articleCode: p.articleCode, colourCode: p.colorCode, size: p.size }), detail: '', at: Date.now() })
    if (!navigator.onLine) { await keepOnPhone(raw, id, p); return }
    const r = await postScan(raw, id)
    if (r === 'offline') { await keepOnPhone(raw, id, p); return }
    handleReply(raw, id, p, r)
  }

  // New-article dialog (admin): linked → the scan was saved with it; closed → saved as a missing article.
  async function saveNewArticleLater(): Promise<boolean> {
    const n = newArticle
    if (!n) return true
    const r = await postScan(n.raw, n.id, { saveUnknown: true })
    setNewArticle(null)
    if (r === 'offline') { await keepOnPhone(n.raw, n.id, n.parsed); return true }
    handleReply(n.raw, n.id, n.parsed, r)
    return r.kind !== 'rejected'
  }
  async function newArticleLinked() {
    setNewArticle(null)
    addTotals({ boxes: 1, pairs: 1 })
    playScanOk()
    say('ok', 'Article saved and the box counted.')
    await refreshSession()
  }

  // ── Cartons: sealed → counted from its pairs per size; open → its pairs are scanned ──

  function takeCartonCheck(raw: string, out: Extract<ScanReply, { kind: 'carton' }>['check']) {
    if (out.status === 'confirm') {
      setCartons((q) => (q.some((x) => x.raw === raw) ? q : [...q, { id: crypto.randomUUID(), raw, ask: out }]))
      playScanOk()
      return
    }
    cartonKeysRef.current.delete(raw)
    say(out.status === 'duplicate' ? 'warn' : 'err', out.status === 'duplicate' ? `${out.label}: ${out.message}` : out.message)
    playAlreadyScanned()
  }

  async function handleCarton(raw: string) {
    if (!navigator.onLine) { say('err', 'A carton label needs internet. Scan it again when you are online — or, if the carton is open, scan its pairs.'); playAlreadyScanned(); return }
    if (cartonKeysRef.current.has(raw)) return // camera re-reads the label while it waits
    cartonKeysRef.current.add(raw)
    const r = await postScan(raw, crypto.randomUUID())
    if (r === 'offline') { cartonKeysRef.current.delete(raw); say('err', 'The carton could not be checked. Scan it again.'); return }
    if (r.kind === 'carton') takeCartonCheck(raw, r.check)
    else { cartonKeysRef.current.delete(raw); say('err', r.kind === 'rejected' ? r.message : 'Not a carton label.') }
  }

  /** "Open — I'll scan its pairs": nothing is saved for the carton. */
  function openCarton() {
    const c = cartons[0]
    if (c) cartonKeysRef.current.delete(c.raw)
    setCartons((q) => q.slice(1))
    setCartonError('')
    if (c) say('ok', `Open carton ${c.ask.label}: scan each pair inside it.`)
  }

  async function countCarton(answer: AssortmentAnswer) {
    const c = cartons[0]
    if (!c || cartonBusy) return
    lastActivityRef.current = Date.now()
    setCartonBusy(true); setCartonError('')
    try {
      const out = await countStocktakeCartonAction({ rawInput: c.raw, clientEventId: c.id, sessionId: stocktakeRef.current, flag: areaRef.current, answer })
      followStocktake(out.sessionId)
      if (out.status === 'rejected') { setCartonError(out.message); playAlreadyScanned(); return }
      if (out.status === 'duplicate') { say('warn', `${out.label}: ${out.message}`); playAlreadyScanned() }
      else {
        const item: FeedItem = {
          key: `carton:${out.receiptId}`, id: out.receiptId, eventId: c.id, type: 'carton', articleCode: c.ask.articleCode, colourCode: c.ask.colourCode,
          size: c.ask.sizes.length > 1 ? `${c.ask.sizes[0]}–${c.ask.sizes[c.ask.sizes.length - 1]}` : c.ask.sizes[0], articleName: c.ask.articleName, colourName: null,
          pairs: out.pairs, mrp: c.ask.mrp != null ? c.ask.mrp.toFixed(2) : null, resolution: 'resolved', userName: user?.name ?? '', at: new Date().toISOString(),
          detail: formatSizes(out.sizes),
        }
        pushEntry(entryFromItem(item))
        if (!out.replay) addTotals({ cartons: 1, cartonPairs: out.pairs, pairs: out.pairs })
        playScanOk()
      }
      cartonKeysRef.current.delete(c.raw)
      setCartons((q) => q.slice(1))
    } catch { setCartonError('Not saved — check the internet and try again.') } finally { setCartonBusy(false) }
  }

  // A carton label waiting for "sealed or open?" is not counted yet: warn before leaving.
  useEffect(() => {
    if (!cartons.length) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [cartons.length])

  // ── Inputs: camera, scanner machine, photo ──────────────────────────────

  const { videoRef, active: camActive, error: camError, start: startCamera, stop: stopCamera, torch, torchSupported, setTorch } =
    useQrScanner(handleCode, { hardware: false, paused: () => modalOpenRef.current })
  const scanRef = useRef<HTMLInputElement>(null)
  const [scanValue, setScanValue] = useState('')
  const [scanFocused, setScanFocused] = useState(false)
  useScanForwarder(scanRef, (ch) => setScanValue((v) => v + ch))
  useEffect(() => { if (!isTouch()) setTimeout(() => scanRef.current?.focus({ preventScroll: true }), 30) }, [])
  function submitScanBox() { const code = scanValue.trim(); setScanValue(''); if (code) void handleCode(code) }
  const photoRef = useRef<HTMLInputElement>(null)
  async function onPhoto(file: File | undefined) {
    if (photoRef.current) photoRef.current.value = ''
    if (!file) return
    try {
      const code = await decodeQrImage(file)
      if (code) void handleCode(code); else say('err', 'No QR code found in the photo. Try a sharper, closer photo.')
    } catch { say('err', 'This file could not be read as a photo.') }
  }

  // ── Manual entry (a pair whose label cannot be read) ────────────────────

  async function saveManual(v: ManualValues): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    lastActivityRef.current = Date.now()
    const id = crypto.randomUUID()
    const title = feedTitle({ type: 'manual', articleCode: v.art, colourCode: v.colour, size: v.size })
    if (!navigator.onLine) {
      await enqueue({
        tempId: id, entryType: 'manual', artNumber: v.art, colorNumber: v.colour, sizeNumber: v.size, quantity: v.qty, mrp: v.mrp ?? undefined,
        mfgMonth: v.mfgMonth ?? undefined, mfgYear: v.mfgYear ?? undefined, notes: v.notes || undefined, flag: areaRef.current ?? undefined,
        sessionId: stocktakeRef.current ?? undefined, scannedByName: user?.name ?? '', savedAt: Date.now(), status: 'pending',
      })
      void refreshOffline()
      pushEntry({ key: id, state: 'offline', title, detail: `${v.qty} pair(s) typed by hand — sent when online.`, at: Date.now() })
      addTotals({ manualPairs: v.qty, pairs: v.qty })
      return { ok: true, message: `Kept on this phone: ${title} · ${v.qty} pair(s).` }
    }
    try {
      const r = await addManualEntry({
        clientEventId: id, artNumber: v.art, colorNumber: v.colour, sizeNumber: v.size, quantity: v.qty, notes: v.notes || null,
        mrp: v.mrp, mfgMonth: v.mfgMonth, mfgYear: v.mfgYear, sessionId: stocktakeRef.current, flag: areaRef.current,
      })
      if (!r.ok) return { ok: false, message: r.message }
      followStocktake(r.sessionId)
      const d = r.data
      pushEntry(entryFromItem({
        key: `scan:${d.id}`, id: d.id, eventId: id, type: 'manual', articleCode: d.artNumber, colourCode: d.colorNumber, size: d.sizeNumber,
        articleName: d.masterArtName === '—' ? null : d.masterArtName, colourName: d.masterColorName === '—' ? null : d.masterColorName,
        pairs: d.quantity, mrp: d.mrp, resolution: d.resolution, userName: d.scannedByName, at: new Date(d.scannedAt).toISOString(), detail: null,
      }))
      if (!r.replay) addTotals({ manualPairs: d.quantity, pairs: d.quantity, missing: d.resolution === 'resolved' ? 0 : 1 })
      playScanOk()
      return { ok: true, message: `Added: ${title} · ${d.quantity} pair(s).${d.resolution === 'resolved' ? '' : ' Not in the article master yet — an admin will link it.'}` }
    } catch { return { ok: false, message: 'Not saved — check the internet and try again.' } }
  }

  // ── Undo ────────────────────────────────────────────────────────────────

  async function doUndo() {
    const u = undo
    if (!u) return
    setUndoBusy(true); setUndoError('')
    try {
      const reason = undoReason.trim()
      const r = u.type === 'carton' ? await undoStocktakeCartonAction(u.id, reason) : await deleteScan(u.id, { reason })
      if (!r.ok) { setUndoError(r.message); return }
      setFeed((f) => f.filter((e) => e.key !== u.eventId))
      for (const [k, v] of seenRef.current) if (v === u.eventId) seenRef.current.delete(k)
      addTotals(u.type === 'carton' ? { cartons: -1, cartonPairs: -u.pairs, pairs: -u.pairs }
        : u.type === 'manual' ? { manualPairs: -u.pairs, pairs: -u.pairs, missing: u.resolution === 'resolved' ? 0 : -1 }
        : { boxes: -1, pairs: -1, missing: u.resolution === 'resolved' ? 0 : -1 })
      say('ok', `Undone: ${feedTitle(u)}.`)
      setUndo(null); setUndoReason('')
    } catch { setUndoError('Not undone — check the internet and try again.') } finally { setUndoBusy(false) }
  }

  const pending = offlineQueue.filter((e) => e.status === 'pending' || e.status === 'syncing').length
  const totals = session?.totals ?? EMPTY_TOTALS
  const canFinish = Boolean(user?.canVoidAny)
  const flashCls = { ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300', warn: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200', err: 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-300' }

  return (
    // Bottom room on phones: the menu bar (4rem) must never cover the last buttons.
    <main className="min-h-screen bg-background p-3 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:p-4 sm:pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:p-6">
      <div className="mx-auto max-w-3xl space-y-3">
        <header className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Warehouse Scanner</h1>
            {!online && <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300"><WifiOff className="h-3 w-3" />Offline</span>}
          </div>
          <PageNav />
        </header>

        {flash && <div role="status" className={`rounded-xl border px-3 py-2.5 text-sm font-medium ${flashCls[flash.tone]}`}>{flash.text}</div>}
        {loadError && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-800 dark:text-red-300">
            {loadError}
            <button type="button" onClick={() => loadBoot()} className="shrink-0 rounded-lg border border-current px-2 py-1 text-xs font-semibold">Try again</button>
          </div>
        )}

        {/* The godown stocktake: total, optional area, finish */}
        <section className="rounded-2xl border border-sky-500/40 bg-sky-500/5 p-3" aria-label="Godown stocktake">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">Godown stocktake</p>
              <p className="text-[11px] text-muted-foreground">
                {session ? `Since ${dayTimeIST(session.startedAt)}${totals.people > 1 ? ` · ${totals.people} people scanning` : ''}` : loading ? 'Loading…' : online ? 'Not started — your first scan starts it.' : 'Offline — scans are kept on this phone.'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-3xl font-bold leading-none">{totals.pairs}</p>
              <p className="text-[11px] text-muted-foreground">pairs</p>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {`${totals.boxes} pairs scanned · ${totals.cartons} sealed cartons (${totals.cartonPairs} pairs) · ${totals.manualPairs} by hand`}
            {totals.missing > 0 && <span className="text-amber-700 dark:text-amber-400">{` · ${totals.missing} not in master`}</span>}
            {pending > 0 && <span className="text-amber-700 dark:text-amber-400">{` · ${pending} waiting on this phone`}</span>}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => setSheet('area')} className="inline-flex h-9 max-w-[60%] items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-muted">
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate" data-no-translate={area ? true : undefined}>{area ? area : 'Area: none'}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            </button>
            {canFinish && (
              <button type="button" onClick={() => session && setFinishing(session)} disabled={!session || !online} className="h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-muted disabled:opacity-50">Finish stocktake</button>
            )}
            <button type="button" onClick={() => refreshSession()} disabled={!online || !session} aria-label="Refresh totals" className="ml-auto h-9 rounded-lg border border-border px-2.5 hover:bg-muted disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </section>

        {/* Scanner machine (USB / Bluetooth): it types the code and presses Enter. */}
        <form onSubmit={(e) => { e.preventDefault(); submitScanBox() }}>
          <label htmlFor="warehouse-scan" className="sr-only">Scan a pair or a carton</label>
          <div className={`flex h-14 items-center gap-2.5 rounded-xl border-2 bg-background px-3 transition-colors ${scanFocused ? 'border-primary' : 'border-border'}`}>
            <button type="button" onClick={() => scanRef.current?.focus()} aria-label={scanFocused ? 'Scanner ready' : 'Tap here to scan'}
              className={`h-3 w-3 shrink-0 rounded-full ${scanFocused ? 'bg-emerald-500 shadow-[0_0_0_4px_rgb(16_185_129/0.2)]' : 'bg-amber-500'}`} />
            <input ref={scanRef} id="warehouse-scan" value={scanValue} onChange={(e) => setScanValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Tab' && scanValue.trim()) { e.preventDefault(); submitScanBox() } }}
              onFocus={() => setScanFocused(true)} onBlur={() => setScanFocused(false)}
              autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="done"
              placeholder={scanFocused ? 'Ready — scan a pair or a carton' : 'Tap here, then scan'}
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-sm focus:outline-none" />
          </div>
        </form>

        <div className="flex gap-2">
          <button type="button" onClick={camActive ? stopCamera : startCamera} className={`${camActive ? secondaryBtn : primaryBtn} h-12 flex-1 text-base`}>
            {camActive ? <><CameraOff className="h-5 w-5" /> Stop camera</> : <><Camera className="h-5 w-5" /> Scan with camera</>}
          </button>
          {camActive && torchSupported && (
            <button type="button" onClick={() => setTorch(!torch)} aria-pressed={torch} aria-label="Torch"
              className={`h-12 rounded-lg border px-3 ${torch ? 'border-amber-400 bg-amber-400/20 text-amber-600 dark:text-amber-300' : 'border-border hover:bg-muted'}`}>
              <Flashlight className="h-5 w-5" />
            </button>
          )}
        </div>
        {camError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{camError}</p>}
        <div className={`relative overflow-hidden rounded-xl border border-border bg-black ${camActive ? '' : 'hidden'}`}>
          <video ref={videoRef} playsInline muted className="max-h-[42vh] w-full object-cover" />
          <div className="pointer-events-none absolute inset-6 rounded-xl border-2 border-white/40" />
        </div>
        <p className="text-[11px] text-muted-foreground">Loose pairs and pairs in open cartons: scan each pair. Sealed cartons: scan the carton label.</p>

        {cartons[0] && (
          <StocktakeCartonCard key={cartons[0].id} ask={cartons[0].ask} waiting={cartons.length - 1} busy={cartonBusy} error={cartonError}
            onCount={countCarton} onCancel={openCarton} />
        )}

        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => setSheet('manual')} className={`${secondaryBtn} flex-col gap-0.5 px-2 text-xs`}><Keyboard className="h-4 w-4" />By hand</button>
          <button type="button" onClick={() => setSheet('counts')} disabled={!online} className={`${secondaryBtn} flex-col gap-0.5 px-2 text-xs`}><ListChecks className="h-4 w-4" />Stocktakes</button>
          <button type="button" onClick={() => setSheet('more')} className={`${secondaryBtn} relative flex-col gap-0.5 px-2 text-xs`}>
            <MoreHorizontal className="h-4 w-4" />More
            {offlineQueue.length > 0 && <span className="absolute right-2 top-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">{offlineQueue.length}</span>}
          </button>
        </div>

        <ScanFeed entries={feed} onUndo={(i) => { setUndo(i); setUndoReason(''); setUndoError('') }} />
      </div>

      <input ref={photoRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0])} />

      {sheet === 'area' && (
        <Sheet title="Area (optional)" onClose={() => setSheet(null)}>
          <p className="mb-2 text-xs text-muted-foreground">Not needed. Choose one only to note where you are scanning; your next scans are tagged with it.</p>
          <div className="grid gap-2">
            <button type="button" onClick={() => { setArea(null); setSheet(null) }} className={`${secondaryBtn} justify-start ${area == null ? 'border-foreground' : ''}`}>No area</button>
            {racks.map((r) => (
              <button key={r.id} type="button" onClick={() => { setArea(r.name); setSheet(null) }} className={`${secondaryBtn} justify-start ${area === r.name ? 'border-foreground' : ''}`}>
                <MapPin className="h-4 w-4" /><span data-no-translate>{r.name}</span>
              </button>
            ))}
            {user?.canManageRacks && <button type="button" onClick={() => setSheet('racks')} className={`${secondaryBtn} justify-start`}><Settings2 className="h-4 w-4" />Manage areas</button>}
          </div>
        </Sheet>
      )}
      {sheet === 'manual' && <ManualEntryDialog rackName={area ?? 'the godown stocktake'} onSave={saveManual} onClose={() => setSheet(null)} />}
      {sheet === 'counts' && user && (
        <CountsDialog currentId={session?.id ?? null} canFinishAny={user.canVoidAny} onClose={() => setSheet(null)}
          onFinish={(s) => { setSheet(null); setFinishing(s) }} />
      )}
      {sheet === 'racks' && <RackManager onClose={() => setSheet(null)} onChanged={() => { void loadBoot() }} />}
      {sheet === 'more' && (
        <Sheet title="More" onClose={() => setSheet(null)}>
          <div className="grid gap-2">
            <button type="button" onClick={() => { setSheet(null); photoRef.current?.click() }} className={`${secondaryBtn} justify-start`}><ImageUp className="h-4 w-4" />Scan from a photo</button>
            <button type="button" onClick={() => setSheet('offline')} className={`${secondaryBtn} justify-start`}>
              <WifiOff className="h-4 w-4" />{`Waiting on this phone (${offlineQueue.length})`}
            </button>
            {user?.canManageRacks && <button type="button" onClick={() => setSheet('racks')} className={`${secondaryBtn} justify-start`}><Settings2 className="h-4 w-4" />Manage areas</button>}
            <Link href="/dashboard" className={`${secondaryBtn} justify-start`}><BarChart3 className="h-4 w-4" />Reports</Link>
          </div>
        </Sheet>
      )}
      {sheet === 'offline' && (
        <Sheet title="Waiting on this phone" onClose={() => setSheet(null)}>
          <p className="mb-2 text-xs text-muted-foreground">Scans saved without internet. They are sent by themselves when the internet is back.</p>
          {offlineQueue.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Nothing waiting.</p> : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {offlineQueue.map((e) => (
                <li key={e.tempId} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono font-semibold" data-no-translate>{`${e.artNumber} ${e.colorNumber} · ${e.sizeNumber}`}{e.quantity > 1 ? ` ×${e.quantity}` : ''}</span>
                    <span className="block text-xs text-muted-foreground">{e.status === 'error' ? (e.errorMessage ?? 'Already counted') : [e.flag, timeIST(new Date(e.savedAt).toISOString())].filter(Boolean).join(' · ')}</span>
                  </span>
                  {e.status === 'error' && <button type="button" onClick={async () => { await removeFromQueue(e.tempId); void refreshOffline() }} className="rounded-md px-2 py-1 text-xs font-semibold hover:bg-muted">Remove</button>}
                </li>
              ))}
            </ul>
          )}
          {pending > 0 && online && <button type="button" onClick={() => handleSync()} disabled={syncing} className={`${primaryBtn} mt-3 w-full`}>{syncing ? 'Sending…' : 'Send now'}</button>}
        </Sheet>
      )}
      {finishing && (
        <FinishCount session={finishing} canFinish={canFinish} onClose={() => setFinishing(null)}
          onFinished={(s) => {
            setFinishing(null)
            say('ok', `Stocktake finished: ${s.totals.pairs} pairs.`)
            if (stocktakeRef.current === s.id) clearSession()
          }} />
      )}
      {undo && (
        <Sheet title="Undo this scan?" onClose={() => setUndo(null)}>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono font-semibold text-foreground" data-no-translate>{feedTitle(undo)}</span>
            {` — ${undo.pairs} pair(s) come out of stock. It stays in the history, marked as undone.`}
            {undo.type === 'carton' && ' Not possible once boxes from it were scanned or sold.'}
          </p>
          <label className="mt-3 block text-xs font-medium">Reason
            <input value={undoReason} onChange={(e) => setUndoReason(e.target.value)} placeholder="e.g. scanned the wrong box" className={`${fieldCls} mt-1`} disabled={undoBusy} autoComplete="off" />
          </label>
          {undoError && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{undoError}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" data-primary data-destructive onClick={doUndo} disabled={undoBusy || undoReason.trim().length < 3}
              className="inline-flex h-11 flex-1 items-center justify-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
              {undoBusy ? 'Undoing…' : 'Undo'}
            </button>
            <button type="button" data-autofocus onClick={() => setUndo(null)} className={secondaryBtn}>Cancel</button>
          </div>
        </Sheet>
      )}
      {newArticle && (
        <NewArticleDialog rawQr={newArticle.raw} parsed={newArticle.parsed} mode={newArticle.mode} existingName={newArticle.existingName}
          flag={area ?? undefined} sessionId={session?.id ?? null} clientEventId={newArticle.id}
          onClose={() => { void saveNewArticleLater() }} onSaveLater={saveNewArticleLater} onLinked={newArticleLinked} />
      )}
    </main>
  )
}
