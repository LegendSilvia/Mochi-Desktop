import { Plus, Hand } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { ArtPlaceholder } from '@renderer/components/ui/Controls'

/** Right panel of the session screen — 330px of live context. */
export function SessionPanel(): React.JSX.Element {
  const {
    activeSession,
    agentById,
    settings,
    mascotState,
    mascotNote,
    rules,
    stickerSrc,
    spriteSrc,
    fireSticker,
    dispatch
  } = useStore()

  if (!activeSession) return <aside className="session-panel" />
  const agent = agentById(activeSession.agentId)
  const armed = rules.filter((r) => r.enabled)
  const sprite = spriteSrc(mascotState)

  return (
    <aside className="session-panel">
      {/* Mascot card */}
      <section className="panel-card">
        <div className="panel-mascot">
          <div className="panel-mascot-sprite">
            {sprite ? <img src={sprite} alt="" /> : <ArtPlaceholder size={38} />}
          </div>
          <div className="panel-mascot-text">
            <span className="panel-title">{agent?.name ?? 'Mascot'}</span>
            <span className="meta">
              {mascotState} · {mascotNote}
            </span>
          </div>
          <button className="pill-ghost" onClick={() => fireSticker()}>
            <Hand size={12} strokeWidth={1.8} />
            Poke
          </button>
        </div>
        <div className="panel-chips">
          <span className="chip">chatty {agent?.chattiness ?? 0}/10</span>
          <span className="chip">stickers: {settings.mascot.stickerRate}</span>
          <span className="chip">{agent?.voiceReplies ? 'voice on' : 'voice off'}</span>
        </div>
      </section>

      {/* Agents in this session */}
      <section className="panel-card">
        <div className="panel-head">
          <span className="section-label">Agents in this session</span>
          <button
            className="panel-link"
            onClick={() => dispatch({ type: 'toggle', key: 'mentionOpen', value: true })}
          >
            <Plus size={11} strokeWidth={2} /> @agent
          </button>
        </div>
        <div className="panel-agent">
          <span className="mention-avatar">{agent?.name[0]}</span>
          <span className="panel-agent-text">
            <span className="panel-agent-name">{agent?.name}</span>
            <span className="meta">supervisor</span>
          </span>
        </div>
        {activeSession.subagentIds.map((id) => {
          const sub = agentById(id)
          if (!sub) return null
          return (
            <div className="panel-agent" key={id}>
              <span className="mention-avatar">{sub.name[0]}</span>
              <span className="panel-agent-text">
                <span className="panel-agent-name">{sub.name}</span>
                <span className="meta">subagent · memory isolated</span>
              </span>
              <span className="dot-warm" />
            </div>
          )
        })}
        <div className="panel-foot meta">max delegation steps · 10</div>
      </section>

      {/* Rules armed */}
      <section className="panel-card">
        <div className="panel-head">
          <span className="section-label">Rules armed</span>
          <span className="meta">
            {armed.length} of {rules.length}
          </span>
        </div>
        {armed.map((r) => (
          <div className="panel-rule" key={r.id}>
            <div className="panel-rule-thumb">
              {stickerSrc(r.stickerId) ? (
                <img src={stickerSrc(r.stickerId) as string} alt="" />
              ) : (
                <ArtPlaceholder size={26} />
              )}
            </div>
            <span className="panel-rule-name">{r.when}</span>
            <span className="mono panel-rule-meta">
              {r.soundId ?? '—'} · {r.showAs}
            </span>
            <span className="dot-accent" />
          </div>
        ))}
      </section>

      {/* Permissions */}
      <section className="panel-card">
        <span className="section-label">What it may do here</span>
        <div className="panel-chips">
          <span className="chip">read</span>
          <span className="chip">write</span>
          <span className="chip">run tests</span>
          <span className="chip">commit</span>
          <span className="chip forbidden">merge</span>
          <span className="chip forbidden">.env</span>
        </div>
        {!agent?.canPushWithoutAsking && (
          <div className="meta">Pushing to git always asks first.</div>
        )}
      </section>

      <div className="note-accent">
        The mascot switches to <span className="mono">work</span> while a task runs and pops a
        sticker when the branch goes green.
      </div>
    </aside>
  )
}
