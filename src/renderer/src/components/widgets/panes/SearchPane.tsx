import { useState } from 'react'
import { Search } from 'lucide-react'
import type { WsHit } from '@shared/types'

/**
 * Keyword search over the folder.
 *
 * The index is built on the first search rather than when the folder is set —
 * walking a repo costs seconds, and paying that when you open a session you
 * never search would just look like the app hanging. So the first query is slow
 * and says so, and every one after it is not.
 */
export function SearchPane({ folder }: { folder: string }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<WsHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [firstRun, setFirstRun] = useState(false)

  const run = async (): Promise<void> => {
    if (!query.trim()) return
    setBusy(true)
    setFirstRun(hits === null)
    const result = await window.mochi?.wsSearch(folder, query)
    setBusy(false)
    setFirstRun(false)
    if (!result) return
    if ('error' in result) {
      setError(result.error)
      return
    }
    setError(null)
    setHits(result.hits)
  }

  return (
    <div className="wg-search">
      <div className="wg-search-bar">
        <Search size={13} strokeWidth={1.9} />
        <input
          className="wg-search-input"
          value={query}
          placeholder="Search this folder…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
        />
        <button className="wg-btn-text primary" onClick={() => void run()} disabled={busy}>
          {busy ? '…' : 'Find'}
        </button>
      </div>

      {busy && firstRun && (
        <div className="wg-empty meta">Reading the folder for the first time…</div>
      )}
      {error && <div className="wg-empty meta">{error}</div>}
      {hits?.length === 0 && !busy && <div className="wg-empty meta">Nothing matched.</div>}

      <div className="wg-hits">
        {hits?.map((hit) => (
          <div className="wg-hit" key={hit.path}>
            <span className="mono wg-hit-path" title={hit.path}>
              {hit.path}
            </span>
            <span className="meta wg-hit-text">{hit.excerpt}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
