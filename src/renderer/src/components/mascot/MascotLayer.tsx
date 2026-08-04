import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '@renderer/state/context'
import { playSound, isQuietNow } from '@renderer/lib/audio'
import type {
  ApprovalRequest,
  IdleMotion,
  MascotPose,
  MascotShell,
  MascotState
} from '@shared/types'
import { MessageSquare, PanelsTopLeft, EyeOff, Hand } from 'lucide-react'
import { ApprovalBubble } from './ApprovalBubble'
import { MascotMenu, type MenuPlacement } from './MascotMenu'
import { BubbleMenu } from './BubbleMenu'
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

/** How long the click sprite is held before handing back to hover or lifecycle.
 *  Long enough to register as a reaction, short enough not to feel stuck. */
const CLICK_MS = 420

/** Movement below this in a frame reads as holding still, not walking. Without
 *  it the sprite flickers between two walk directions on the smallest jitter. */
const WALK_EPSILON = 2

/**
 * Which way the mascot is being dragged.
 *
 * Dominant axis wins, so a diagonal drag picks one of the four rather than
 * flickering between two. There is no autonomous walk yet, so the drag is the
 * only motion these four slots can describe today.
 */
function walkPose(dx: number, dy: number): MascotPose | null {
  if (Math.abs(dx) < WALK_EPSILON && Math.abs(dy) < WALK_EPSILON) return null
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'walk-left' : 'walk-right'
  return dy < 0 ? 'walk-up' : 'walk-down'
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
export function MascotLayer({ overlay = false }: { overlay?: boolean } = {}): React.JSX.Element | null {
  const {
    settings,
    mascotState,
    mascotNote,
    burst,
    spriteSrc,
    soundSrc,
    fireSticker,
    agents,
    server,
    dispatch
  } = useStore()
  const cfg = settings.mascot
  /** One mascot, one voice — the default agent's, same rule the lines follow. */
  const speaker = agents.find((a) => a.id === settings.defaultAgentId)?.name ?? 'Mochi'

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
  const [dismissed, setDismissed] = useState({ bubble: -1, overlay: -1, label: -1, toast: -1 })

  /*
   * Interaction poses.
   *
   * Kept as three small pieces rather than one pose value because they have
   * genuinely different lifetimes — a drag ends on pointerup, a click decays on
   * a timer, a hover ends when the pointer leaves — and folding them together
   * meant whichever ended last clobbered the others.
   *
   * They are React state, unlike the drag position, because the sprite's `src`
   * has to change and that is a render either way. Writes are guarded on an
   * actual change of direction, so a drag costs a handful of renders rather than
   * one per frame.
   */
  const [dragPose, setDragPose] = useState<MascotPose | null>(null)
  const [clicking, setClicking] = useState(false)
  const [hovering, setHovering] = useState(false)
  const clickTimer = useRef<number | null>(null)

  /** Being handled beats being busy: if the user has picked the mascot up, that
   *  is what it should be doing, whatever the agent is up to underneath. */
  const pose: MascotPose | null = dragPose ?? (clicking ? 'click' : hovering ? 'hover' : null)

  const flashClick = useCallback(() => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current)
    setClicking(true)
    clickTimer.current = window.setTimeout(() => {
      setClicking(false)
      clickTimer.current = null
    }, CLICK_MS)
  }, [])

  useEffect(
    () => () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current)
    },
    []
  )

  /*
   * A run stopped and is waiting on the user.
   *
   * Overlay only. In the app window the approval is already in the thread, and a
   * second copy floating over the mascot would ask the same question twice.
   * Cleared by main whenever it is answered anywhere, so deciding in the app
   * also takes it off the desktop.
   */
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const approvalRef = useRef<HTMLDivElement>(null)

  /*
   * Right-click opens the bubble menu; pop-up chat is one of its choices.
   *
   * The overlay is created `focusable: false` so clicking the mascot never
   * steals the caret from whatever you were typing in. That also means it cannot
   * receive key events, so focus is granted while the chat card is open and
   * given straight back when it closes. The bubble ring is click-only and needs
   * none, so it does not take focus at all.
   */
  const [bubblesOpen, setBubblesOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const bubblesRef = useRef<HTMLDivElement>(null)

  /* Kept out here so closing the card and opening it again does not lose a
   * half-written message or the session it was meant for. */
  const [draft, setDraft] = useState('')
  const [draftTarget, setDraftTarget] = useState<string | null>(null)

  useEffect(() => {
    if (!overlay) return
    void window.mochi?.mascotFocusable(menuOpen)
    // Deliberately no cleanup that revokes focus: the effect re-runs on every
    // toggle, so a cleanup would take the keyboard back a frame after granting
    // it. Closing the menu sets menuOpen false, which does the job.
  }, [overlay, menuOpen])

  /*
   * Which way the cards open.
   *
   * The overlay is exactly the work area, so anything drawn past its bounds is
   * cut off rather than scrolled to — which is how the chat card ended up half
   * off the top of the screen. Measured when something opens rather than on
   * every drag frame: the answer only matters at that moment.
   */
  const [placement, setPlacement] = useState<MenuPlacement>({
    vertical: 'above',
    horizontal: 'center'
  })
  const measure = useCallback((): void => {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPlacement({
      // 320 is roughly the chat card's height. Below the sprite only when there
      // genuinely is not room above it.
      vertical: r.top < 320 ? 'below' : 'above',
      horizontal: r.left < 160 ? 'left' : window.innerWidth - r.right < 160 ? 'right' : 'center'
    })
  }, [])

  /*
   * Clicking away closes, without discarding.
   *
   * `pointerdown` rather than `click`: a click that lands on the desktop is
   * delivered to whatever is under the overlay, so waiting for it would mean
   * waiting for one that never arrives.
   */
  useEffect(() => {
    if (!overlay || (!menuOpen && !bubblesOpen)) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (menuRef.current?.contains(t)) return
      if (bubblesRef.current?.contains(t)) return
      if (wrapRef.current?.contains(t)) return
      setMenuOpen(false)
      setBubblesOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [overlay, menuOpen, bubblesOpen])
  useEffect(() => {
    if (!overlay) return
    return window.mochi?.onApproval((next) => {
      // A settle names the request it answers, so a late clear for an older one
      // cannot wipe a newer card that has just arrived.
      if ('settled' in next) {
        setApproval((cur) => (cur && cur.id === next.id ? null : cur))
        return
      }
      setApproval(next)
    })
  }, [overlay])

  const showBubble = burst && burst.modes.includes('bubble') && dismissed.bubble !== burst.id
  const showOverlay = burst && burst.modes.includes('overlay') && dismissed.overlay !== burst.id
  const showLabel = burst && dismissed.label !== burst.id
  // Overlay only. In the app window the message is already in the thread, so a
  // toast on top of it would be the same news twice.
  // The toast is for news you might have missed. A poke is not news — you are
  // looking straight at the mascot — so those speak from the bubble only.
  const showToast =
    overlay &&
    burst &&
    burst.modes.includes('overlay') &&
    cfg.toastEnabled !== false &&
    dismissed.toast !== burst.id

  const write = useCallback(() => {
    frame.current = null
    const el = wrapRef.current
    if (el) el.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0)`
  }, [])

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(write)
  }, [write])

  /**
   * Play a one-shot animation on the sprite, then hand it back to its idle loop.
   *
   * The idle motion lives in a class (`mo-idle-breathe` and friends); these
   * one-shots are written to `style.animation`, which outranks a class. Nothing
   * ever cleared that inline value, so the *first* sticker or drag left it set
   * forever and the mascot stopped breathing for the rest of the session — it
   * still carried the right class, but the spent inline animation kept winning.
   *
   * Clearing on `animationend` is safe against the idle loop: those are
   * `infinite`, and an infinite animation never fires `animationend`.
   */
  const playOnce = useCallback((spec: string) => {
    const el = spriteRef.current
    if (!el) return
    el.style.animation = 'none'
    // Force a reflow so the same animation can be restarted back-to-back.
    void el.offsetWidth
    el.style.animation = spec
    const done = (): void => {
      el.style.animation = ''
      el.removeEventListener('animationend', done)
    }
    el.addEventListener('animationend', done)
  }, [])

  const clamp = useCallback(
    (p: Pos): Pos => {
      const el = wrapRef.current
      const w = el?.offsetWidth ?? 140
      const h = el?.offsetHeight ?? 180
      // In the overlay there is no title bar or rail to avoid — the whole work
      // area is fair game, so only keep it from sliding off the edge.
      const top = overlay ? 8 : TITLEBAR_H
      return {
        x: Math.min(Math.max(p.x, 8), Math.max(8, window.innerWidth - w - 8)),
        y: Math.min(Math.max(p.y, top), Math.max(top, window.innerHeight - h - 8))
      }
    },
    [overlay]
  )

  // Click-through. The overlay covers the entire work area, so it must ignore
  // the mouse everywhere except over the sprite itself — otherwise it would eat
  // every click meant for the windows underneath.
  const interactive = useRef(false)
  useEffect(() => {
    // Bound to visibility as well as to `overlay`: when the mascot is hidden the
    // component renders null, `wrapRef` goes empty and `onMove` can no longer
    // tell that the pointer has left the sprite. Hiding while the pointer is
    // over it would strand the window with mouse events still enabled, and the
    // next time it was shown it would swallow clicks meant for the desktop until
    // a mousemove happened to heal it. Tearing the effect down here runs the
    // cleanup below, which releases the capture — no second copy of the logic.
    if (!overlay || !cfg.visible) return
    const over = (el: HTMLElement | null, e: MouseEvent): boolean => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return (
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      )
    }

    const onMove = (e: MouseEvent): void => {
      if (!wrapRef.current) return
      const onSprite = over(wrapRef.current, e)
      /*
       * The approval card counts as part of the mascot for click-through.
       *
       * It is positioned out of flow so it cannot shove the sprite around, which
       * also means it does not grow the wrapper's rect — so a hit test on the
       * wrapper alone left the Allow and Deny buttons unclickable. Testing it
       * separately is the narrow fix; making the whole overlay interactive while
       * an approval is pending would block every click to every other app on the
       * desktop until the user answered.
       */
      const inside =
        onSprite ||
        over(approvalRef.current, e) ||
        over(menuRef.current, e) ||
        over(bubblesRef.current, e)
      if (inside === interactive.current) return
      interactive.current = inside
      // The same hit-test already decides click-through, so hover comes free
      // here. `pointerenter` cannot do this job in the overlay: the window
      // ignores the mouse until this call turns it back on, so the pointer is
      // already over the sprite by the time DOM events start arriving.
      setHovering(onSprite)
      void window.mochi?.mascotInteractive(inside)
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      interactive.current = false
      setHovering(false)
      void window.mochi?.mascotInteractive(false)
    }
  }, [overlay, cfg.visible])

  // Initial placement. A stored position that would cover the rail or the title
  // bar is rejected outright rather than clamped — clamping it would park the
  // mascot flush against the rail edge, which is exactly what we're avoiding.
  // useLayoutEffect, not useEffect: an effect runs *after* paint, so the very
  // first frame drew the mascot at its untransformed origin — the top-left
  // corner — before jumping to place.
  useLayoutEffect(() => {
    const stored = cfg.rememberPosition ? readStoredPos() : null
    const usable = stored && !(stored.x < RAIL_W || stored.y < TITLEBAR_H) ? stored : null
    const el = wrapRef.current
    const w = el?.offsetWidth ?? 140
    const h = el?.offsetHeight ?? 180
    // Corner and gap were fixed at bottom-right, 34 across and 30 down. Those
    // are still the defaults, so nothing moves for anyone who never opens the
    // Overlay screen.
    const anchor = cfg.anchor ?? 'bottom-right'
    const gapX = cfg.offsetX ?? 34
    const gapY = cfg.offsetY ?? 30
    pos.current = usable ?? {
      x: anchor.endsWith('right') ? window.innerWidth - w - gapX : gapX,
      y: anchor.startsWith('bottom') ? window.innerHeight - h - gapY : gapY
    }
    pos.current = clamp(pos.current)
    write()
    // Placement runs once; re-running on resize would yank the mascot around
    // while the user is dragging the window edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The position lives on the DOM node, not in React state, so any render that
  // hands us a *new* node loses it. Re-asserting it after every commit costs one
  // style write and makes the mascot's placement independent of how React
  // chooses to reconcile the tree.
  useLayoutEffect(write)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      /*
       * Never start a drag inside the approval card.
       *
       * The wrapper captures the pointer to drag the mascot, and a capture taken
       * on pointerdown swallows the click that would have followed — so Allow
       * and Deny simply did nothing. Guarded on containment rather than on
       * `dragAnywhere`, because the buttons must work whichever way that is set.
       */
      if (approvalRef.current?.contains(e.target as Node)) return
      if (menuRef.current?.contains(e.target as Node)) return
      if (bubblesRef.current?.contains(e.target as Node)) return
      if (!cfg.dragAnywhere && e.target !== spriteRef.current) return
      dragging.current = true
      moved.current = false
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      const start = { x: e.clientX, y: e.clientY }
      const origin = { ...pos.current }
      // Direction is measured against the *previous* event, not the grab point:
      // from the origin it would keep reporting the way the drag began long
      // after the user had doubled back.
      let last = { x: e.clientX, y: e.clientY }
      let shown: MascotPose = 'picked'
      setDragPose('picked')

      const move = (ev: PointerEvent): void => {
        if (!dragging.current) return
        const dx = ev.clientX - start.x
        const dy = ev.clientY - start.y
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true

        // Held still mid-drag falls back to `picked` rather than freezing on the
        // last direction — the mascot is being held, not walking.
        const next = walkPose(ev.clientX - last.x, ev.clientY - last.y) ?? 'picked'
        last = { x: ev.clientX, y: ev.clientY }
        if (next !== shown) {
          shown = next
          setDragPose(next)
        }

        pos.current = { x: origin.x + dx, y: origin.y + dy }
        schedule()
      }

      const up = (): void => {
        dragging.current = false
        setDragPose(null)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        pos.current = clamp(pos.current)
        write()
        if (cfg.rememberPosition) localStorage.setItem(POS_KEY, JSON.stringify(pos.current))
        if (cfg.bounceOnDrop && moved.current) {
          // On the sprite, not the wrapper: the wrapper's transform is what
          // positions the mascot, and an animation there would override it for
          // the duration and snap the mascot to the corner mid-bounce.
          playOnce('mo-settle 420ms cubic-bezier(.2,1.4,.4,1)')
        }
        // A click without movement fires a sticker — unless the overlay has been
        // set to leave clicks alone, which is what you want when the mascot sits
        // over something you click a lot. The click *pose* is not conditional on
        // that: reacting to being poked is worth doing even when nothing else
        // happens, and it is the only feedback left when the action is "none".
        if (!moved.current) {
          // A click is the one thing that outranks sleep — ordinary activity
          // elsewhere leaves her resting, so this has to say so explicitly.
          if (mascotState === 'sleeping') {
            void window.mochi?.setMascotState('idle', 'waiting on you')
          }
          flashClick()
          if ((cfg.clickAction ?? 'sticker') === 'sticker') fireSticker({ voice: 'poke' })
        }
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [
      cfg.dragAnywhere,
      cfg.bounceOnDrop,
      cfg.rememberPosition,
      // Without this the handler keeps whatever `clickAction` was bound at mount,
      // so switching to "do nothing" would not take effect until a remount.
      cfg.clickAction,
      // Read inside the handler to decide whether a click should wake her.
      mascotState,
      clamp,
      schedule,
      write,
      fireSticker,
      flashClick,
      playOnce
    ]
  )

  // Play the sound mapped to a state when the mascot enters it. Skips the first
  // render so opening the app doesn't announce "idle" at you.
  const lastState = useRef<MascotState | null>(null)
  useEffect(() => {
    const previous = lastState.current
    lastState.current = mascotState
    if (previous === null || previous === mascotState) return
    const id = cfg.stateSounds?.[mascotState]
    if (!id) return
    const quiet = settings.quietHours.enabled
      ? isQuietNow(settings.quietHours.from, settings.quietHours.to)
      : false
    void playSound(soundSrc(id), { enabled: settings.sound, quiet })
  }, [mascotState, cfg.stateSounds, settings.sound, settings.quietHours, soundSrc])

  // A sticker burst: sound, squash-and-stretch, state label, and the configured
  // render targets — all from one event so they always land together.
  useEffect(() => {
    if (!burst) return
    const quiet = settings.quietHours.enabled
      ? isQuietNow(settings.quietHours.from, settings.quietHours.to)
      : false

    void playSound(burst.soundSrc, { enabled: settings.sound, quiet })

    playOnce('mo-squash 720ms cubic-bezier(.3,1.3,.4,1)')

    // Each target clears on its own clock. Nothing is set synchronously here —
    // the burst is already visible by virtue of existing.
    const id = burst.id
    // The full-screen card is the loudest of the three, so it clears sooner than
    // the bubble and label — kept proportional to the configured duration rather
    // than pinned to the old 1500ms.
    const hold = cfg.burstMs ?? 2600
    const timers = [
      setTimeout(() => setDismissed((d) => ({ ...d, label: id })), hold),
      setTimeout(() => setDismissed((d) => ({ ...d, bubble: id })), hold),
      setTimeout(() => setDismissed((d) => ({ ...d, overlay: id })), Math.round(hold * 0.58)),
      // The toast lingers a little past the rest — it exists for the moment you
      // are looking at something else, so it has to survive being glanced at
      // late. Replaces the OS notification that used to fire here: that could
      // not show the mascot and, on Windows, mostly ended up unread in the
      // Action Centre.
      setTimeout(() => setDismissed((d) => ({ ...d, toast: id })), Math.round(hold * 1.6))
    ]

    return () => timers.forEach(clearTimeout)
  }, [burst, settings.sound, settings.quietHours, cfg.burstMs, playOnce])

  // The pose wins when there is one — how the mascot is being handled is more
  // immediate than what the agent is doing. `spriteSrc` falls back to idle, so
  // an unfilled slot never blanks the sprite.
  const src = spriteSrc(pose ?? mascotState)

  // Deliberately before the visibility gate: hiding the mascot should silence
  // the sprite, not the notifications that replaced the OS ones. Returning null
  // here would mean turning the mascot off also turned off being told anything.
  const toast =
    showToast && burst ? (
      <div
        className="mo-toast"
        key="mo-toast"
        data-anchor={cfg.toastAnchor ?? 'bottom-right'}
        data-size={cfg.toastSize ?? 'medium'}
        role="status"
      >
        <div className="mo-toast-art">
          {burst.stickerSrc || src ? (
            <img src={burst.stickerSrc ?? (src as string)} alt="" draggable={false} />
          ) : (
            <span className="mo-placeholder">art?</span>
          )}
        </div>
        <div className="mo-toast-text">
          {/* The agent's name, not the app's. There is one mascot and it wears
              the default agent's face — signing its messages "Mochi" made them
              read as coming from the software rather than from her. */}
          <span className="mo-toast-title">{speaker}</span>
          <span className="mo-toast-body">{burst.caption}</span>
        </div>
      </div>
    ) : null

  if (!cfg.visible) return toast
  const stateLine = showLabel ? 'sent a sticker' : `${mascotState} · ${mascotNote}`

  return (
    <>
      {toast}

      {/* Keyed: without it React reuses the mascot's own node for this overlay
          when it appears, rebuilding the wrapper and dropping the transform that
          positions it — which read as the mascot teleporting to the corner. */}
      {showOverlay && burst && (
        <div className="mo-overlay" key="mo-overlay" aria-hidden>
          {cfg.overlayScrim !== false && <div className="mo-overlay-scrim" />}
          <div className="mo-overlay-card" data-size={cfg.overlayCardSize ?? 'medium'}>
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
        key="mo-wrap"
        style={{ opacity: cfg.opacity }}
        onPointerDown={onPointerDown}
        // In the app window there is no click-through hit-test to piggyback on,
        // so hover comes from the DOM. Harmless in the overlay: the effect above
        // is already setting the same value.
        onContextMenu={(e) => {
          e.preventDefault()
          measure()
          setMenuOpen(false)
          setBubblesOpen((v) => !v)
        }}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        role="button"
        tabIndex={0}
        aria-label={`Mascot — ${stateLine}. Click to send a sticker.`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            flashClick()
            fireSticker({ voice: 'poke' })
          }
        }}
      >
        {/* `bubbleStyle` has been in the config all along but nothing ever read
            it, so the bubble was always the soft one and "none" did nothing. */}
        {/* Above the sticker bubble in the stack, and it wins when both are
            present: a sticker is decoration, this is a stalled run. */}
        {approval && server && (
          <ApprovalBubble
            request={approval}
            baseUrl={server.baseUrl}
            onAnswered={() => setApproval(null)}
            cardRef={approvalRef}
          />
        )}

        {bubblesOpen && (
          <BubbleMenu
            cardRef={bubblesRef}
            placement={placement}
items={[
              {
                id: 'chat',
                label: 'Pop-up chat',
                icon: <MessageSquare size={15} strokeWidth={1.9} />,
                onPick: () => {
                  setBubblesOpen(false)
                  setMenuOpen(true)
                }
              },
              {
                id: 'open',
                label: 'Open Mochi',
                icon: <PanelsTopLeft size={15} strokeWidth={1.9} />,
                onPick: () => {
                  setBubblesOpen(false)
                  void window.mochi?.focusSession(draftTarget ?? '')
                }
              },
              {
                id: 'poke',
                label: 'Poke',
                icon: <Hand size={15} strokeWidth={1.9} />,
                onPick: () => {
                  setBubblesOpen(false)
                  flashClick()
                  fireSticker({ voice: 'poke' })
                }
              },
              {
                id: 'hide',
                label: 'Hide mascot',
                icon: <EyeOff size={15} strokeWidth={1.9} />,
                onPick: () => {
                  setBubblesOpen(false)
                  dispatch({ type: 'mascot-config', patch: { visible: false } })
                }
              }
            ]}
          />
        )}

        {menuOpen && (
          <MascotMenu
            cardRef={menuRef}
            placement={placement}
            text={draft}
            setText={setDraft}
            target={draftTarget}
            setTarget={setDraftTarget}
            onClose={() => setMenuOpen(false)}
          />
        )}

        {showBubble && burst && !approval && !menuOpen && !bubblesOpen && cfg.bubbleStyle !== 'none' && (
          <div className="mo-bubble" data-style={cfg.bubbleStyle ?? 'soft'}>
            {burst.caption}
          </div>
        )}

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
          {(cfg.shell === 'card' || cfg.shell === 'terrarium') && cfg.showStatus !== false ? (
            <div className="mo-name mono">{stateLine}</div>
          ) : null}
        </div>

        {cfg.showShadow !== false && (
          <div className={`mo-ground ${cfg.idleMotion === 'still' ? '' : 'mo-ground-anim'}`} />
        )}
      </div>
    </>
  )
}
