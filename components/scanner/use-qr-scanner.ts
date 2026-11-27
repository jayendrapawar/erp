'use client'

import jsQR from 'jsqr'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SCAN_INTERVAL_MS, SCAN_MAX_DIM } from './constants'

// The phone's own QR reader (Chrome on Android, Safari 17+ where enabled): much faster than jsQR
// and off the main thread. Missing or failing → jsQR on a small canvas, as before.
type Detector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> }
let nativeDetector: Promise<Detector | null> | null = null
function getNativeDetector(): Promise<Detector | null> {
  if (nativeDetector) return nativeDetector
  nativeDetector = (async () => {
    const BD = (globalThis as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector
    if (!BD) return null
    try {
      const formats = await BD.getSupportedFormats?.()
      if (formats && !formats.includes('qr_code')) return null
      return new BD({ formats: ['qr_code'] })
    } catch { return null }
  })()
  return nativeDetector
}

/** Read a QR code from a photo (Upload QR photo). Null when none is found. */
export async function decodeQrImage(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const det = await getNativeDetector()
    if (det) {
      try { const r = await det.detect(bitmap); if (r[0]?.rawValue) return r[0].rawValue } catch { /* fall back */ }
    }
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bitmap.width * scale); c.height = Math.round(bitmap.height * scale)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, c.width, c.height)
    return jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height)?.data ?? null
  } finally { bitmap.close() }
}

/**
 * QR input for a screen: the phone camera and USB / Bluetooth scanners that type the code
 * followed by Enter. The same code read again within `repeatMs` is ignored (camera re-reads).
 * `paused()` → the camera keeps running but nothing is decoded (a dialog or card is open).
 */
export function useQrScanner(onCode: (raw: string) => void, opts: { repeatMs?: number; hardware?: boolean; paused?: () => boolean } = {}) {
  const repeatMs = opts.repeatMs ?? 2500
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const runningRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastRef = useRef<{ raw: string; at: number }>({ raw: '', at: 0 })
  const onCodeRef = useRef(onCode)
  const pausedRef = useRef(opts.paused)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [torch, setTorchState] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)

  useEffect(() => { onCodeRef.current = onCode; pausedRef.current = opts.paused }, [onCode, opts.paused])

  const emit = useCallback((raw: string) => {
    const now = Date.now()
    if (raw === lastRef.current.raw && now - lastRef.current.at < repeatMs) return
    lastRef.current = { raw, at: now }
    onCodeRef.current(raw)
  }, [repeatMs])

  const stop = useCallback(() => {
    runningRef.current = false
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setActive(false)
    setTorchState(false)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      const video = videoRef.current
      if (!video) { stream.getTracks().forEach((t) => t.stop()); return }
      video.srcObject = stream
      streamRef.current = stream
      runningRef.current = true
      setActive(true)
      try {
        const caps = stream.getVideoTracks()[0]?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined
        setTorchSupported(Boolean(caps?.torch))
      } catch { setTorchSupported(false) }
      await video.play().catch(() => {})
      const det = await getNativeDetector()
      let last = 0
      let busy = false
      const loop = () => {
        if (!runningRef.current) return
        const now = performance.now()
        if (!busy && video.videoWidth && now - last >= SCAN_INTERVAL_MS && !pausedRef.current?.()) {
          last = now
          if (det) {
            busy = true
            det.detect(video).then((r) => { if (r[0]?.rawValue) emit(r[0].rawValue) }).catch(() => {}).finally(() => { busy = false })
          } else {
            const scale = Math.min(1, SCAN_MAX_DIM / Math.max(video.videoWidth, video.videoHeight))
            const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale)
            let c = canvasRef.current
            if (!c || c.width !== w || c.height !== h) { c = document.createElement('canvas'); c.width = w; c.height = h; canvasRef.current = c }
            const ctx = c.getContext('2d', { willReadFrequently: true })
            if (ctx) {
              ctx.drawImage(video, 0, 0, w, h)
              const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h)
              if (code?.data) emit(code.data)
            }
          }
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    } catch {
      setError('Camera permission denied or unavailable.')
      stop()
    }
  }, [emit, stop])

  /** Torch (flashlight) while the camera runs; false when the phone does not allow it. */
  const setTorch = useCallback(async (on: boolean): Promise<boolean> => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return false
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
      setTorchState(on)
      return true
    } catch { return false }
  }, [])

  // Hardware scanners: fast keys ending with Enter, outside form fields.
  useEffect(() => {
    if (opts.hardware === false) return
    let buf = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'Enter') { const raw = buf.trim(); buf = ''; if (raw) emit(raw); return }
      if (e.key.length !== 1) return
      buf += e.key
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { buf = '' }, 120)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); if (timer) clearTimeout(timer) }
  }, [emit, opts.hardware])

  useEffect(() => stop, [stop])

  return { videoRef, active, error, start, stop, torch, torchSupported, setTorch }
}
