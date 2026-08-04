import type { ToolUIPart } from 'ai'
import { Check, Play, AudioLines, HelpCircle, Network, Lock, Circle, Loader } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { playSound } from '@renderer/lib/audio'
import './chat.css'

/** AI SDK tool-part states, mapped to the words the design uses. */
const TOOL_STATE_LABEL: Record<string, string> = {
  'input-streaming': 'sending',
  'input-available': 'ready',
  'approval-requested': 'waiting on you',
  'approval-responded': 'answered',
  'output-available': 'done',
  'output-error': 'failed'
}

interface StickerInput {
  sticker?: string
  caption?: string
}

interface AskInput {
  question?: string
  options?: string[]
  allowOther?: boolean
}

/** Both backends describe a task list identically — the Agent SDK's `TodoWrite`
 *  and Mastra's `task_write` share `{content, status, activeForm}` — so one card
 *  renders either. */
interface TaskItem {
  content?: string
  status?: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

/**
 * One tool call, rendered as the thing it actually is.
 *
 * Mochi's own tools are the point of the product, so they get real presentation
 * rather than a generic `name(args)` row: `sendSticker` becomes the sticker card
 * with its sound, `askUser` becomes tappable answers. Everything else — the
 * file and shell tools — falls back to a compact row.
 */
export function ToolPart({ part }: { part: ToolUIPart }): React.JSX.Element | null {
  const { stickerSrc, soundSrc, rules, settings } = useStore()
  const name = part.type.split('-').slice(1).join('-')
  const failed = part.state === 'output-error'

  // setMascotState is ambient — the mascot itself is the feedback, so a card for
  // it would just be chatter in the transcript.
  if (name === 'setMascotState') return null

  if (name === 'sendSticker') {
    const input = (part.input ?? {}) as StickerInput
    const src = stickerSrc(input.sticker ?? null)
    const rule = rules.find((r) => r.enabled && r.stickerId === input.sticker)
    const sound = soundSrc(rule?.soundId ?? null)
    return (
      <div className="sticker-card">
        <div className="sticker-frame">
          {src ? (
            <img src={src} alt={input.sticker ?? 'sticker'} />
          ) : (
            <span className="sticker-missing mono">{input.sticker ?? 'sticker'}</span>
          )}
        </div>
        {input.caption && <div className="sticker-caption">{input.caption}</div>}
        <div className="sticker-meta">
          {rule?.soundId && (
            <button
              className="sound-chip"
              // quiet: false — quiet hours exist to stop *unprompted* noise, and
              // this is the user deliberately pressing play. The global sound
              // toggle is still honoured.
              onClick={() => void playSound(sound, { enabled: settings.sound, quiet: false })}
            >
              <Play size={10} strokeWidth={2.4} />
              <span className="mono">{rule.soundId}</span>
            </button>
          )}
          {rule && (
            <span className="sticker-rule meta">
              <AudioLines size={11} strokeWidth={1.8} />
              rule: {rule.when}
            </span>
          )}
        </div>
      </div>
    )
  }

  if (name === 'delegate') {
    const input = (part.input ?? {}) as { agentId?: string; prompt?: string }
    const answer = readText(part.output)
    const running = !answer && !failed
    return (
      <div className="delegation">
        <div className="delegation-head">
          <Network size={13} strokeWidth={1.8} className="warm" />
          <span>
            delegated to <span className="mono">{input.agentId ?? 'agent'}</span>
          </span>
          <span className="session-spacer" />
          <span className="meta">{running ? 'working…' : 'done'}</span>
        </div>
        <div className="delegation-body">
          <div className="delegation-prompt">prompt → {input.prompt}</div>
          <div className="delegation-rule" />
          <div className="delegation-answer">{answer || '…'}</div>
          <div className="delegation-foot">
            <Lock size={11} strokeWidth={1.8} />
            {settings.delegationMode === 'simulated'
              ? 'simulated — answered in this same session, memory is not actually isolated'
              : `memory isolated — ${input.agentId ?? 'it'} keeps only this exchange, not your whole thread`}
          </div>
        </div>
      </div>
    )
  }

  // The agent's own task list, from either backend. Shown as a checklist rather
  // than a tool row because it is the one piece of tool output a user reads for
  // its content — it is the plan, not a call.
  if (name === 'TodoWrite' || name === 'task_write' || name === 'taskWrite') {
    const tasks = ((part.input ?? {}) as { todos?: TaskItem[]; tasks?: TaskItem[] })
    const items = tasks.todos ?? tasks.tasks ?? []
    if (items.length === 0) return null
    const done = items.filter((t) => t.status === 'completed').length
    return (
      <div className="task-card">
        <div className="task-head">
          <span>Plan</span>
          <span className="meta">
            {done}/{items.length} done
          </span>
        </div>
        <ul className="task-list">
          {items.map((task, i) => (
            <li key={i} className="task-item" data-status={task.status ?? 'pending'}>
              {task.status === 'completed' ? (
                <Check size={12} strokeWidth={2.6} />
              ) : task.status === 'in_progress' ? (
                <Loader size={12} strokeWidth={2} />
              ) : (
                <Circle size={12} strokeWidth={2} />
              )}
              {/* `activeForm` is the present-continuous wording the tools carry
                  for exactly this: the running task reads as an activity. */}
              <span>
                {task.status === 'in_progress' && task.activeForm
                  ? task.activeForm
                  : task.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // The transcript keeps only a record that the question was asked. Answering it
  // happens in the dock above the composer (`AskDock`), so that the live question
  // cannot scroll away — and so there is exactly one place to click, which is
  // what stops the same choice being submitted twice.
  if (name === 'askUser') {
    const input = (part.input ?? {}) as AskInput
    return (
      <div className="ask-record">
        <HelpCircle size={12} strokeWidth={1.9} />
        <span>{input.question ?? 'Which one?'}</span>
      </div>
    )
  }

  return (
    <div className="tool-card">
      <div className="tool-row">
        {failed ? (
          <span className="tool-x">!</span>
        ) : (
          <Check size={13} strokeWidth={2.2} className="tool-check" />
        )}
        <span className="mono tool-id">{name}</span>
        <span className="mono tool-arg">{part.input ? summarise(part.input) : ''}</span>
        <span className="mono tool-dur">{TOOL_STATE_LABEL[part.state ?? 'output-available']}</span>
      </div>
      {failed && part.errorText && <div className="tool-error mono">{part.errorText}</div>}
    </div>
  )
}

/** Tool results arrive as MCP content blocks; pull the plain text out of them. */
function readText(output: unknown): string {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output
    .map((b) => (b as { type?: string; text?: string }))
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
}

/** Tool args are shown at a glance, so prefer the one field that identifies the
 *  call (a path, a command) over dumping the whole JSON blob. */
function summarise(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input)
  const record = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'command', 'query', 'pattern', 'url']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  const json = JSON.stringify(input)
  return json.length > 80 ? `${json.slice(0, 77)}…` : json
}
