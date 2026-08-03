import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { Row, ScreenHeader, Slider, Toggle } from '@renderer/components/ui/Controls'

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
  const [facts, setFacts] = useState<string[]>([
    'Prefers Windows; ships Windows builds first.',
    'Wants soft, low-contrast UI. No pure black or white.',
    'Working on Mochi, an Electron console for Mastra agents.'
  ])
  const [draft, setDraft] = useState('')
  const [topMatches, setTopMatches] = useState(5)

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
            <Row label="Top matches" hint={`${topMatches}`}>
              <Slider
                value={topMatches}
                min={1}
                max={20}
                onChange={setTopMatches}
                label="Top matches"
              />
            </Row>
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
