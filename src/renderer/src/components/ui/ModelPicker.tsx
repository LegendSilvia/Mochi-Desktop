import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Check, Search } from 'lucide-react'
import { MODEL_CATALOG, findModel } from '@shared/models'
import './modelpicker.css'

/**
 * Model chooser.
 *
 * The field used to be raw text, which meant knowing exact router ids by heart
 * and getting a silent 404 at request time for a typo. This lists what's known,
 * grouped by provider — but still accepts free text, because Mastra's router
 * takes any `provider/model` and a hard whitelist would go stale the week a new
 * model ships.
 */
export function ModelPicker({
  value,
  onChange
}: {
  value: string
  onChange: (next: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const known = findModel(value)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return MODEL_CATALOG
    return MODEL_CATALOG.map((g) => ({
      ...g,
      models: g.models.filter(
        (m) =>
          m.id.toLowerCase().includes(needle) ||
          m.label.toLowerCase().includes(needle) ||
          m.hint.toLowerCase().includes(needle)
      )
    })).filter((g) => g.models.length > 0)
  }, [q])

  const custom = q.trim().includes('/') && !findModel(q.trim())

  return (
    <div className="mp" ref={boxRef}>
      <button className="mp-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="mp-trigger-text">
          <span className="mp-label">{known?.label ?? (value || 'Pick a model')}</span>
          <span className="mono meta">{value}</span>
        </span>
        <ChevronDown size={14} strokeWidth={1.9} data-open={open} />
      </button>

      {open && (
        <div className="mp-pop">
          <div className="mp-search">
            <Search size={13} strokeWidth={1.8} />
            <input
              className="mp-search-input"
              autoFocus
              placeholder="Search, or type any provider/model…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && custom) {
                  onChange(q.trim())
                  setOpen(false)
                  setQ('')
                }
                if (e.key === 'Escape') setOpen(false)
              }}
            />
          </div>

          <div className="mp-list">
            {custom && (
              <button
                className="mp-item"
                onClick={() => {
                  onChange(q.trim())
                  setOpen(false)
                  setQ('')
                }}
              >
                <span className="mp-item-text">
                  <span className="mp-label">Use “{q.trim()}”</span>
                  <span className="meta">not in the list — Mastra will still route it</span>
                </span>
              </button>
            )}

            {groups.map((g) => (
              <div key={g.provider}>
                <div className="mp-group">
                  <span>{g.label}</span>
                  <span className="chip">{g.billing}</span>
                </div>
                {g.models.map((m) => (
                  <button
                    key={m.id}
                    className="mp-item"
                    data-on={m.id === value}
                    onClick={() => {
                      onChange(m.id)
                      setOpen(false)
                      setQ('')
                    }}
                  >
                    <span className="mp-item-text">
                      <span className="mp-label">{m.label}</span>
                      <span className="meta">{m.hint}</span>
                    </span>
                    {m.id === value && <Check size={13} strokeWidth={2.2} />}
                  </button>
                ))}
              </div>
            ))}

            {groups.length === 0 && !custom && (
              <p className="meta mp-empty">
                Nothing matches. Type a full <span className="mono">provider/model</span> to use it
                anyway.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
