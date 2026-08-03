import type { ToolUIPart } from 'ai'
import { Check, Play, AudioLines, HelpCircle } from 'lucide-react'
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

/**
 * One tool call, rendered as the thing it actually is.
 *
 * Mochi's own tools are the point of the product, so they get real presentation
 * rather than a generic `name(args)` row: `sendSticker` becomes the sticker card
 * with its sound, `askUser` becomes tappable answers. Everything else — the
 * file and shell tools — falls back to a compact row.
 */
export function ToolPart({
  part,
  onChoose
}: {
  part: ToolUIPart
  onChoose: (text: string) => void
}): React.JSX.Element | null {
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

  if (name === 'askUser') {
    const input = (part.input ?? {}) as AskInput
    const options = input.options ?? []
    return (
      <div className="ask-card">
        <div className="ask-head">
          <HelpCircle size={13} strokeWidth={1.9} />
          <span>{input.question ?? 'Which one?'}</span>
        </div>
        <div className="ask-options">
          {options.map((opt) => (
            <button key={opt} className="ask-option" onClick={() => onChoose(opt)}>
              {opt}
            </button>
          ))}
        </div>
        {input.allowOther !== false && (
          <div className="ask-foot meta">or just type your own answer below</div>
        )}
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
