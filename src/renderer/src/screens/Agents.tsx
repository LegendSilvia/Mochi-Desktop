import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { ArtPlaceholder, Row, ScreenHeader, Slider, Toggle } from '@renderer/components/ui/Controls'
import type { AgentLoadout } from '@shared/types'
import './screens.css'

/** Agents & loadouts. A loadout *is* an agent — there is no separate mascot entity. */
export function Agents(): React.JSX.Element {
  const { agents, dispatch, spriteSrc } = useStore()
  const [selectedId, setSelectedId] = useState(agents[0]?.id ?? '')
  const selected = agents.find((a) => a.id === selectedId) ?? agents[0]

  const patch = (p: Partial<AgentLoadout>): void => {
    dispatch({
      type: 'agents',
      agents: agents.map((a) => (a.id === selected.id ? { ...a, ...p } : a))
    })
  }

  return (
    <>
      <ScreenHeader
        title="Agents & loadouts"
        subtitle="One loadout is one agent — persona, sprite, stickers, voice, tools, model and memory in a single bundle."
        action={
          <button className="pill-primary">
            <Plus size={14} strokeWidth={2.2} />
            New loadout
          </button>
        }
      />
      <div className="screen-body">
        <div className="loadout-grid">
          {agents.map((a) => (
            <button
              key={a.id}
              className="loadout-card"
              data-selected={a.id === selected.id}
              onClick={() => setSelectedId(a.id)}
            >
              <div className="loadout-avatar">
                {a.id === 'sprout' && spriteSrc('idle') ? (
                  <img src={spriteSrc('idle') as string} alt="" />
                ) : (
                  <span className="agent-initial big">{a.name[0]}</span>
                )}
              </div>
              <span className="loadout-name">{a.name}</span>
              <span className="agent-desc">{a.description}</span>
              <div className="agent-chips">
                <span className="chip">{a.model.split('/')[1] ?? a.model}</span>
                <span className="chip">{a.toolIds.length} tools</span>
                <span className="chip">{a.workingMemory ? 'memory' : 'no memory'}</span>
              </div>
              <span className="meta">{a.isDefault ? 'default agent' : 'idle'}</span>
            </button>
          ))}
          <button className="loadout-new">
            <Plus size={18} strokeWidth={1.8} />
            <span>New loadout</span>
            <span className="meta">pick a mascot folder, the rest fills in</span>
          </button>
        </div>

        {selected && (
          <div className="config-cols">
            <section className="config-card">
              <span className="section-label">{selected.name} — who it is</span>
              <label className="field">
                <span className="field-label">Name</span>
                <input
                  className="field-input"
                  value={selected.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Agent id</span>
                <input className="field-input mono" value={selected.id} readOnly />
              </label>
              <label className="field">
                <span className="field-label">Instructions</span>
                <textarea
                  className="field-input field-area"
                  rows={7}
                  value={selected.instructions}
                  onChange={(e) => patch({ instructions: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Expected output</span>
                <input
                  className="field-input"
                  value={selected.expectedOutput}
                  onChange={(e) => patch({ expectedOutput: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Model</span>
                <input
                  className="field-input mono"
                  value={selected.model}
                  onChange={(e) => patch({ model: e.target.value })}
                />
                <span className="meta">
                  Mastra model-router format: <span className="mono">provider/model</span>
                </span>
              </label>
            </section>

            <section className="config-card">
              <span className="section-label">How it behaves</span>
              <Row label="Chattiness" hint={`${selected.chattiness}/10`}>
                <Slider
                  value={selected.chattiness}
                  onChange={(v) => patch({ chattiness: v })}
                  label="Chattiness"
                />
              </Row>
              <Row label="Sticker frequency" hint={`${selected.stickerFrequency}/10`}>
                <Slider
                  value={selected.stickerFrequency}
                  onChange={(v) => patch({ stickerFrequency: v })}
                  label="Sticker frequency"
                />
              </Row>
              <Row label="Working memory" hint="remembers facts about you between sessions">
                <Toggle
                  on={selected.workingMemory}
                  onChange={(v) => patch({ workingMemory: v })}
                  label="Working memory"
                />
              </Row>
              <Row label="Semantic recall" hint="finds relevant older messages">
                <Toggle
                  on={selected.semanticRecall}
                  onChange={(v) => patch({ semanticRecall: v })}
                  label="Semantic recall"
                />
              </Row>
              <Row label="Voice replies">
                <Toggle
                  on={selected.voiceReplies}
                  onChange={(v) => patch({ voiceReplies: v })}
                  label="Voice replies"
                />
              </Row>
              <Row
                label="Can push to git without asking"
                hint="off by default — this one is worth keeping off"
              >
                <Toggle
                  on={selected.canPushWithoutAsking}
                  onChange={(v) => patch({ canPushWithoutAsking: v })}
                  label="Push without asking"
                />
              </Row>
              <Row label="Mascot preset" hint={`mascots/${selected.spritePreset}/`}>
                <button
                  className="pill-ghost"
                  onClick={() => dispatch({ type: 'screen', screen: 'mascot' })}
                >
                  Change
                </button>
              </Row>
            </section>
          </div>
        )}
      </div>
    </>
  )
}

export { ArtPlaceholder }
