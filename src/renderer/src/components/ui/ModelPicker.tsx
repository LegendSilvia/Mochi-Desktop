import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Check, Search } from 'lucide-react'
import { MODEL_CATALOG, findModel, type ModelOption, type ProviderGroup } from '@shared/models'
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
  onChange,
  catalog = MODEL_CATALOG,
  modality = 'text'
}: {
  value: string
  onChange: (next: string) => void
  /** Narrows what is on offer. The embeddings role passes the embedding-only
   *  catalogue, because offering chat models for a job they cannot do is how
   *  you end up with a setting that saves cleanly and never works. */
  catalog?: ProviderGroup[]
  /** Which OpenRouter models to ask for — their `output_modalities` filter.
   *  The static catalogue cannot express this; the live one can. */
  modality?: 'text' | 'embeddings'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [up, setUp] = useState(false)
  const [space, setSpace] = useState(280)
  const [connected, setConnected] = useState<string[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Which providers are actually usable right now: one with a stored key, a
  // local runtime, or Anthropic when the Claude subscription is on. Listing
  // models you can't reach is just a menu of future errors.
  useEffect(() => {
    if (!open) return
    void window.mochi?.providers().then((list) => {
      setConnected(list.filter((p) => p.connected).map((p) => p.id))
    })
  }, [open])

  // Decide which way to open, and how tall, from the room actually available.
  useEffect(() => {
    if (!open) return
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return
    const below = window.innerHeight - rect.bottom - 16
    const above = rect.top - 16
    const flip = below < 240 && above > below
    setUp(flip)
    setSpace(Math.max(160, Math.floor((flip ? above : below) - 52)))
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  // Anthropic stays offered even without a stored key, because the Claude
  // subscription reaches it without one.
  const usable = (p: string): boolean =>
    showAll || connected === null || connected.includes(p) || p === 'anthropic'

  const hiddenCount = catalog.filter((g) => !usable(g.provider)).length

  /*
   * OpenRouter's list, asked for rather than remembered.
   *
   * It fronts hundreds of models and changes them weekly, so a hand-written
   * entry is stale on arrival and can be worse than stale: the one embedding id
   * written from their docs answered 404 and silently embedded nothing. The
   * search term goes to the API too, which is what reaches past the first
   * hundred most-popular without paging.
   */
  const [live, setLive] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    // Debounced: this fires on every keystroke in the search box.
    const timer = setTimeout(() => {
      void window.mochi
        ?.openrouterModels({ modality, q: q.trim() || undefined })
        .then((rows) => {
          if (!cancelled) setLive(rows)
        })
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, q, modality])

  /*
   * Anthropic's list, asked of the subscription rather than written down.
   *
   * The account decides what it can run — plan, entitlements, and whatever
   * shipped this week. A hand-written list made models the account cannot reach
   * selectable, and the only feedback was an error after sending a message.
   *
   * Not searched server-side like OpenRouter: this is a dozen rows, so the
   * client filter handles it and one fetch per open is enough.
   */
  const [liveAnthropic, setLiveAnthropic] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    if (!open || modality !== 'text') return
    let cancelled = false
    void window.mochi?.anthropicModels().then((rows) => {
      if (!cancelled) setLiveAnthropic(rows)
    })
    return () => {
      cancelled = true
    }
  }, [open, modality])

  // The live rows are searched too, so a model picked from OpenRouter shows its
  // name rather than falling back to the bare id it has no catalogue entry for.
  const known =
    findModel(value, catalog) ??
    live?.find((m) => m.id === value) ??
    liveAnthropic?.find((m) => m.id === value)

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const base = catalog
      .filter((g) => usable(g.provider))
      // A live list replaces the written-down one entirely when it arrives.
      // Merging them would reintroduce exactly the ids that do not resolve.
      .map((g) => (g.provider === 'openrouter' && live?.length ? { ...g, models: live } : g))
      .map((g) =>
        g.provider === 'anthropic' && liveAnthropic?.length
          ? { ...g, models: liveAnthropic }
          : g
      )
    if (!needle) return base
    return base
      .map((g) =>
        // OpenRouter's rows came back already matching `q` — the API did the
        // searching. Filtering them again on the raw string would throw away
        // every result whose relevance is not spelled out in its own name.
        g.provider === 'openrouter' && live?.length
          ? g
          : {
              ...g,
              models: g.models.filter(
                (m) =>
                  m.id.toLowerCase().includes(needle) ||
                  m.label.toLowerCase().includes(needle) ||
                  m.hint.toLowerCase().includes(needle)
              )
            }
      )
      .filter((g) => g.models.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, connected, showAll, catalog, live, liveAnthropic])

  const custom = q.trim().includes('/') && !findModel(q.trim(), catalog)

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
        <div
          className="mp-pop"
          data-up={up}
          style={{ ['--mp-space' as string]: `${space}px` }}
        >
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

            {hiddenCount > 0 && !showAll && (
              <button className="mp-more" onClick={() => setShowAll(true)}>
                Show {hiddenCount} provider{hiddenCount > 1 ? 's' : ''} you haven&apos;t connected
              </button>
            )}

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
