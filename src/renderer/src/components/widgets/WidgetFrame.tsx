import { useCallback, useRef, useState } from 'react'
import { Minus, X } from 'lucide-react'
import type { WidgetGeom } from '@shared/types'
import { MIN_H, MIN_W } from './registry'
import type { LucideIcon } from 'lucide-react'

/** Which edge or corner a drag grabbed. `move` is the header. */
type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const EDGES: Grip[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** The cursor each grip should pin for the whole drag. */
const CURSOR: Record<Grip, string> = {
  move: 'grabbing',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize'
}

/**
 * The box a widget lives in: title bar, collapse, close, and eight grips.
 *
 * Geometry is committed on release rather than on every pointer move. The moves
 * themselves are written straight to the element's style, so dragging stays at
 * pointer speed — routing sixty updates a second through session state would
 * persist the whole session list on each one.
 */
export function WidgetFrame({
  title,
  subtitle,
  icon: Icon,
  geom,
  z,
  onGeom,
  onCollapse,
  onClose,
  onFocus,
  children,
  actions,
  onDragMove,
  onDragEnd
}: {
  title: string
  subtitle?: string
  icon: LucideIcon
  geom: WidgetGeom
  z: number
  onGeom: (next: WidgetGeom) => void
  onCollapse: () => void
  onClose: () => void
  onFocus: () => void
  children: React.ReactNode
  actions?: React.ReactNode
  /** Reported on every header drag so the host can offer a snap zone. */
  onDragMove?: (clientX: number, clientY: number) => void
  /** Returns true when the host consumed the drop as a dock, in which case the
   *  floating geometry is deliberately *not* committed — the widget is about to
   *  stop being a floating widget. */
  onDragEnd?: (clientX: number, clientY: number) => boolean
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  /**
   * The geometry while a drag is running.
   *
   * This used to be written straight to `box.style` to avoid a state update per
   * frame — which was wrong. Any re-render (the parent tracking a snap zone, the
   * chat streaming a token, anything at all) re-applied `style` from the *props*
   * geometry and yanked the box back to where it started, so the panel flickered
   * between the two and drifted away from the cursor.
   *
   * Rendering from state instead means React owns the position and there is
   * nothing to fight: what is drawn is exactly what the pointer last said.
   */
  const [live, setLive] = useState<WidgetGeom | null>(null)
  const shown = live ?? geom

  const start = useCallback(
    (grip: Grip) =>
      (e: React.PointerEvent): void => {
        // Left button only. A right-click on the header opens the chat's own
        // menu, and a middle-drag should scroll rather than move the panel.
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        onFocus()

        const from = { ...geom }
        const originX = e.clientX
        const originY = e.clientY
        let latest = from
        // Capture on the grip itself, not `e.target`: the target can be a child
        // that unmounts mid-drag, which silently drops the capture.
        e.currentTarget.setPointerCapture?.(e.pointerId)

        // Pin the cursor for the duration. As the box moves and resizes the
        // pointer crosses the header, the body and other grips, and each would
        // otherwise assert its own cursor — which is the flicker.
        document.body.classList.add('wg-dragging')
        document.body.style.setProperty('--wg-drag-cursor', CURSOR[grip])

        const onMove = (ev: PointerEvent): void => {
          const dx = ev.clientX - originX
          const dy = ev.clientY - originY
          let { x, y, w, h } = from

          if (grip === 'move') {
            x += dx
            y += dy
          } else {
            // Dragging a top or left edge moves the origin as well as the size,
            // and the min-size clamp has to apply to both or the box slides
            // sideways once it stops shrinking.
            if (grip.includes('e')) w = Math.max(MIN_W, from.w + dx)
            if (grip.includes('s')) h = Math.max(MIN_H, from.h + dy)
            if (grip.includes('w')) {
              w = Math.max(MIN_W, from.w - dx)
              x = from.x + (from.w - w)
            }
            if (grip.includes('n')) {
              h = Math.max(MIN_H, from.h - dy)
              y = from.y + (from.h - h)
            }
          }

          latest = { x, y, w, h }
          setLive(latest)
          if (grip === 'move') onDragMove?.(ev.clientX, ev.clientY)
        }

        const onUp = (ev: PointerEvent): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          document.body.classList.remove('wg-dragging')
          document.body.style.removeProperty('--wg-drag-cursor')
          setLive(null)
          // A drag that ended on an edge becomes a dock, and committing the
          // floating position first would put the widget briefly in the wrong
          // place before the layout reflows.
          if (grip === 'move' && onDragEnd?.(ev.clientX, ev.clientY)) return
          onGeom(latest)
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        // Losing the pointer (window blur, touch cancelled) must not leave the
        // body stuck in drag mode with every cursor overridden.
        window.addEventListener('pointercancel', onUp)
      },
    [geom, onGeom, onFocus, onDragMove, onDragEnd]
  )

  return (
    <div
      ref={boxRef}
      className="wg"
      style={{
        transform: `translate(${shown.x}px, ${shown.y}px)`,
        width: shown.w,
        height: shown.h,
        zIndex: z
      }}
      onPointerDown={onFocus}
    >
      <div className="wg-head" onPointerDown={start('move')}>
        <Icon size={13} strokeWidth={1.9} className="wg-head-icon" />
        <span className="wg-title" title={subtitle ?? title}>
          {title}
        </span>
        {subtitle && (
          <span className="wg-sub mono" title={subtitle}>
            {subtitle}
          </span>
        )}
        <span className="wg-spacer" />
        {/* Stops the pointerdown reaching the header's move handler, which would
            otherwise start a drag on the way to the click. */}
        <div className="wg-actions" onPointerDown={(e) => e.stopPropagation()}>
          {actions}
          <button
            className="wg-btn"
            onClick={onCollapse}
            aria-label={`Collapse ${title}`}
            title="Collapse to a bubble"
          >
            <Minus size={13} strokeWidth={2} />
          </button>
          <button className="wg-btn" onClick={onClose} aria-label={`Close ${title}`} title="Close">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="wg-body">{children}</div>

      {EDGES.map((grip) => (
        <div key={grip} className={`wg-grip wg-grip-${grip}`} onPointerDown={start(grip)} />
      ))}
    </div>
  )
}
