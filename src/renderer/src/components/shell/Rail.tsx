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
import { forgetMessages } from '@renderer/lib/history'
import { forgetChat } from '@renderer/lib/chatRegistry'
import { AccountPopover } from './AccountPopover'
import type { Session } from '@shared/types'

/**
 * The sidebar width, kept locally rather than in settings.
 *
 * It is a property of this screen, not of the profile: the width that suits a
 * laptop is wrong on a monitor, and settings.json is rewritten on every
 * preference change — which a drag would do sixty times a second. Losing it
 * costs one drag.
 */
const RAIL_KEY = 'mochi:rail-width'
const RAIL_DEFAULT = 248
/** Narrow enough to be mostly icons, wide enough to read a long title. Below
 *  the minimum the rows stop being legible; above the maximum the chat is the
 *  thing being squeezed. */
const RAIL_MIN = 180
const RAIL_MAX = 480

function setRailWidth(px: number): void {
  document.documentElement.style.setProperty('--rail-w', `${Math.round(px)}px`)
}

/**
 * Applied at import, before React first renders.
 *
 * In an effect it would paint at the default width and then jump, which reads
 * as the app resizing itself every time you open it.
 */
function applySavedRailWidth(): void {
  try {
    const saved = Number(localStorage.getItem(RAIL_KEY))
    if (Number.isFinite(saved) && saved > 0) {
      setRailWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, saved)))
    }
  } catch {
    // No storage, or it is full. The token default already applies.
  }
}
applySavedRailWidth()

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
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  const live = sessions.filter((s) => !s.archived)
  // Pinned respects a hand-chosen order once one exists. Anything never dragged
  // sorts by recency behind those that were, so pinning something new puts it
  // where you'd expect rather than silently at position zero.
  const pinned = live
    .filter((s) => s.pinned)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || b.updatedAt - a.updatedAt)
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

  /**
   * Drag the rail wider or narrower.
   *
   * Written straight to the CSS variable rather than through state: `--rail-w`
   * is what the rail and the tour spotlight both read, so moving it moves
   * everything at once, and a state update per pointer move would re-render the
   * whole session list sixty times a second for a number no component needs.
   *
   * The width is saved on release, not during — see `applySavedRailWidth`.
   */
  const startResize = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    // Read from the variable rather than the element: the rail's own box is
    // what we are about to change, and starting from a rounded layout width
    // would make every drag drift by a fraction of a pixel.
    const startW =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) ||
      RAIL_DEFAULT
    let latest = startW

    document.body.classList.add('rail-resizing')

    const onMove = (ev: PointerEvent): void => {
      latest = Math.min(RAIL_MAX, Math.max(RAIL_MIN, startW + (ev.clientX - startX)))
      setRailWidth(latest)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('rail-resizing')
      try {
        localStorage.setItem(RAIL_KEY, String(Math.round(latest)))
      } catch {
        // A width that fails to save is a width you set again next time.
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // Losing the pointer must not leave the whole app stuck in a resize cursor.
    window.addEventListener('pointercancel', onUp)
  }

  const patch = (id: string, next: Partial<Session>): void => {
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) => (s.id === id ? { ...s, ...next } : s))
    })
  }

  /**
   * Move `draggedId` to sit where `targetId` currently is, inside Pinned.
   *
   * Rewrites `order` across the whole group rather than nudging one value, so
   * repeated drags can't converge on equal numbers and leave the sort to break
   * ties by recency. Dragging an unpinned session onto a pinned row pins it into
   * that slot, which is the obvious reading of the gesture.
   */
  const reorderPinned = (draggedId: string, targetId: string): void => {
    if (draggedId === targetId) return
    const ids = pinned.map((s) => s.id).filter((id) => id !== draggedId)
    const at = ids.indexOf(targetId)
    if (at === -1) return
    ids.splice(at, 0, draggedId)
    const rank = new Map(ids.map((id, i) => [id, i]))
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) =>
        rank.has(s.id) ? { ...s, pinned: true, archived: false, order: rank.get(s.id) } : s
      )
    })
  }

  const endDrag = (): void => {
    setDragId(null)
    setHovering(null)
    setDropOn(null)
  }

  const remove = (id: string): void => {
    // Drop the transcript too — otherwise a deleted session leaves its whole
    // conversation behind in storage forever.
    forgetMessages(id)
    // The chat outlives the component now, so deleting a session has to say so.
    forgetChat(id)
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
      data-dragging={dragId === s.id}
      data-drop={dropOn === s.id}
      draggable={renamingId !== s.id}
      onDragStart={(e) => {
        // Chromium refuses to begin a drag unless the event carries data, so
        // without this the row never lifted at all — the reported "session
        // can't be drag". The id is the payload the drop handlers read back.
        e.dataTransfer.setData('text/plain', s.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragId(s.id)
      }}
      onDragOver={(e) => {
        // Only pinned rows are reorder targets; Recents is ordered by recency,
        // so a hand-chosen position there would be undone by the next reply.
        if (!dragId || dragId === s.id || !s.pinned) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setDropOn(s.id)
      }}
      onDragLeave={() => setDropOn((d) => (d === s.id ? null : d))}
      onDrop={(e) => {
        if (!dragId || !s.pinned) return
        e.preventDefault()
        // Stop the surrounding zone from also handling this and turning a
        // reorder into a plain re-pin.
        e.stopPropagation()
        reorderPinned(dragId, s.id)
        endDrag()
      }}
      onDragEnd={endDrag}
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
        e.dataTransfer.dropEffect = 'move'
        setHovering(which)
      }}
      onDragLeave={() => setHovering((h) => (h === which ? null : h))}
      onDrop={(e) => {
        e.preventDefault()
        // Dropping on the zone itself (not on a row) still just pins or unpins.
        // Unpinning clears `order` so the session rejoins Recents by recency
        // rather than carrying a stale rank back if it is ever pinned again.
        if (dragId) {
          patch(
            dragId,
            which === 'pinned'
              ? { pinned: true, archived: false }
              : { pinned: false, archived: false, order: undefined }
          )
        }
        endDrag()
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

      {/* Sits inside the rail rather than between panes: the rail is a flex
          item with a border, and a separate splitter element between it and the
          content would need its own column and would shift everything by its
          own width. */}
      <div
        className="rail-grip"
        role="separator"
        aria-label="Resize the sidebar"
        aria-orientation="vertical"
        onPointerDown={startResize}
      />
    </aside>
  )
}
