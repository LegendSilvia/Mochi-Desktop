import { Fragment } from 'react'

/**
 * `@name` picked out of ordinary prose.
 *
 * A tag is the one word in a message that *does* something — it decides who
 * answers next — and it read as plain text, indistinguishable from the sentence
 * around it.
 *
 * Its own module rather than living beside the markdown renderer: both the
 * assistant's markdown and the user's own bubble need it, and the bubble is
 * deliberately not markdown, since what you typed is shown back exactly as
 * typed.
 *
 * The lookbehind keeps email addresses out of it. Anything else `@word` is
 * treated as a tag: this has no roster to check against, and a false positive
 * is a slightly bolder word.
 */
const MENTION = /(?<![\w@])@([a-z0-9][\w-]*)/gi

export function withMentions(text: string, key = 0): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let n = key
  for (const m of text.matchAll(MENTION)) {
    if (m.index > last) out.push(<Fragment key={n++}>{text.slice(last, m.index)}</Fragment>)
    out.push(
      <span key={n++} className="md-mention">
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(<Fragment key={n++}>{text.slice(last)}</Fragment>)
  return out
}
