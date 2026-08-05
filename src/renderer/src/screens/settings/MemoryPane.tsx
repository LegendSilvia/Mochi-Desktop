import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { Row, ScreenHeader, Slider, Toggle } from '@renderer/components/ui/Controls'
import { DEFAULT_RECALL_TOP_K } from '@shared/defaults'
import type { EmbedderInfo } from '@shared/types'

/**
 * Memory pane.
 *
 * Working-memory facts are held locally here; wiring them to Mastra's working
 * memory store is M4-03. The toggles below already drive the real Memory config
 * on the agent (see src/mastra/index.ts).
 */
export function MemoryPane(): React.JSX.Element {
  const { agents, settings, dispatch, sessions } = useStore()
  const agent = agents.find((a) => a.id === settings.defaultAgentId) ?? agents[0]
  const [facts, setFacts] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  /** Whether this machine can embed at all — the same check RAG reports. */
  const [embedder, setEmbedder] = useState<EmbedderInfo | null>(null)

  useEffect(() => {
    void window.mochi?.ragEmbedder().then(setEmbedder)
  }, [])

  // Every control below is bound to an agent. With none created yet there is
  // nothing to configure, so say that instead of dereferencing undefined.
  if (!agent) {
    return (
      <>
        <ScreenHeader title="Memory" subtitle="What an agent keeps between sessions." />
        <div className="screen-body">
          <p className="meta">
            No agents yet — create a loadout in Agents &amp; loadouts and its memory settings
            will show up here.
          </p>
        </div>
      </>
    )
  }

  const patchAgent = (p: Partial<typeof agent>): void => {
    dispatch({
      type: 'agents',
      agents: agents.map((a) => (a.id === agent.id ? { ...a, ...p } : a))
    })
  }

  return (
    <>
      <ScreenHeader title="Memory" subtitle={`What ${agent.name} keeps between sessions.`} />
      <div className="screen-body pane-cols">
        <div className="pane-col">
          <section className="config-card">
            <span className="section-label">Working memory</span>
            <Row label="Enabled" hint="facts that persist across every thread">
              <Toggle
                dense
                on={agent.workingMemory}
                onChange={(v) => patchAgent({ workingMemory: v })}
                label="Working memory"
              />
            </Row>
            {facts.map((f, i) => (
              <div className="fact-card" key={i}>
                <input
                  className="field-input"
                  value={f}
                  onChange={(e) => setFacts(facts.map((x, xi) => (xi === i ? e.target.value : x)))}
                />
                <button
                  className="tb-icon"
                  aria-label="Remove fact"
                  onClick={() => setFacts(facts.filter((_, xi) => xi !== i))}
                >
                  <Trash2 size={13} strokeWidth={1.8} />
                </button>
              </div>
            ))}
            <div className="fact-card">
              <input
                className="field-input"
                placeholder="add a fact…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.trim()) {
                    setFacts([...facts, draft.trim()])
                    setDraft('')
                  }
                }}
              />
              <button
                className="tb-icon"
                aria-label="Add fact"
                onClick={() => {
                  if (!draft.trim()) return
                  setFacts([...facts, draft.trim()])
                  setDraft('')
                }}
              >
                <Plus size={13} strokeWidth={2} />
              </button>
            </div>
          </section>

          <section className="config-card">
            <span className="section-label">Semantic recall</span>
            <Row label="Enabled" hint="finds relevant older messages by meaning">
              <Toggle
                dense
                on={agent.semanticRecall}
                onChange={(v) => patchAgent({ semanticRecall: v })}
                label="Semantic recall"
              />
            </Row>
            <Row label="Top matches" hint={`${agent.recallTopK ?? DEFAULT_RECALL_TOP_K}`}>
              <Slider
                value={agent.recallTopK ?? DEFAULT_RECALL_TOP_K}
                min={1}
                max={20}
                onChange={(v) => patchAgent({ recallTopK: v })}
                label="Top matches"
              />
            </Row>
            {/* Recall needs an embedder, and the switch alone cannot tell you
                whether one is reachable — so say it here rather than let the
                feature look on while it is quietly doing nothing. */}
            {/* Said before the embedder line, because it outranks it: an
                embedding key buys nothing here while chats run on the
                subscription, and that is worth knowing before buying one. */}
            {agent.semanticRecall && settings.preferSubscription && (
              <div className="banner-warn">
                Chats are running on your Claude subscription, and that backend keeps its own
                history — recall applies to the API-key backend. Turn off &ldquo;Run on my Claude
                subscription&rdquo; in Settings → Models to use it.
              </div>
            )}
            {agent.semanticRecall && (
              <span className="meta">
                {embedder === null
                  ? 'checking for an embedder…'
                  : embedder.ready
                    ? `Embedding with ${embedder.model} — ${embedder.detail}.`
                    : embedder.kind === 'none'
                      ? 'Off until an embedder is reachable. Anthropic has no embeddings API, so this is the one thing a Claude subscription cannot cover — set an embedding model in Settings → Models, or run Ollama locally.'
                      : // Worth quoting: this branch knows *why* it isn't ready,
                        // usually a model that hasn't been pulled yet.
                        `Off until the embedder is ready — ${embedder.detail}.`}
              </span>
            )}
          </section>
        </div>

        <div className="pane-col">
          <section className="config-card">
            <span className="section-label">Threads</span>
            {sessions.map((s) => (
              <div className="thread-row" key={s.id}>
                <span className="thread-title">{s.title}</span>
                <span className="mono meta">{s.threadId ?? 'no thread — scratch'}</span>
              </div>
            ))}
          </section>

          <section className="config-card">
            <span className="section-label">Where it lives</span>
            <div className="kv">
              <span className="meta">Provider</span>
              <span className="mono">{settings.storageProvider}</span>
            </div>
            <div className="kv">
              <span className="meta">Tables</span>
              <span className="mono">mastra_threads, mastra_messages, mastra_vectors</span>
            </div>
            <span className="meta">
              Storage lives under your app data folder. Change the provider in Settings → Storage.
            </span>
          </section>
        </div>
      </div>
    </>
  )
}
