import { useMemo, useState } from 'react'
import { Plus, Copy, Trash2, Search, Star } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { ArtPlaceholder, Row, ScreenHeader, Slider, Toggle } from '@renderer/components/ui/Controls'
import { ModelPicker } from '@renderer/components/ui/ModelPicker'
import { BLANK_AGENT } from '@shared/defaults'
import type { AgentLoadout } from '@shared/types'
import './screens.css'

/** Slugify a name into an agent id, kept unique against the existing set. */
function makeId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** Agents & loadouts. A loadout *is* an agent — there is no separate mascot entity. */
export function Agents(): React.JSX.Element {
  const { agents, settings, dispatch, spriteSrc, library } = useStore()
  const [selectedId, setSelectedId] = useState(agents[0]?.id ?? '')
  const [filter, setFilter] = useState('')
  const selected = agents.find((a) => a.id === selectedId) ?? agents[0]

  // Only one sprite folder is loaded at a time — the default agent's. Showing
  // its art on every card would be a lie about which preset each one uses.
  const loadedPreset = agents.find((a) => a.id === settings.defaultAgentId)?.spritePreset

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return agents
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q)
    )
  }, [agents, filter])

  const patch = (p: Partial<AgentLoadout>): void => {
    dispatch({
      type: 'agents',
      agents: agents.map((a) => (a.id === selected.id ? { ...a, ...p } : a))
    })
  }

  const create = (from?: AgentLoadout): void => {
    // Falls back to BLANK_AGENT rather than agents[0], so the very first loadout
    // can be built on a fresh install where there is nothing to clone.
    const template = from ?? agents[0] ?? BLANK_AGENT
    const name = from ? `${from.name} copy` : 'New agent'
    const id = makeId(name, agents.map((a) => a.id))
    // The first agent becomes the default, or nothing would be selectable on the
    // Start screen and settings.defaultAgentId would stay dangling.
    const isFirst = agents.length === 0
    const next: AgentLoadout = {
      ...template,
      id,
      name,
      isDefault: isFirst,
      ...(from ? {} : { description: BLANK_AGENT.description, instructions: '' })
    }
    dispatch({ type: 'agents', agents: [...agents, next] })
    if (isFirst) dispatch({ type: 'settings', patch: { defaultAgentId: id } })
    setSelectedId(id)
  }

  const remove = (a: AgentLoadout): void => {
    // Keep at least one agent, and never strand sessions on a missing default.
    if (agents.length <= 1) return
    const rest = agents.filter((x) => x.id !== a.id)
    if (a.isDefault || settings.defaultAgentId === a.id) {
      rest[0] = { ...rest[0], isDefault: true }
      dispatch({ type: 'settings', patch: { defaultAgentId: rest[0].id } })
    }
    dispatch({ type: 'agents', agents: rest })
    if (selectedId === a.id) setSelectedId(rest[0].id)
  }

  const makeDefault = (a: AgentLoadout): void => {
    dispatch({
      type: 'agents',
      agents: agents.map((x) => ({ ...x, isDefault: x.id === a.id }))
    })
    dispatch({ type: 'settings', patch: { defaultAgentId: a.id } })
  }

  return (
    <>
      <ScreenHeader
        title="Agents & loadouts"
        subtitle="One loadout is one agent — persona, sprite, stickers, voice, tools, model and memory in a single bundle."
        action={
          <button className="pill-primary" onClick={() => create()}>
            <Plus size={14} strokeWidth={2.2} />
            New loadout
          </button>
        }
      />
      <div className="screen-body">
        {agents.length > 5 && (
          <div className="loadout-filter">
            <Search size={13} strokeWidth={1.8} />
            <input
              className="loadout-filter-input"
              placeholder={`Filter ${agents.length} loadouts…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button className="pill-ghost tiny" onClick={() => setFilter('')}>
                clear
              </button>
            )}
          </div>
        )}

        <div className="loadout-grid">
          {shown.map((a) => (
            <div
              key={a.id}
              className="loadout-card"
              data-selected={a.id === selected.id}
              onClick={() => setSelectedId(a.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setSelectedId(a.id)}
            >
              <div className="loadout-actions" onClick={(e) => e.stopPropagation()}>
                {!a.isDefault && (
                  <button
                    className="loadout-act"
                    title="Make default"
                    aria-label={`Make ${a.name} the default agent`}
                    onClick={() => makeDefault(a)}
                  >
                    <Star size={13} strokeWidth={1.8} />
                  </button>
                )}
                <button
                  className="loadout-act"
                  title="Duplicate"
                  aria-label={`Duplicate ${a.name}`}
                  onClick={() => create(a)}
                >
                  <Copy size={13} strokeWidth={1.8} />
                </button>
                {agents.length > 1 && (
                  <button
                    className="loadout-act danger"
                    title="Delete"
                    aria-label={`Delete ${a.name}`}
                    onClick={() => remove(a)}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                )}
              </div>

              <div className="loadout-avatar">
                {a.spritePreset === loadedPreset && spriteSrc('idle') ? (
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
              <span className="meta">{a.isDefault ? 'default agent' : a.spritePreset}</span>
            </div>
          ))}
          <button className="loadout-new" onClick={() => create()}>
            <Plus size={18} strokeWidth={1.8} />
            <span>New loadout</span>
            <span className="meta">
              {agents.length === 0
                ? 'your first agent — then give it a name and instructions below'
                : 'starts from your default, then edit below'}
            </span>
          </button>
        </div>

        {shown.length === 0 && (
          <p className="meta empty-filter">No loadout matches “{filter}”.</p>
        )}

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
              <div className="field">
                <span className="field-label">Model</span>
                <ModelPicker value={selected.model} onChange={(model) => patch({ model })} />
              </div>
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
              <div className="field">
                <span className="field-label">Stickers it may send</span>
                <span className="meta">
                  {selected.allowedStickerIds?.length
                    ? `${selected.allowedStickerIds.length} picked — it will only use these`
                    : 'none picked — it may use any sticker in your folder'}
                </span>
                <div className="allow-grid">
                  {(library?.stickers ?? []).map((s) => {
                    const on = selected.allowedStickerIds?.includes(s.id) ?? false
                    return (
                      <button
                        key={s.id}
                        className="allow-tile"
                        data-on={on}
                        title={s.name}
                        aria-pressed={on}
                        onClick={() => {
                          const current = selected.allowedStickerIds ?? []
                          patch({
                            allowedStickerIds: on
                              ? current.filter((id) => id !== s.id)
                              : [...current, s.id]
                          })
                        }}
                      >
                        {s.src ? <img src={s.src} alt={s.name} /> : <span className="mono">{s.name}</span>}
                      </button>
                    )
                  })}
                </div>
                {selected.allowedStickerIds?.length ? (
                  <button className="pill-ghost tiny" onClick={() => patch({ allowedStickerIds: [] })}>
                    clear — allow any
                  </button>
                ) : null}
              </div>

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
