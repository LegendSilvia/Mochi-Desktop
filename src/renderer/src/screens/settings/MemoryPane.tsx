import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { Row, ScreenHeader, Slider, Toggle } from '@renderer/components/ui/Controls'
import { DEFAULT_RECALL_TOP_K } from '@shared/defaults'
import type { EmbedderInfo } from '@shared/types'

/**
 * Memory pane.
 *
 * Everything here is the real store now. The toggles drive the Memory config on
 * the agent (src/mastra/index.ts for the API-key backend, src/main/recall.ts for
 * the subscription), and the editor below reads and writes the same working
 * memory the agent does — not a copy, and not a list that lives in this
 * component the way the old "add a fact…" box did.
 */
export function MemoryPane(): React.JSX.Element {
  const { agents, settings, dispatch } = useStore()
  /**
   * Whose memory is on screen.
   *
   * This pane always showed `settings.defaultAgentId`, which meant every other
   * agent's memory was unreachable — you could not see what Helper knew about
   * you, let alone edit it, and the heading said "What Fraux keeps" while the
   * switches below it edited Fraux's loadout. Now that a conversation can hold
   * more than one agent, "the default one" stopped being a sensible answer to
   * "which memory".
   */
  const [viewing, setViewing] = useState(settings.defaultAgentId)
  const agent = agents.find((a) => a.id === viewing) ?? agents[0]
  /** The stored working memory, as text. Keyed reload below so switching the
   *  default agent shows that agent's memory rather than the last one's. */
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const agentId = agent?.id
  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    void window.mochi?.memoryGet(agentId).then((text) => {
      if (cancelled) return
      setDraft(text)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [agentId])
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
          {/* Only worth showing once there is a choice to make. */}
          {agents.length > 1 && (
            <section className="config-card">
              <span className="section-label">Whose memory</span>
              <Row label="Agent" hint="each one remembers you separately">
                <select
                  className="cell-select field-grow"
                  value={agent.id}
                  onChange={(e) => setViewing(e.target.value)}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </Row>
            </section>
          )}

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
            {/*
              What the agent has actually stored, not a list kept here.
              This used to be local component state with an "add a fact…" box:
              it invited you to write facts that vanished on navigation and were
              never shown to any agent. It is the real working memory now — the
              same text the agent reads before every turn and rewrites through
              `updateMemory` — so editing it here changes what it knows, and
              clearing it makes it forget.
            */}
            {!agent.workingMemory ? (
              <span className="meta">
                Working memory is off for {agent.name}, so nothing is being kept.
              </span>
            ) : (
              <>
                <textarea
                  className="field-input mem-editor"
                  rows={10}
                  value={draft}
                  placeholder={
                    loaded
                      ? 'Nothing remembered yet. It fills in as you talk, or write it yourself.'
                      : 'loading…'
                  }
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setSaved(false)
                  }}
                />
                <div className="pills">
                  <button
                    className="pill-primary"
                    onClick={() => {
                      void window.mochi?.memorySet(agent.id, draft).then((ok) => setSaved(ok))
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="pill-ghost"
                    onClick={() => {
                      setDraft('')
                      void window.mochi?.memorySet(agent.id, '').then((ok) => setSaved(ok))
                    }}
                  >
                    <Trash2 size={13} strokeWidth={1.8} /> Forget everything
                  </button>
                  {saved && <span className="meta">saved</span>}
                </div>
                <span className="meta">
                  {agent.name} reads this before every reply and updates it when you say
                  something worth keeping. Editing here is the same store.
                </span>
              </>
            )}
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
            {/* This used to warn that recall did nothing on the subscription,
                which was true until the subscription backend grew its own
                recall (src/main/recall.ts). Both backends do it now; the only
                thing that still gates it is whether anything can embed. */}
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
            {/*
              This listed every session against its raw thread id. It was a
              debugging view that survived into the product: the ids mean
              nothing to anyone using the app, the titles are already in the
              sidebar, and the list grew without bound — so the pane's most
              prominent card was the least useful thing on it.
            */}
            <span className="section-label">Where it lives</span>
            <div className="kv">
              <span className="meta">Provider</span>
              <span className="mono">{settings.storageProvider}</span>
            </div>
            {/* The table names went with the thread list, for the same reason:
                knowing a row lives in `mastra_messages` helps nobody decide
                anything. */}
            <span className="meta">
              Storage lives under your app data folder. Change the provider in Settings → Storage.
            </span>
          </section>
        </div>
      </div>
    </>
  )
}
