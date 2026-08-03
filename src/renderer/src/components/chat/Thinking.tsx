import type { UIMessage } from 'ai'
import './chat.css'

/**
 * Live "what is it doing right now" line.
 *
 * Without this the app looks frozen between sending and the first token — on a
 * long tool run that gap is tens of seconds and there is nothing on screen to
 * say the agent is alive. Reads the tail of the transcript rather than keeping
 * its own state, so it can never disagree with what actually happened.
 */
export function Thinking({
  messages,
  status
}: {
  messages: UIMessage[]
  status: string
}): React.JSX.Element | null {
  if (status !== 'submitted' && status !== 'streaming') return null

  return (
    <div className="thinking">
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-text">{describe(messages, status)}</span>
    </div>
  )
}

/** The most specific true thing we can say about the current moment. */
function describe(messages: UIMessage[], status: string): string {
  if (status === 'submitted') return 'reading what you said…'

  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return 'thinking…'

  // A tool that has its input but no output yet is the thing running now.
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const part = last.parts[i] as { type: string; state?: string }
    if (!part.type.startsWith('tool-')) continue
    const name = part.type.slice('tool-'.length)
    if (part.state === 'output-available' || part.state === 'output-error') break
    if (name === 'askUser') return 'putting a question together…'
    if (name === 'sendSticker') return 'picking a sticker…'
    return `running ${name}…`
  }

  const hasText = last.parts.some((p) => p.type === 'text')
  return hasText ? 'writing…' : 'thinking…'
}
