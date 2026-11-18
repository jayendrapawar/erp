'use client'

import jsQR from 'jsqr'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SCAN_INTERVAL_MS, SCAN_MAX_DIM } from './constants'

/**
 * QR input for a screen: the phone camera (jsQR) and USB / Bluetooth scanners that type the code
 * followed by Enter. The same code read again within `repeatMs` is ignored (camera re-reads).
 */
export function useQrScanner(onCode: (raw: string) => void, opts: { repeatMs?: number; hardware?: boolean } = {}) {
  const repeatMs = opts.repeatMs ?? 2500
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const runningRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastRef = useRef<{ raw: string; at: number }>({ raw: '', at: 0 })
  const onCodeRef = useRef(onCode)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { onCodeRef.current = onCode }, [onCode])

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
      await video.play().catch(() => {})
      let last = 0
      const loop = () => {
        if (!runningRef.current) return
        const now = performance.now()
        if (video.videoWidth && now - last >= SCAN_INTERVAL_MS) {
          last = now
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
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    } catch {
      setError('Camera permission denied or unavailable.')
      stop()
    }
  }, [emit, stop])

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

  return { videoRef, active, error, start, stop }
}
