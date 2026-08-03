import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '@renderer/state/context'
import { playSound, isQuietNow } from '@renderer/lib/audio'
import type { IdleMotion, MascotShell } from '@shared/types'
import './mascot.css'

const POS_KEY = 'mochi.mascot.pos'
/** A stored position under these is covering the rail or title bar — reject it. */
const RAIL_W = 252
const TITLEBAR_H = 92

interface Pos {
  x: number
  y: number
}

const MOTION_CLASS: Record<IdleMotion, string> = {
  breathe: 'mo-idle-breathe',
  float: 'mo-idle-float',
  sway: 'mo-idle-sway',
  still: ''
}

function readStoredPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Pos
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
    return p
  } catch {
    return null
  }
}

/**
 * The mascot overlay.
 *
 * Two deliberate departures from ordinary React practice, both from the brief:
 *
 *  1. Drag position is written straight to `transform` on the DOM node, one write
 *     per frame. Routing it through state would re-render the tree on every
 *     pointermove and make the drag feel like mud.
 *  2. The idle animation lives in a CSS class that is never changed by a
 *     re-render, so the loop doesn't restart and visibly jump.
 */
export function MascotLayer(): React.JSX.Element | null {
  const { settings, mascotState, mascotNote, burst, spriteSrc, fireSticker } = useStore()
  const cfg = settings.mascot

  const wrapRef = useRef<HTMLDivElement>(null)
  const spriteRef = useRef<HTMLDivElement>(null)
  const pos = useRef<Pos>({ x: 0, y: 0 })
  const dragging = useRef(false)
  const moved = useRef(false)
  const frame = useRef<number | null>(null)

  // The burst itself is the source of truth for what is showing; these only
  // record which burst has already been dismissed. Storing the *content* in
  // state instead would mean setting state synchronously inside the burst
  // effect, which cascades an extra render on every sticker.
  const [dismissed, setDismissed] = useState({ bubble: -1, overlay: -1, label: -1 })

  const showBubble = burst && burst.modes.includes('bubble') && dismissed.bubble !== burst.id
  const showOverlay = burst && burst.modes.includes('overlay') && dismissed.overlay !== burst.id
  const showLabel = burst && dismissed.label !== burst.id

  const write = useCallback(() => {
    frame.current = null
    const el = wrapRef.current
    if (el) el.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0)`
  }, [])

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(write)
  }, [write])

  const clamp = useCallback((p: Pos): Pos => {
    const el = wrapRef.current
    const w = el?.offsetWidth ?? 140
    const h = el?.offsetHeight ?? 180
    return {
      x: Math.min(Math.max(p.x, 8), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(p.y, TITLEBAR_H), Math.max(TITLEBAR_H, window.innerHeight - h - 8))
    }
  }, [])

  // Initial placement. A stored position that would cover the rail or the title
  // bar is rejected outright rather than clamped — clamping it would park the
  // mascot flush against the rail edge, which is exactly what we're avoiding.
  useEffect(() => {
    const stored = cfg.rememberPosition ? readStoredPos() : null
    const usable = stored && !(stored.x < RAIL_W || stored.y < TITLEBAR_H) ? stored : null
    const el = wrapRef.current
    const w = el?.offsetWidth ?? 140
    const h = el?.offsetHeight ?? 180
    pos.current = usable ?? {
      x: window.innerWidth - w - 34,
      y: window.innerHeight - h - 30
    }
    pos.current = clamp(pos.current)
    write()
    // Placement runs once; re-running on resize would yank the mascot around
    // while the user is dragging the window edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!cfg.dragAnywhere && e.target !== spriteRef.current) return
      dragging.current = true
      moved.current = false
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      const start = { x: e.clientX, y: e.clientY }
      const origin = { ...pos.current }

      const move = (ev: PointerEvent): void => {
        if (!dragging.current) return
        const dx = ev.clientX - start.x
        const dy = ev.clientY - start.y
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true
        pos.current = { x: origin.x + dx, y: origin.y + dy }
        schedule()
      }

      const up = (): void => {
        dragging.current = false
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        pos.current = clamp(pos.current)
        write()
        if (cfg.rememberPosition) localStorage.setItem(POS_KEY, JSON.stringify(pos.current))
        if (cfg.bounceOnDrop && moved.current) {
          const el = wrapRef.current
          if (el) {
            el.style.animation = 'mo-settle 420ms cubic-bezier(.2,1.4,.4,1)'
            setTimeout(() => el && (el.style.animation = ''), 440)
          }
        }
        // A click without movement fires a sticker.
        if (!moved.current) fireSticker()
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [cfg.dragAnywhere, cfg.bounceOnDrop, cfg.rememberPosition, clamp, schedule, write, fireSticker]
  )

  // A sticker burst: sound, squash-and-stretch, state label, and the configured
  // render targets — all from one event so they always land together.
  useEffect(() => {
    if (!burst) return
    const quiet = settings.quietHours.enabled
      ? isQuietNow(settings.quietHours.from, settings.quietHours.to)
      : false

    void playSound(burst.soundSrc, { enabled: settings.sound, quiet })

    const el = spriteRef.current
    if (el) {
      el.style.animation = 'none'
      // Force a reflow so the same animation can be restarted back-to-back.
      void el.offsetWidth
      el.style.animation = 'mo-squash 720ms cubic-bezier(.3,1.3,.4,1)'
    }

    // Each target clears on its own clock. Nothing is set synchronously here —
    // the burst is already visible by virtue of existing.
    const id = burst.id
    const timers = [
      setTimeout(() => setDismissed((d) => ({ ...d, label: id })), 2600),
      setTimeout(() => setDismissed((d) => ({ ...d, bubble: id })), 2600),
      setTimeout(() => setDismissed((d) => ({ ...d, overlay: id })), 1500)
    ]

    if (document.hidden || !document.hasFocus()) {
      void window.mochi?.notify('Mochi', burst.caption)
    }

    return () => timers.forEach(clearTimeout)
  }, [burst, settings.sound, settings.quietHours])

  if (!cfg.visible) return null

  const src = spriteSrc(mascotState)
  const stateLine = showLabel ? 'sent a sticker' : `${mascotState} · ${mascotNote}`

  return (
    <>
      {showOverlay && burst && (
        <div className="mo-overlay" aria-hidden>
          <div className="mo-overlay-scrim" />
          <div className="mo-overlay-card">
            {burst.stickerSrc ? (
              <img src={burst.stickerSrc} alt="" draggable={false} />
            ) : (
              <span className="mo-placeholder">art?</span>
            )}
            <span className="mo-overlay-caption">{burst.caption}</span>
          </div>
        </div>
      )}

      <div
        ref={wrapRef}
        className="mo-wrap"
        style={{ opacity: cfg.opacity }}
        onPointerDown={onPointerDown}
        role="button"
        tabIndex={0}
        aria-label={`Mascot — ${stateLine}. Click to send a sticker.`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            fireSticker()
          }
        }}
      >
        {showBubble && burst && <div className="mo-bubble">{burst.caption}</div>}

        <div className="mo-shell" data-shell={cfg.shell satisfies MascotShell}>
          <div
            ref={spriteRef}
            className={`mo-sprite ${MOTION_CLASS[cfg.idleMotion]}`}
            style={{ width: cfg.size, height: cfg.size }}
          >
            {src ? (
              <img src={src} alt="" draggable={false} />
            ) : (
              <span className="mo-placeholder">art?</span>
            )}
          </div>
          {cfg.shell === 'card' || cfg.shell === 'terrarium' ? (
            <div className="mo-name mono">{stateLine}</div>
          ) : null}
        </div>

        <div className={`mo-ground ${cfg.idleMotion === 'still' ? '' : 'mo-ground-anim'}`} />
      </div>
    </>
  )
}
