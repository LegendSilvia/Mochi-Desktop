/**
 * Sound for the mascot layer.
 *
 * Two things matter here and both come straight from the brief:
 *  - the envelope stays gentle — "easy on the ears" is half the point of Mochi;
 *  - the AudioContext is recreated on `devicechange`, because unplugging
 *    headphones mid-session otherwise leaves a context bound to a dead device
 *    and every later sticker plays silently (M1-15).
 */

let ctx: AudioContext | null = null
const buffers = new Map<string, AudioBuffer>()

function context(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext()
    // Autoplay policy: a context created before any gesture starts suspended.
    const resume = (): void => {
      void ctx?.resume()
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('keydown', resume)
    }
    window.addEventListener('pointerdown', resume)
    window.addEventListener('keydown', resume)
  }
  return ctx
}

if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void ctx?.close()
    ctx = null
    buffers.clear()
  })
}

export interface PlayOptions {
  /** Global sound toggle. */
  enabled: boolean
  /** Quiet hours suppress sound but not the visual sticker. */
  quiet: boolean
  /** 0–1, applied on top of the gentle default. */
  volume?: number
}

/** Play a user file from the sounds folder. Falls back to the chime if missing. */
export async function playSound(src: string | null, opts: PlayOptions): Promise<void> {
  if (!opts.enabled || opts.quiet) return
  if (!src) return playChime(opts)

  try {
    const ac = context()
    await ac.resume()
    let buffer = buffers.get(src)
    if (!buffer) {
      const res = await fetch(src)
      buffer = await ac.decodeAudioData(await res.arrayBuffer())
      buffers.set(src, buffer)
    }
    const gain = ac.createGain()
    gain.gain.value = 0.35 * (opts.volume ?? 1)
    const node = ac.createBufferSource()
    node.buffer = buffer
    node.connect(gain).connect(ac.destination)
    node.start()
  } catch {
    // A missing or undecodable file should not break the sticker event.
    await playChime(opts)
  }
}

/**
 * The built-in three-note chime, used until the user drops their own sounds in.
 * Sines at 660/880/1174 Hz, staggered 0/90/180ms, gain ramped to 0.075 then
 * exponentially down over 700ms.
 */
export async function playChime(opts: PlayOptions): Promise<void> {
  if (!opts.enabled || opts.quiet) return
  const ac = context()
  await ac.resume()
  const now = ac.currentTime
  const notes: Array<[number, number]> = [
    [660, 0],
    [880, 0.09],
    [1174, 0.18]
  ]
  for (const [freq, delay] of notes) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    const t = now + delay
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(0.075 * (opts.volume ?? 1), t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.72)
    osc.connect(gain).connect(ac.destination)
    osc.start(t)
    osc.stop(t + 0.8)
  }
}

/** Read a sound file's duration for the Sounds list. */
export async function probeDuration(src: string): Promise<number> {
  try {
    const ac = context()
    const res = await fetch(src)
    const buf = await ac.decodeAudioData(await res.arrayBuffer())
    return Math.round(buf.duration * 10) / 10
  } catch {
    return 0
  }
}

/** "22:00"–"08:00" windows wrap midnight, so a plain `>=` comparison is wrong. */
export function isQuietNow(from: string, to: string, at = new Date()): boolean {
  const mins = (s: string): number => {
    const [h, m] = s.split(':').map(Number)
    return h * 60 + (m || 0)
  }
  const now = at.getHours() * 60 + at.getMinutes()
  const a = mins(from)
  const b = mins(to)
  return a <= b ? now >= a && now < b : now >= a || now < b
}
