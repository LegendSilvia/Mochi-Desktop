import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  MessageSquare,
  GitBranch,
  Users,
  Sparkles,
  Sticker as StickerIcon,
  CornerDownLeft
} from 'lucide-react'
import { useStore } from '@renderer/state/context'
import type { Screen } from '@renderer/state/screens'
import './palette.css'

interface Hit {
  id: string
  group: 'Sessions' | 'Agents' | 'Stickers' | 'Go to'
  label: string
  hint?: string
  icon: React.JSX.Element
  run: () => void
}

/**
 * Ctrl/Cmd-K palette.
 *
 * The rail's search button and shortcut used to be decoration. This searches
 * what the user actually has — their sessions, loadouts and sticker library —
 * plus the screens, so one key gets anywhere in the app.
 */
export function CommandPalette(): React.JSX.Element | null {
  const { searchOpen, dispatch, sessions, agents, library, fireSticker } = useStore()
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = (): void => dispatch({ type: 'toggle', key: 'searchOpen', value: false })

  useEffect(() => {
    if (searchOpen) {
      setQ('')
      setCursor(0)
      // Focus after paint, or the input isn't in the tree yet.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [searchOpen])

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase()
    const match = (s: string): boolean => !needle || s.toLowerCase().includes(needle)
    const out: Hit[] = []

    for (const s of sessions) {
      if (!match(s.title)) continue
      out.push({
        id: `s:${s.id}`,
        group: 'Sessions',
        label: s.title,
        hint: s.archived ? 'archived' : s.pinned ? 'pinned' : undefined,
        icon:
          s.kind === 'code' ? (
            <GitBranch size={14} strokeWidth={1.8} className="ic-code" />
          ) : (
            <MessageSquare size={14} strokeWidth={1.8} className="ic-chat" />
          ),
        run: () => {
          dispatch({ type: 'active', id: s.id })
          dispatch({ type: 'screen', screen: 'chat' })
        }
      })
    }

    for (const a of agents) {
      if (!match(a.name) && !match(a.description) && !match(a.model)) continue
      out.push({
        id: `a:${a.id}`,
        group: 'Agents',
        label: a.name,
        hint: a.description,
        icon: <Users size={14} strokeWidth={1.8} />,
        run: () => dispatch({ type: 'screen', screen: 'agents' })
      })
    }

    for (const st of library?.stickers ?? []) {
      if (!match(st.name) && !match(st.tag)) continue
      out.push({
        id: `k:${st.id}`,
        group: 'Stickers',
        label: st.name,
        hint: `send now · ${st.tag}`,
        icon: <StickerIcon size={14} strokeWidth={1.8} />,
        run: () => fireSticker({ stickerId: st.id })
      })
    }

    const screens: Array<[Screen, string, React.JSX.Element]> = [
      ['agents', 'Agents & loadouts', <Users key="a" size={14} strokeWidth={1.8} />],
      ['mascot', 'Mascot studio', <Sparkles key="m" size={14} strokeWidth={1.8} />],
      ['stickers', 'Stickers & sound', <StickerIcon key="s" size={14} strokeWidth={1.8} />],
      ['new', 'New session', <MessageSquare key="n" size={14} strokeWidth={1.8} />]
    ]
    for (const [key, label, icon] of screens) {
      if (!match(label)) continue
      out.push({
        id: `g:${key}`,
        group: 'Go to',
        label,
        icon,
        run: () => dispatch({ type: 'screen', screen: key })
      })
    }

    return out.slice(0, 40)
  }, [q, sessions, agents, library, dispatch, fireSticker])

  useEffect(() => setCursor(0), [q])

  if (!searchOpen) return null

  const choose = (hit: Hit | undefined): void => {
    if (!hit) return
    hit.run()
    close()
  }

  let lastGroup = ''

  return (
    <div className="palette-scrim" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="palette-input-row">
          <Search size={15} strokeWidth={1.8} />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Search sessions, agents, stickers…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, hits.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(hits[cursor])
              }
            }}
          />
          <span className="palette-esc mono">esc</span>
        </div>

        <div className="palette-list">
          {hits.length === 0 && <div className="palette-empty meta">Nothing matches that.</div>}
          {hits.map((hit, i) => {
            const header = hit.group !== lastGroup ? hit.group : null
            lastGroup = hit.group
            return (
              <div key={hit.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className="palette-hit"
                  data-on={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(hit)}
                >
                  {hit.icon}
                  <span className="palette-label">{hit.label}</span>
                  {hit.hint && <span className="palette-hint meta">{hit.hint}</span>}
                  {i === cursor && <CornerDownLeft size={12} strokeWidth={1.8} />}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
