import { useState } from 'react'
import { Paperclip, AtSign, ArrowRight, MessageSquare, Users, Clock, Eraser } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { WIP_SESSION_TYPES } from '@renderer/state/screens'
import { Section } from '@renderer/components/ui/Controls'
import type { Session, SessionType } from '@shared/types'
import './screens.css'

const TYPES: Array<{
  value: SessionType
  label: string
  hint: string
  Icon: typeof MessageSquare
}> = [
  { value: 'normal', label: 'Normal', hint: 'talk and code in one thread', Icon: MessageSquare },
  { value: 'supervised', label: 'Supervised', hint: 'one agent delegates to others', Icon: Users },
  { value: 'standing', label: 'Standing', hint: 'runs on a schedule, reports back', Icon: Clock },
  { value: 'scratch', label: 'Scratch', hint: 'no memory, nothing saved', Icon: Eraser }
]

const isWip = (t: SessionType): boolean => (WIP_SESSION_TYPES as readonly string[]).includes(t)

/**
 * Start a session.
 *
 * An agent must be chosen before a session begins, and the default is
 * pre-selected so Start is never dead on arrival.
 */
export function NewSession(): React.JSX.Element {
  const { agents, newAgentId, newSessionType, sessions, dispatch, spriteSrc } = useStore()
  const [draft, setDraft] = useState('')
  const selected = agents.find((a) => a.id === newAgentId) ?? agents[0]

  const start = (): void => {
    const session: Session = {
      id: `s-${Date.now().toString(36)}`,
      title: draft.trim().slice(0, 48) || `new session with ${selected.name}`,
      kind: 'chat',
      type: newSessionType,
      agentId: selected.id,
      subagentIds: [],
      pinned: false,
      busy: false,
      updatedAt: Date.now(),
      // Scratch sessions save nothing, so they never get a memory thread.
      threadId: newSessionType === 'scratch' ? undefined : `t-${Date.now().toString(36)}`
    }
    dispatch({ type: 'sessions', sessions: [session, ...sessions] })
    dispatch({ type: 'active', id: session.id })
    // Hand the typed message to the chat rather than only using it as a title —
    // the session screen sends it as soon as its transport is up.
    const first = draft.trim()
    if (first) dispatch({ type: 'pending-send', text: first })
    dispatch({ type: 'screen', screen: 'chat' })
    setDraft('')
  }

  return (
    <div className="screen-body new-session">
      <div className="new-col">
        <div>
          <h1 className="new-title">Start a session</h1>
          <p className="new-sub">
            Pick who you&apos;re talking to first. You can pull in other agents later with{' '}
            <code className="mono">@</code>.
          </p>
        </div>

        <Section label="1 · Agent" hint="change your default in Settings → Defaults">
          <div className="new-agents">
            {agents.map((a) => (
              <button
                key={a.id}
                className="agent-card"
                data-selected={a.id === selected.id}
                onClick={() => dispatch({ type: 'new-agent', id: a.id })}
              >
                <div className="agent-avatar">
                  {spriteSrc('idle') && a.id === 'sprout' ? (
                    <img src={spriteSrc('idle') as string} alt="" />
                  ) : (
                    <span className="agent-initial">{a.name[0]}</span>
                  )}
                </div>
                <div className="agent-name-row">
                  <span className="agent-name">{a.name}</span>
                  {a.isDefault && <span className="badge">default</span>}
                </div>
                <span className="agent-desc">{a.description}</span>
                <div className="agent-chips">
                  <span className="chip">{a.model.split('/')[1] ?? a.model}</span>
                  <span className="chip">{a.toolIds.length} tools</span>
                </div>
              </button>
            ))}
          </div>
        </Section>

        <Section label="2 · Session type">
          <div className="new-types">
            {TYPES.map(({ value, label, hint, Icon }) => (
              <button
                key={value}
                className="type-card"
                data-selected={value === newSessionType}
                data-wip={isWip(value)}
                disabled={isWip(value)}
                title={isWip(value) ? 'Drafted, not wired yet' : undefined}
                onClick={() => dispatch({ type: 'new-type', value })}
              >
                <Icon size={17} strokeWidth={1.8} />
                <span className="type-name">
                  {label}
                  {isWip(value) && <span className="badge wip">wip</span>}
                </span>
                <span className="type-hint">{hint}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section label="3 · First message">
          <div className="composer">
            <textarea
              className="composer-input"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Same contract as the session composer: Enter commits,
                // Win/Cmd+Enter is the newline.
                if (e.key !== 'Enter' || e.metaKey) return
                e.preventDefault()
                start()
              }}
              placeholder={`What should ${selected.name} do?`}
            />
            <div className="composer-bar">
              <button className="composer-icon" aria-label="Attach a file">
                <Paperclip size={15} strokeWidth={1.8} />
              </button>
              <button className="composer-icon" aria-label="Bring in an agent">
                <AtSign size={15} strokeWidth={1.8} />
              </button>
              <span className="composer-spacer" />
              <span className="chip">{selected.model}</span>
              <button className="pill-primary" onClick={start}>
                Start
                <ArrowRight size={14} strokeWidth={2.2} />
              </button>
            </div>
          </div>
        </Section>
      </div>
    </div>
  )
}
