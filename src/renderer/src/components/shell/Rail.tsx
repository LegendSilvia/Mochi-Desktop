import { useEffect, useRef, useState } from 'react'
import {
  Plus,
  Search,
  Users,
  Sparkles,
  Sticker as StickerIcon,
  ChevronRight,
  MessageSquare,
  GitBranch,
  SlidersHorizontal,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2
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
 * what pins and unpins it. Each row also carries a menu (rename / pin / archive
 * / delete), because dragging is a nice affordance but a poor only-affordance.
 */
export function Rail(): React.JSX.Element {
  const {
    screen,
    sessions,
    agents,
    dispatch,
    activeSessionId,
    library,
    pinOpen,
    recOpen,
    archOpen
  } = useStore()
  const [dragId, setDragId] = useState<string | null>(null)
  const [hovering, setHovering] = useState<'pinned' | 'recents' | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  const live = sessions.filter((s) => !s.archived)
  const pinned = live.filter((s) => s.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
  const recents = live.filter((s) => !s.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
  const archived = sessions.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt)

  // Any click outside closes an open row menu.
  useEffect(() => {
    if (!menuFor) return
    const close = (): void => setMenuFor(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuFor])

  useEffect(() => {
    if (renamingId) renameRef.current?.select()
  }, [renamingId])

  const patch = (id: string, next: Partial<Session>): void => {
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) => (s.id === id ? { ...s, ...next } : s))
    })
  }

  const remove = (id: string): void => {
    const rest = sessions.filter((s) => s.id !== id)
    dispatch({ type: 'sessions', sessions: rest })
    // Deleting the open session would leave the chat pointing at nothing.
    if (id === activeSessionId) {
      const next = rest.find((s) => !s.archived)
      if (next) dispatch({ type: 'active', id: next.id })
      else dispatch({ type: 'screen', screen: 'new' })
    }
  }

  const commitRename = (id: string): void => {
    const title = draftTitle.trim()
    if (title) patch(id, { title })
    setRenamingId(null)
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

  const rowMenu = (s: Session): React.JSX.Element => (
    <div className="rail-menu" onClick={(e) => e.stopPropagation()}>
      <button
        className="rail-menu-item"
        onClick={() => {
          setDraftTitle(s.title)
          setRenamingId(s.id)
          setMenuFor(null)
        }}
      >
        <Pencil size={13} strokeWidth={1.8} />
        Rename
      </button>
      <button
        className="rail-menu-item"
        onClick={() => {
          patch(s.id, { pinned: !s.pinned })
          setMenuFor(null)
        }}
      >
        {s.pinned ? <PinOff size={13} strokeWidth={1.8} /> : <Pin size={13} strokeWidth={1.8} />}
        {s.pinned ? 'Unpin' : 'Pin'}
      </button>
      <button
        className="rail-menu-item"
        onClick={() => {
          patch(s.id, { archived: !s.archived, pinned: false })
          setMenuFor(null)
        }}
      >
        {s.archived ? (
          <ArchiveRestore size={13} strokeWidth={1.8} />
        ) : (
          <Archive size={13} strokeWidth={1.8} />
        )}
        {s.archived ? 'Unarchive' : 'Archive'}
      </button>
      <div className="rail-menu-sep" />
      <button
        className="rail-menu-item danger"
        onClick={() => {
          remove(s.id)
          setMenuFor(null)
        }}
      >
        <Trash2 size={13} strokeWidth={1.8} />
        Delete
      </button>
    </div>
  )

  const sessionRow = (s: Session): React.JSX.Element => (
    <div
      key={s.id}
      className="rail-session"
      data-active={s.id === activeSessionId}
      data-menu={menuFor === s.id}
      draggable={renamingId !== s.id}
      onDragStart={() => setDragId(s.id)}
      onDragEnd={() => {
        setDragId(null)
        setHovering(null)
      }}
      onClick={() => renamingId !== s.id && openSession(s.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && renamingId !== s.id && openSession(s.id)}
    >
      {s.kind === 'code' ? (
        <GitBranch size={13} strokeWidth={1.8} className="ic-code" />
      ) : (
        <MessageSquare size={13} strokeWidth={1.8} className="ic-chat" />
      )}

      {renamingId === s.id ? (
        <input
          ref={renameRef}
          className="rail-rename"
          value={draftTitle}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={() => commitRename(s.id)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitRename(s.id)
            if (e.key === 'Escape') setRenamingId(null)
          }}
        />
      ) : (
        <span className="rail-session-title">{s.title}</span>
      )}

      <button
        className="rail-session-more"
        aria-label={`Actions for ${s.title}`}
        onClick={(e) => {
          e.stopPropagation()
          setMenuFor((m) => (m === s.id ? null : s.id))
        }}
      >
        <MoreHorizontal size={14} strokeWidth={1.8} />
      </button>

      {s.busy ? <span className="rail-spinner" aria-label="busy" /> : <span className="rail-dot" />}
      {menuFor === s.id && rowMenu(s)}
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
        if (dragId) patch(dragId, { pinned: which === 'pinned', archived: false })
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
        <button
          className="rail-search"
          onClick={() => dispatch({ type: 'toggle', key: 'searchOpen', value: true })}
        >
          <Search size={13} strokeWidth={1.8} />
          <span>Search</span>
          <span className="rail-kbd mono">{KEYS.search()}</span>
        </button>
      </div>

      <div className="rail-body">
        {dest('agents', Users, 'Agents & loadouts', agents.length)}
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

        {archived.length > 0 && (
          <>
            <button
              className="rail-group"
              onClick={() => dispatch({ type: 'toggle', key: 'archOpen' })}
              aria-expanded={archOpen}
            >
              <ChevronRight size={12} strokeWidth={2} className="rail-caret" data-open={archOpen} />
              <span>Archived</span>
              <span className="rail-count mono">{archived.length}</span>
            </button>
            {archOpen && <div className="rail-drop">{archived.map(sessionRow)}</div>}
          </>
        )}
      </div>

      <AccountPopover sessionCount={live.length} />
    </aside>
  )
}
