import { useEffect, useState } from 'react'
import type { Hunk } from '@renderer/lib/diffStat'

/**
 * Where a hunk sits in its file.
 *
 * The transcript carries `old_string`, not the file, so the starting line has to
 * be found by locating that text on disk. That means the number is only as true
 * as the file is now: an edit shown from a transcript restored days later may no
 * longer match, in which case this answers null and the diff renders unnumbered
 * rather than pointing at the wrong place.
 */
function startLineOf(text: string, needle: string): number | null {
  if (!needle) return null
  const at = text.indexOf(needle)
  if (at === -1) return null
  // Ambiguous match — the same snippet appears more than once, so which one was
  // edited is genuinely unknown. Better to show nothing than to guess.
  if (text.indexOf(needle, at + 1) !== -1) return null
  let line = 1
  for (let i = 0; i < at; i++) if (text[i] === '\n') line++
  return line
}

export function DiffBody({
  hunk,
  path,
  whole
}: {
  hunk: Hunk
  path: string | null
  /** True when the tool wrote the entire file, so the hunk starts at line 1 and
   *  no lookup is needed. */
  whole: boolean
}): React.JSX.Element {
  const [start, setStart] = useState<number | null>(whole ? 1 : null)

  useEffect(() => {
    if (whole || !path) return
    let live = true
    void window.mochi?.readText(path).then((text) => {
      if (!live || !text) return
      setStart(startLineOf(text, hunk.removedLines.join('\n')))
    })
    return () => {
      live = false
    }
  }, [whole, path, hunk])

  // Removed lines occupy the original numbering; added lines continue from the
  // same start, which is how a side-by-side reads as a replacement rather than
  // as two unrelated blocks.
  const num = (offset: number): string => (start === null ? '' : String(start + offset))

  return (
    <div className="tool-diff mono">
      {hunk.removedLines.map((line, i) => (
        <div className="diff-line diff-del" key={`d${i}`}>
          <span className="diff-num">{num(i)}</span>
          <span className="diff-sign">−</span>
          <span className="diff-text">{line || ' '}</span>
        </div>
      ))}
      {hunk.addedLines.map((line, i) => (
        <div className="diff-line diff-add" key={`a${i}`}>
          <span className="diff-num">{num(i)}</span>
          <span className="diff-sign">+</span>
          <span className="diff-text">{line || ' '}</span>
        </div>
      ))}
    </div>
  )
}
