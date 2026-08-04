import { useCallback, useRef } from 'react'
import { Minus, X } from 'lucide-react'
import type { WidgetGeom } from '@shared/types'
import { MIN_H, MIN_W } from './registry'
import type { LucideIcon } from 'lucide-react'

/** Which edge or corner a drag grabbed. `move` is the header. */
type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const EDGES: Grip[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

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
  actions
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
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  /** Live geometry during a drag. Not state: this changes every frame and no
   *  render depends on it until the pointer comes up. */
  const draft = useRef<WidgetGeom>(geom)

  const start = useCallback(
    (grip: Grip) =>
      (e: React.PointerEvent): void => {
        // Left button only. A right-click on the header opens the chat's own
        // menu, and a middle-drag should scroll rather than move the panel.
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        onFocus()

        const box = boxRef.current
        if (!box) return
        const from = { ...geom }
        const originX = e.clientX
        const originY = e.clientY
        draft.current = from
        ;(e.target as Element).setPointerCapture?.(e.pointerId)

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

          draft.current = { x, y, w, h }
          box.style.transform = `translate(${x}px, ${y}px)`
          box.style.width = `${w}px`
          box.style.height = `${h}px`
        }

        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          onGeom(draft.current)
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      },
    [geom, onGeom, onFocus]
  )

  return (
    <div
      ref={boxRef}
      className="wg"
      style={{
        transform: `translate(${geom.x}px, ${geom.y}px)`,
        width: geom.w,
        height: geom.h,
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
