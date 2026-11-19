// Scan feedback sounds, shared by every scanner screen.
//   OK:              one short high beep + short vibration.
//   Already scanned: two low buzzes + double vibration, so staff notice without looking.
// One AudioContext is reused for all scans (creating one per scan is slow on phones).

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    if (!ctx || ctx.state === 'closed') {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      ctx = new Ctor()
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

function tone(c: AudioContext, freq: number, at: number, dur: number, type: OscillatorType, volume: number) {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.connect(gain)
  gain.connect(c.destination)
  osc.type = type
  osc.frequency.setValueAtTime(freq, at)
  gain.gain.setValueAtTime(volume, at)
  gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
  osc.start(at)
  osc.stop(at + dur)
}

function vibrate(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern) } catch { /* not supported */ }
}

export function playScanOk() {
  const c = audio()
  if (c) tone(c, 1046, c.currentTime, 0.18, 'sine', 0.35)
  vibrate(80)
}

export function playAlreadyScanned() {
  const c = audio()
  if (c) {
    const t = c.currentTime
    tone(c, 330, t, 0.14, 'square', 0.25)
    tone(c, 247, t + 0.2, 0.22, 'square', 0.25)
  }
  vibrate([120, 80, 120])
}
