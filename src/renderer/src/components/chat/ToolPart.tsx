import { useState } from 'react'
import type { ToolUIPart } from 'ai'
import {
  Check,
  Play,
  AudioLines,
  HelpCircle,
  Network,
  Lock,
  Circle,
  Loader,
  ChevronRight
} from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { playSound } from '@renderer/lib/audio'
import { formatStat, hunkOf, pathOf } from '@renderer/lib/diffStat'
import { DiffBody } from './DiffBody'
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
  const running = part.state !== 'output-available' && part.state !== 'output-error'
  /** Null until the user opens or closes it themselves; their choice wins after. */
  const [openedByHand, setOpenedByHand] = useState<boolean | null>(null)

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

  // A file-writing call carries enough to show what changed. Everything else is
  // a one-line row with no body worth opening.
  const hunk = hunkOf(name, part.input)
  const stat = hunk ? formatStat(hunk) : null
  const body = hunk ?? (failed && part.errorText ? 'error' : null)

  const row = (
    <div className="tool-row">
      {failed ? (
        <span className="tool-x">!</span>
      ) : (
        <Check size={13} strokeWidth={2.2} className="tool-check" />
      )}
      <span className="mono tool-id">{name}</span>
      <span className="mono tool-arg">{part.input ? summarise(part.input) : ''}</span>
      {stat && (
        <span className="tool-stat mono">
          {hunk && hunk.added > 0 && <span className="tool-plus">+{hunk.added}</span>}
          {hunk && hunk.removed > 0 && <span className="tool-minus">−{hunk.removed}</span>}
        </span>
      )}
      <span className="mono tool-dur">{TOOL_STATE_LABEL[part.state ?? 'output-available']}</span>
    </div>
  )

  if (!body) {
    return <div className="tool-card">{row}</div>
  }

  /*
   * Open while it runs, closed once it lands.
   *
   * A tool in flight is the most interesting thing on screen — you want to see
   * what it is doing. A finished one is history, and a long run stacks enough of
   * them to bury the conversation, so it folds back to its summary where the
   * counts already say what happened.
   *
   * `open` is `null` until the user touches it, and only then does their choice
   * stick. Tracking it as "untouched" rather than as a boolean is what lets the
   * automatic behaviour apply without overriding a deliberate click.
   */
  return (
    <details
      className="tool-card tool-card-open"
      open={openedByHand ?? running}
      onToggle={(e) => setOpenedByHand(e.currentTarget.open)}
    >
      <summary className="tool-summary">
        <ChevronRight size={12} strokeWidth={2.2} className="tool-chevron" />
        {row}
      </summary>
      {hunk && (
        <DiffBody hunk={hunk} path={pathOf(part.input)} whole={name === 'Write'} />
      )}
      {failed && part.errorText && <div className="tool-error mono">{part.errorText}</div>}
    </details>
  )
}

/**
 * Everything the agent did between one reply and the next, as one card.
 *
 * A turn that reads four files, greps twice and edits one stacks seven cards
 * and buries the reply underneath them. The work is one step in the
 * conversation, so it gets one line — while it is happening the card is open so
 * you can watch, and it folds itself away once the step is done.
 *
 * Nothing is lost by folding: each call is still rendered in full inside, so a
 * diff opened from here is the same diff it would have shown on its own.
 */
export function ToolGroup({ parts }: { parts: ToolUIPart[] }): React.JSX.Element {
  const done = parts.filter(
    (p) => p.state === 'output-available' || p.state === 'output-error'
  ).length
  const running = done < parts.length
  const failed = parts.some((p) => p.state === 'output-error')
  const [openedByHand, setOpenedByHand] = useState<boolean | null>(null)

  // Distinct names in the order they ran, so the summary says what happened
  // rather than just how much of it there was.
  const names = [...new Set(parts.map((p) => p.type.split('-').slice(1).join('-')))]
  const label = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '')

  return (
    <details
      className="tool-card tool-card-open"
      open={openedByHand ?? running}
      onToggle={(e) => setOpenedByHand(e.currentTarget.open)}
    >
      <summary className="tool-summary">
        <ChevronRight size={12} strokeWidth={2.2} className="tool-chevron" />
        <div className="tool-row">
          {failed ? (
            <span className="tool-x">!</span>
          ) : running ? (
            <Loader size={13} strokeWidth={2} className="tool-check" />
          ) : (
            <Check size={13} strokeWidth={2.2} className="tool-check" />
          )}
          <span className="mono tool-id">{label}</span>
          <span className="mono tool-arg">
            {parts.length} {parts.length === 1 ? 'step' : 'steps'}
          </span>
          <span className="mono tool-dur">
            {running ? `${done}/${parts.length}` : 'done'}
          </span>
        </div>
      </summary>
      <div className="tool-group-body">
        {parts.map((p, i) => (
          <ToolPart key={p.toolCallId ?? i} part={p} />
        ))}
      </div>
    </details>
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
