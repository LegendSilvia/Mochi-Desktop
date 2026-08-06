import { useEffect, useState } from 'react'
import { Markdown } from './Markdown'

/**
 * Text that catches up to itself.
 *
 * Even with real deltas the model does not emit one character at a time — a
 * token is often a whole word, and they arrive in bursts with gaps between, so
 * the raw stream reads as a stutter rather than as typing. This keeps a reveal
 * cursor behind the text that has actually arrived and walks it forward once
 * per frame, turning an uneven stream into an even one.
 */
function Revealing({ text }: { text: string }): React.JSX.Element {
  const [shown, setShown] = useState(0)

  /*
   * One frame is scheduled per render, and advancing the cursor re-runs this
   * effect, which schedules the next. That is the loop.
   *
   * The step is proportional to how far behind the cursor is, so a burst is
   * absorbed by speeding up rather than by falling further behind. A fixed rate
   * drifts: any burst larger than the rate is never recovered, and by the end of
   * a long reply the reveal would trail a turn that had already finished.
   */
  useEffect(() => {
    if (shown >= text.length) return
    const frame = requestAnimationFrame(() => {
      setShown((s) => Math.min(text.length, s + Math.max(1, Math.ceil((text.length - s) / 8))))
    })
    return () => cancelAnimationFrame(frame)
  }, [shown, text])

  // Sliced rather than hidden with CSS: markdown should never see half a fence,
  // and a hidden tail would still take up layout.
  return <Markdown text={text.slice(0, shown)} />
}

/**
 * @param active True only for the reply currently arriving.
 *
 * The two branches are separate components on purpose. A finished message must
 * render whole and immediately — otherwise every reply in a restored transcript
 * would type itself out again on load — and swapping components lets the
 * animation state simply cease to exist rather than needing to be reset.
 */
export function SmoothText({
  text,
  active
}: {
  text: string
  active: boolean
}): React.JSX.Element {
  return active ? <Revealing text={text} /> : <Markdown text={text} />
}
