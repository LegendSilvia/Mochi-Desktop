import { useState } from 'react'
import {
  Plus,
  Search,
  Users,
  Sparkles,
  Sticker as StickerIcon,
  ChevronRight,
  MessageSquare,
  GitBranch,
  SlidersHorizontal
} from 'lucide-react'
import { useStore } from '@renderer/state/context'
import type { Screen } from '@renderer/state/screens'
import { KEYS } from '@renderer/lib/platform'
import { AccountPopover } from './AccountPopover'
import type { Session } from '@shared/types'

const DAY = 24 * 60 * 60 * 1000

function dayLabel(ts: number): string {
  const age = Date.now() - ts
  if (age < DAY) return 'Today'
  if (age < 2 * DAY) return 'Yesterday'
  return 'Last week'
}

/**
 * 248px rail, modelled on Claude Desktop: fixed head, scrolling body, footer.
 *
 * Pinned and Recents are both drop zones — dragging a session between them is
 * what pins and unpins it.
 */
export function Rail(): React.JSX.Element {
  const { screen, sessions, dispatch, activeSessionId, library, pinOpen, recOpen } = useStore()
  const [dragId, setDragId] = useState<string | null>(null)
  const [hovering, setHovering] = useState<'pinned' | 'recents' | null>(null)

  const pinned = sessions.filter((s) => s.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
  const recents = sessions.filter((s) => !s.pinned).sort((a, b) => b.updatedAt - a.updatedAt)

  const setPinned = (id: string, pinned: boolean): void => {
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) => (s.id === id ? { ...s, pinned } : s))
    })
  }

  const openSession = (id: string): void => {
    dispatch({ type: 'active', id })
    dispatch({ type: 'screen', screen: 'chat' })
  }

  const dest = (
    key: Screen,
    Icon: typeof Users,
    label: string,
    count?: number
  ): React.JSX.Element => (
    <button
      className="rail-row"
      data-active={screen === key}
      onClick={() => dispatch({ type: 'screen', screen: key })}
    >
      <Icon size={15} strokeWidth={1.8} />
      <span className="rail-row-label">{label}</span>
      {count !== undefined && <span className="rail-count mono">{count}</span>}
    </button>
  )

  const sessionRow = (s: Session): React.JSX.Element => (
    <div
      key={s.id}
      className="rail-session"
      data-active={s.id === activeSessionId}
      draggable
      onDragStart={() => setDragId(s.id)}
      onDragEnd={() => {
        setDragId(null)
        setHovering(null)
      }}
      onClick={() => openSession(s.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && openSession(s.id)}
    >
      {s.kind === 'code' ? (
        <GitBranch size={13} strokeWidth={1.8} className="ic-code" />
      ) : (
        <MessageSquare size={13} strokeWidth={1.8} className="ic-chat" />
      )}
      <span className="rail-session-title">{s.title}</span>
      {s.busy ? <span className="rail-spinner" aria-label="busy" /> : <span className="rail-dot" />}
    </div>
  )

  const dropZone = (which: 'pinned' | 'recents', children: React.ReactNode): React.JSX.Element => (
    <div
      className="rail-drop"
      data-hot={dragId !== null}
      data-over={hovering === which}
      onDragOver={(e) => {
        e.preventDefault()
        setHovering(which)
      }}
      onDragLeave={() => setHovering((h) => (h === which ? null : h))}
      onDrop={(e) => {
        e.preventDefault()
        if (dragId) setPinned(dragId, which === 'pinned')
        setDragId(null)
        setHovering(null)
      }}
    >
      {children}
    </div>
  )

  return (
    <aside className="rail">
      <div className="rail-head">
        <button className="rail-new" onClick={() => dispatch({ type: 'screen', screen: 'new' })}>
          <Plus size={15} strokeWidth={2} />
          <span>New session</span>
          <span className="rail-kbd mono">{KEYS.newSession()}</span>
        </button>
        <button className="rail-search">
          <Search size={13} strokeWidth={1.8} />
          <span>Search</span>
          <span className="rail-kbd mono">{KEYS.search()}</span>
        </button>
      </div>

      <div className="rail-body">
        {dest('agents', Users, 'Agents & loadouts', 4)}
        {dest('mascot', Sparkles, 'Mascot studio')}
        {dest('stickers', StickerIcon, 'Stickers & sound', library?.stickers.length ?? 0)}

        <div className="rail-divider" />

        <button
          className="rail-group"
          onClick={() => dispatch({ type: 'toggle', key: 'pinOpen' })}
          aria-expanded={pinOpen}
        >
          <ChevronRight size={12} strokeWidth={2} className="rail-caret" data-open={pinOpen} />
          <span>Pinned</span>
          <span className="rail-count mono">{pinned.length}</span>
        </button>
        {pinOpen && dropZone('pinned', pinned.map(sessionRow))}

        <button
          className="rail-group"
          onClick={() => dispatch({ type: 'toggle', key: 'recOpen' })}
          aria-expanded={recOpen}
        >
          <ChevronRight size={12} strokeWidth={2} className="rail-caret" data-open={recOpen} />
          <span>Recents</span>
          <SlidersHorizontal size={11} strokeWidth={1.8} className="rail-group-tool" />
        </button>
        {recOpen &&
          dropZone(
            'recents',
            recents.map((s, i) => {
              const label = dayLabel(s.updatedAt)
              const prev = i > 0 ? dayLabel(recents[i - 1].updatedAt) : null
              return (
                <div key={s.id}>
                  {label !== prev && <div className="rail-day">{label}</div>}
                  {sessionRow(s)}
                </div>
              )
            })
          )}
      </div>

      <AccountPopover sessionCount={sessions.length} />
    </aside>
  )
}
