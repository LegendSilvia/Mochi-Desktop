import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Search as SearchIcon, FileText } from 'lucide-react'
import { ScreenHeader } from '@renderer/components/ui/Controls'
import type { EmbedderInfo, RagDoc, RagHit } from '@shared/types'

/**
 * The document library behind `searchDocs`.
 *
 * Deliberately honest about what retrieval you're actually getting: keyword
 * search works the moment a file lands, and the banner says plainly whether an
 * embedder is reachable rather than letting you assume semantic search is on
 * when it isn't.
 */
export function RagPane(): React.JSX.Element {
  const [docs, setDocs] = useState<RagDoc[]>([])
  const [embedder, setEmbedder] = useState<EmbedderInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<RagHit[] | null>(null)

  const refresh = useCallback(() => {
    void window.mochi?.ragList().then(setDocs)
    void window.mochi?.ragEmbedder().then(setEmbedder)
  }, [])

  useEffect(refresh, [refresh])

  const add = async (): Promise<void> => {
    const paths = (await window.mochi?.pickPaths('file')) ?? []
    if (paths.length === 0) return
    setBusy(true)
    setNote(null)
    try {
      const res = await window.mochi?.ragAdd(paths)
      const parts: string[] = []
      if (res?.added) parts.push(`indexed ${res.added}`)
      if (res?.skipped.length) parts.push(`skipped ${res.skipped.length}: ${res.skipped.join('; ')}`)
      setNote(parts.join(' · ') || 'nothing to do')
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const runSearch = async (): Promise<void> => {
    if (!q.trim()) return
    setHits(await (window.mochi?.ragSearch(q) ?? Promise.resolve([])))
  }

  const totalChunks = docs.reduce((n, d) => n + d.chunks, 0)
  const totalEmbedded = docs.reduce((n, d) => n + d.embedded, 0)

  return (
    <>
      <ScreenHeader
        title="Knowledge"
        subtitle="Files the agent can search before answering. Keyword search always works; embeddings add meaning-based matching on top."
        action={
          <button className="pill-primary" onClick={() => void add()} disabled={busy}>
            <Plus size={14} strokeWidth={2.2} />
            {busy ? 'Indexing…' : 'Add files'}
          </button>
        }
      />
      <div className="screen-body">
        {embedder && (
          <div className={embedder.ready ? 'note-accent' : 'banner-warn'}>
            {embedder.ready
              ? `Semantic search on — ${embedder.kind} · ${embedder.model} (${embedder.detail}).`
              : `Keyword search only — ${embedder.detail}.`}{' '}
            {totalChunks > 0 && (
              <span className="meta">
                {totalEmbedded} of {totalChunks} passages embedded.
              </span>
            )}
          </div>
        )}

        {note && <p className="meta">{note}</p>}

        <section className="config-card rag-card">
          <span className="section-label">Library</span>
          {docs.length === 0 && (
            <span className="meta">
              Nothing indexed yet. Add Markdown, text or source files — anything the agent should be
              able to look up instead of guessing.
            </span>
          )}
          {docs.map((d) => (
            <div className="rag-row" key={d.id}>
              <FileText size={13} strokeWidth={1.8} />
              <span className="rag-text">
                <span className="rag-title">{d.title}</span>
                <span className="meta mono">{d.path}</span>
              </span>
              <span className="chip">
                {d.chunks} chunk{d.chunks === 1 ? '' : 's'}
              </span>
              <span className="chip" data-dim={d.embedded === 0}>
                {d.embedded > 0 ? 'embedded' : 'keyword only'}
              </span>
              <button
                className="loadout-act danger"
                aria-label={`Remove ${d.title}`}
                onClick={() => void window.mochi?.ragRemove(d.id).then(refresh)}
              >
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            </div>
          ))}
        </section>

        <section className="config-card rag-card">
          <span className="section-label">Try a search</span>
          <div className="rag-search">
            <SearchIcon size={13} strokeWidth={1.8} />
            <input
              className="loadout-filter-input"
              placeholder="What would you ask it?"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
            />
            <button className="pill-ghost" onClick={() => void runSearch()}>
              Search
            </button>
          </div>
          {hits?.length === 0 && <p className="meta">No passages matched.</p>}
          {hits?.map((h, i) => (
            <div className="rag-hit" key={`${h.path}-${i}`}>
              <div className="rag-hit-head">
                <span className="mono">{h.title}</span>
                <span className="chip">{h.how}</span>
              </div>
              <p className="rag-hit-text">{h.text.slice(0, 320)}…</p>
            </div>
          ))}
        </section>
      </div>
    </>
  )
}
