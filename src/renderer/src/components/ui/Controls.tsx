import { useLayoutEffect, useRef } from 'react'
import './controls.css'

/** 5px track, accent fill, 14px round accent knob. */
export function Slider({
  value,
  min = 0,
  max = 10,
  step = 1,
  onChange,
  label
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  label?: string
}): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <input
      className="slider"
      type="range"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      style={{ '--pct': `${pct}%` } as React.CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

/** 34×20 pill, or 30×18 in dense rows. */
export function Toggle({
  on,
  onChange,
  label,
  dense = false
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  dense?: boolean
}): React.JSX.Element {
  return (
    <button
      className="toggle"
      data-on={on}
      data-dense={dense}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  )
}

export function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ctl-row">
      <div className="ctl-row-text">
        <span className="ctl-row-label">{label}</span>
        {hint && <span className="meta">{hint}</span>}
      </div>
      <div className="ctl-row-control">{children}</div>
    </div>
  )
}

export function Pills<T extends string>({
  options,
  value,
  onChange
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="pills">
      {options.map((o) => (
        <button
          key={o.value}
          className="pill-ghost"
          data-on={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ScreenHeader({
  title,
  subtitle,
  action
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="screen-head">
      <div className="screen-head-text">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}

/** Soft square placeholder for artwork the user hasn't dropped in yet. */
export function ArtPlaceholder({ size = '100%' }: { size?: number | string }): React.JSX.Element {
  return (
    <div className="art-placeholder" style={{ width: size, height: size }}>
      art?
    </div>
  )
}

export function Section({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="section">
      <div className="section-head">
        <span className="section-label">{label}</span>
        {hint && <span className="meta">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

/**
 * A textarea that grows to fit what is in it.
 *
 * The agent's Instructions field was a fixed seven rows, so a long persona was
 * edited through a letterbox while a one-line one left a block of dead space.
 * Height is measured off `scrollHeight`, which needs the box collapsed first —
 * otherwise it only ever reports the height it already has and the field can
 * grow but never shrink.
 *
 * `useLayoutEffect`, not `useEffect`: resizing after paint shows one frame at
 * the old height, which reads as a flicker on every keystroke.
 */
export function AutoTextarea({
  value,
  onChange,
  minRows = 3,
  maxRows = 22,
  placeholder,
  className = ''
}: {
  value: string
  onChange: (v: string) => void
  minRows?: number
  maxRows?: number
  placeholder?: string
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const style = window.getComputedStyle(el)
    const line = parseFloat(style.lineHeight) || 20
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    el.style.height = 'auto'
    const wanted = el.scrollHeight + border
    const min = line * minRows + padding + border
    const max = line * maxRows + padding + border
    el.style.height = `${Math.min(Math.max(wanted, min), max)}px`
    // Past the cap it has to scroll, or the tail of a long prompt is unreachable.
    el.style.overflowY = wanted > max ? 'auto' : 'hidden'
  }, [value, minRows, maxRows])

  return (
    <textarea
      ref={ref}
      className={`field-input field-area ${className}`.trim()}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
