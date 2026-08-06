import { useMemo, useState } from 'react'
import { HelpCircle, Check, PenLine } from 'lucide-react'
import './chat.css'

/**
 * The questions the agent is waiting on, docked above the composer.
 *
 * This lives next to the input rather than inline in the transcript because a
 * question is a thing you are being asked *now* — scrolled off-screen it reads
 * as history, and the transcript keeps a compact record of it anyway.
 *
 * `askUser` is fire-and-forget on both backends (see `mochi-tools.ts`): the
 * agent does not suspend, so an answer is an ordinary user turn. That is why
 * `Session` derives the open set from the transcript instead of tracking it
 * here — answering appends a user message, which closes the question exactly
 * once and makes a second click impossible.
 */

export interface PendingAsk {
  /** The tool call id — stable, and what dismissal is keyed on. */
  id: string
  question: string
  options: string[]
  allowOther: boolean
  /** Whether more than one option may be picked. */
  multi: boolean
}

export function AskDock({
  asks,
  disabled,
  onAnswer,
  onSkip
}: {
  asks: PendingAsk[]
  disabled: boolean
  onAnswer: (text: string) => void
  onSkip: () => void
}): React.JSX.Element | null {
  const [picked, setPicked] = useState<Record<string, string[]>>({})

  // One single-select question is the common case, and there the click *is* the
  // answer — making it a two-step "pick then send" would be worse than what it
  // replaces. Everything else needs a compose step.
  const oneShot = asks.length === 1 && !asks[0].multi

  const ready = useMemo(
    () => asks.every((a) => (picked[a.id]?.length ?? 0) > 0),
    [asks, picked]
  )

  if (asks.length === 0) return null

  const toggle = (ask: PendingAsk, option: string): void => {
    setPicked((prev) => {
      const current = prev[ask.id] ?? []
      if (!ask.multi) return { ...prev, [ask.id]: [option] }
      return {
        ...prev,
        [ask.id]: current.includes(option)
          ? current.filter((o) => o !== option)
          : [...current, option]
      }
    })
  }

  const submit = (): void => {
    // One question keeps the bare answer, so the model sees what it would have
    // seen from a typed reply. Several need labelling or the answers arrive as
    // an unordered list with nothing to attach them to.
    const text =
      asks.length === 1
        ? (picked[asks[0].id] ?? []).join(', ')
        : asks
            .map((a) => `${a.question} — ${(picked[a.id] ?? []).join(', ')}`)
            .join('\n')
    if (!text.trim()) return
    setPicked({})
    onAnswer(text)
  }

  return (
    <div className="ask-dock" role="group" aria-label="The agent is waiting on an answer">
      {asks.map((ask) => (
        <div key={ask.id} className="ask-dock-row">
          <div className="ask-head">
            <HelpCircle size={13} strokeWidth={1.9} />
            <span>{ask.question}</span>
            {ask.multi && <span className="chip">pick any</span>}
          </div>
          <div className="ask-options">
            {ask.options.map((opt) => {
              const on = (picked[ask.id] ?? []).includes(opt)
              return (
                <button
                  key={opt}
                  className="ask-option"
                  data-on={on}
                  disabled={disabled}
                  aria-pressed={ask.multi ? on : undefined}
                  onClick={() => (oneShot ? onAnswer(opt) : toggle(ask, opt))}
                >
                  {ask.multi && on && <Check size={12} strokeWidth={2.4} />}
                  {opt}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      <div className="ask-dock-bar">
        <button className="ask-skip" onClick={onSkip}>
          <PenLine size={12} strokeWidth={1.9} />
          {/* Always offered, even when the tool said `allowOther: false`. A
              question the user genuinely cannot answer would otherwise leave the
              composer locked with no way out. */}
          {asks.some((a) => a.allowOther) ? 'Answer in my own words' : 'Skip this'}
        </button>
        <span className="composer-spacer" />
        {!oneShot && (
          <button className="pill-primary" disabled={!ready || disabled} onClick={submit}>
            Send {asks.length > 1 ? 'answers' : 'answer'}
            <Check size={13} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  )
}
