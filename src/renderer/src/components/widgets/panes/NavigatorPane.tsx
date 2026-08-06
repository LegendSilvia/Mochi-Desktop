import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, ChevronDown, File, Folder, RefreshCw } from 'lucide-react'
import type { WsEntry } from '@shared/types'

/** Folders first, then files, each alphabetical. Main sorts too, but the root
 *  listing and the lazy ones take different paths into this component and both
 *  have to agree or expanding a folder would reshuffle the rows above it. */
function sortEntries(entries: WsEntry[]): WsEntry[] {
  return [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
  )
}

/**
 * The folder, one level at a time.
 *
 * Expanded lazily rather than walked up front: a real repo is tens of thousands
 * of entries, and the view shows twenty. Each directory is fetched the first
 * time it is opened and then kept, so collapsing and reopening is free.
 */
export function NavigatorPane({
  folder,
  onOpenFile
}: {
  folder: string
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const [children, setChildren] = useState<Record<string, WsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(
    async (path: string): Promise<void> => {
      // Nothing is set before this await on purpose — the mount effect calls
      // this, and a synchronous setState there cascades an extra render. The
      // "still loading" state is derived below instead: expanded, but no
      // children yet.
      const result = await window.mochi?.wsList(folder, path)
      if (!result) return
      if ('error' in result) {
        setError(result.error)
        return
      }
      setError(null)
      setChildren((c) => ({ ...c, [path]: sortEntries(result) }))
    },
    [folder]
  )

  /* The root listing, on mount.
   *
   * A `.then` rather than `void load('/')` for the same reason as the editor:
   * an async call in an effect body reads as a synchronous setState however many
   * awaits are inside it.
   *
   * A tree cached for a different repo is not stale, it is wrong — so the host
   * keys this component on the folder, and a change remounts it outright rather
   * than clearing four pieces of state by hand. */
  useEffect(() => {
    let alive = true
    void window.mochi?.wsList(folder, '').then((result) => {
      if (!alive || !result) return
      if ('error' in result) {
        setError(result.error)
        return
      }
      setError(null)
      setChildren((c) => ({ ...c, '': sortEntries(result) }))
    })
    return () => {
      alive = false
    }
  }, [folder])

  const toggle = (path: string): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!children[path]) void load(path)
      }
      return next
    })
  }

  const rows = (path: string, depth: number): React.JSX.Element[] => {
    const entries = children[path]
    if (!entries) return []
    return entries.flatMap((entry) => {
      const child = path ? `${path}/${entry.name}` : entry.name
      const isDir = entry.type === 'directory'
      const isOpen = expanded.has(child)
      const row = (
        <button
          key={child}
          className="wg-tree-row"
          data-on={selected === child}
          style={{ paddingLeft: 6 + depth * 13 }}
          onClick={() => {
            if (isDir) toggle(child)
            else {
              setSelected(child)
              onOpenFile(child)
            }
          }}
          title={child}
        >
          {isDir ? (
            isOpen ? (
              <ChevronDown size={12} strokeWidth={2} className="wg-tree-caret" />
            ) : (
              <ChevronRight size={12} strokeWidth={2} className="wg-tree-caret" />
            )
          ) : (
            <span className="wg-tree-caret" />
          )}
          {isDir ? (
            <Folder size={12} strokeWidth={1.8} className="ic-code" />
          ) : (
            <File size={12} strokeWidth={1.8} />
          )}
          <span className="wg-tree-name">{entry.name}</span>
          {isDir && isOpen && !children[child] && <span className="meta">…</span>}
        </button>
      )
      return isDir && isOpen ? [row, ...rows(child, depth + 1)] : [row]
    })
  }

  return (
    <div className="wg-tree">
      {error && <div className="wg-empty meta">{error}</div>}
      {!error && !children[''] && <div className="wg-empty meta">Reading the folder…</div>}
      {rows('', 0)}
      {children[''] && children[''].length === 0 && (
        <div className="wg-empty meta">This folder is empty.</div>
      )}
      <button
        className="wg-tree-refresh"
        onClick={() => {
          setChildren({})
          void load('')
          for (const path of expanded) if (path) void load(path)
        }}
      >
        <RefreshCw size={11} strokeWidth={2} /> Refresh
      </button>
    </div>
  )
}
