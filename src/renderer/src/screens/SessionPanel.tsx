import type { UIMessage } from 'ai'
import { Plus, Hand, Check, Loader2, FileText } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { ArtPlaceholder } from '@renderer/components/ui/Controls'

const POKE_LINES = [
  'hi hi!',
  'still here!',
  'poke received',
  'yes? yes?',
  'at your service'
]

/** Fields a tool uses to name the file it is working on. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path']

interface Activity {
  id: string
  name: string
  detail: string
  done: boolean
}

/** Every tool call in the thread, newest first — the panel's raw material. */
function readActivity(messages: UIMessage[]): Activity[] {
  const out: Activity[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (!part.type.startsWith('tool-')) continue
      const p = part as unknown as {
        type: string
        state?: string
        toolCallId?: string
        input?: Record<string, unknown>
      }
      const name = p.type.slice('tool-'.length)
      const input = p.input ?? {}
      const detail =
        PATH_KEYS.map((k) => input[k]).find((v) => typeof v === 'string') ??
        (typeof input.command === 'string' ? input.command : '') ??
        ''
      out.push({
        id: p.toolCallId ?? `${message.id}-${out.length}`,
        name,
        detail: String(detail),
        done: p.state === 'output-available' || p.state === 'output-error'
      })
    }
  }
  return out.reverse()
}

/** Right panel of the session screen — 330px of live context. */
export function SessionPanel({ messages = [] }: { messages?: UIMessage[] }): React.JSX.Element {
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
    library,
    dispatch
  } = useStore()

  if (!activeSession) return <aside className="session-panel" />
  const agent = agentById(activeSession.agentId)
  const armed = rules.filter((r) => r.enabled)
  const sprite = spriteSrc(mascotState)

  const activity = readActivity(messages)
  // Only file-shaped tools count as "touched" — a bash command that happens to
  // mention a path is not the same as the agent editing it.
  const touched = [...new Set(activity.filter((a) => a.detail.includes('/') || a.detail.includes('\\')).map((a) => a.detail))]

  /** Poke sends a real sticker. It used to call fireSticker() with no argument,
   *  which meant a null sticker id and therefore a blank card. */
  const poke = (): void => {
    const pool = library?.stickers ?? []
    const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    fireSticker({
      stickerId: pick?.id ?? null,
      caption: POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)]
    })
    dispatch({ type: 'mascot-state', state: 'done', note: 'poked!' })
  }

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
          <button className="pill-ghost" onClick={poke}>
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

      {/* Background tasks — real tool calls from this thread, newest first. */}
      {activity.length > 0 && (
        <section className="panel-card">
          <div className="panel-head">
            <span className="section-label">Background tasks</span>
            <span className="meta">{activity.filter((a) => !a.done).length} running</span>
          </div>
          {activity.slice(0, 6).map((a) => (
            <div className="panel-task" key={a.id}>
              {a.done ? (
                <Check size={13} strokeWidth={2.2} className="tool-check" />
              ) : (
                <Loader2 size={13} strokeWidth={2} className="panel-task-spin" />
              )}
              <span className="panel-task-text">
                <span className="panel-task-name">{a.name}</span>
                {a.detail && <span className="meta mono">{a.detail}</span>}
              </span>
            </div>
          ))}
        </section>
      )}

      {/* Files it touched */}
      {touched.length > 0 && (
        <section className="panel-card">
          <div className="panel-head">
            <span className="section-label">Files it touched</span>
            <span className="meta">{touched.length}</span>
          </div>
          {touched.slice(0, 8).map((f) => (
            <div className="panel-file" key={f}>
              <FileText size={12} strokeWidth={1.8} />
              <span className="mono panel-file-path" title={f}>
                {f}
              </span>
            </div>
          ))}
        </section>
      )}

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
