import { Fragment, useMemo } from 'react'
import './markdown.css'

/**
 * Markdown for assistant messages.
 *
 * Hand-rolled rather than pulling in a parser, for two reasons. The renderer is
 * an Electron window, so every dependency here is one that runs with preload
 * access — a markdown parser plus a sanitiser is a large surface for what chat
 * actually needs. And the alternative shape, `dangerouslySetInnerHTML`, is the
 * thing worth avoiding outright: this returns React nodes, so model output is
 * never parsed as HTML and there is no injection path to sanitise.
 *
 * Scope is deliberately "what an assistant writes in a chat bubble": fenced and
 * inline code, headings, both list kinds, quotes, rules, tables are out. If a
 * message needs more than this it wants a document view, not a bigger bubble.
 */

/** Schemes allowed to become a real link. Everything else renders as plain text,
 *  which is what stops `javascript:` and `file:` from being clickable. */
const SAFE_SCHEME = /^(https?:|mailto:)/i

interface Block {
  kind: 'p' | 'h' | 'code' | 'quote' | 'ul' | 'ol' | 'hr'
  /** Heading level, or the ordered-list start number. */
  level?: number
  /** Language tag on a fence, shown as a label. */
  lang?: string
  lines: string[]
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks = useMemo(() => parseBlocks(text), [text])

  return (
    <div className="md">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'code':
            return (
              <pre key={i} className="md-pre">
                {block.lang && <span className="md-pre-lang mono">{block.lang}</span>}
                <code className="mono">{block.lines.join('\n')}</code>
              </pre>
            )
          case 'h': {
            // Bubbles sit inside the page's heading order, so these are styled
            // spans rather than real h1–h6 — a message must not inject itself
            // into the document outline that the screen header owns.
            return (
              <div key={i} className="md-h" data-level={block.level}>
                <Inline text={block.lines[0]} />
              </div>
            )
          }
          case 'quote':
            return (
              <blockquote key={i} className="md-quote">
                <Inline text={block.lines.join(' ')} />
              </blockquote>
            )
          case 'ul':
            return (
              <ul key={i} className="md-list">
                {block.lines.map((line, li) => (
                  <li key={li}>
                    <Inline text={line} />
                  </li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i} className="md-list" start={block.level ?? 1}>
                {block.lines.map((line, li) => (
                  <li key={li}>
                    <Inline text={line} />
                  </li>
                ))}
              </ol>
            )
          case 'hr':
            return <div key={i} className="md-hr" />
          default:
            return (
              <p key={i} className="md-p">
                <Inline text={block.lines.join('\n')} />
              </p>
            )
        }
      })}
    </div>
  )
}

/** Group lines into blocks. Fences win over everything, so a `#` or `-` inside a
 *  code block stays literal. */
function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const fence = /^\s*```+\s*(\S*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence, or end of input on an unterminated block
      blocks.push({ kind: 'code', lang: fence[1] || undefined, lines: body })
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && !/[^-*_\s]/.test(line)) {
      blocks.push({ kind: 'hr', lines: [] })
      i++
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'h', level: heading[1].length, lines: [heading[2]] })
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i++].replace(/^\s*>\s?/, ''))
      }
      blocks.push({ kind: 'quote', lines: body })
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        body.push(lines[i++].replace(/^\s*[-*+]\s+/, ''))
      }
      blocks.push({ kind: 'ul', lines: body })
      continue
    }

    const ordered = /^\s*(\d+)[.)]\s+/.exec(line)
    if (ordered) {
      const body: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        body.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))
      }
      blocks.push({ kind: 'ol', level: Number(ordered[1]), lines: body })
      continue
    }

    // Paragraph: run to the next blank line or the start of another block.
    const body: string[] = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) body.push(lines[i++])
    blocks.push({ kind: 'p', lines: body })
  }

  return blocks
}

function startsBlock(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line)
  )
}

/**
 * Inline spans. Code is matched first and its contents are never re-scanned, so
 * `**not bold**` inside backticks stays literal — the usual reason a naive
 * renderer mangles a message explaining markdown.
 */
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|(?<![\w*])[*_]([^*_\n]+?)[*_](?![\w*])|\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)|(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/

function Inline({ text }: { text: string }): React.JSX.Element {
  return <>{renderInline(text)}</>
}

function renderInline(text: string, key = 0): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let rest = text
  let n = key

  while (rest) {
    const m = INLINE.exec(rest)
    if (!m || m.index === undefined) {
      out.push(<Fragment key={n++}>{rest}</Fragment>)
      break
    }

    if (m.index > 0) out.push(<Fragment key={n++}>{rest.slice(0, m.index)}</Fragment>)

    const [full, , code, strong, strongAlt, strike, em, linkText, linkHref, bare] = m

    if (code !== undefined) {
      out.push(
        <code key={n++} className="md-code mono">
          {code}
        </code>
      )
    } else if (strong !== undefined || strongAlt !== undefined) {
      out.push(<strong key={n++}>{renderInline(strong ?? strongAlt, n * 100)}</strong>)
    } else if (strike !== undefined) {
      out.push(<s key={n++}>{renderInline(strike, n * 100)}</s>)
    } else if (em !== undefined) {
      out.push(<em key={n++}>{renderInline(em, n * 100)}</em>)
    } else if (linkHref !== undefined) {
      out.push(<Link key={n++} href={linkHref} label={linkText || linkHref} />)
    } else if (bare !== undefined) {
      out.push(<Link key={n++} href={bare} label={bare} />)
    }

    rest = rest.slice(m.index + full.length)
  }

  return out
}

/** `target="_blank"` is deliberate: both BrowserWindows install a
 *  `setWindowOpenHandler` that denies the navigation and hands the URL to
 *  `shell.openExternal`, so a link opens in the real browser and can never
 *  navigate the app out of itself. */
function Link({ href, label }: { href: string; label: string }): React.JSX.Element {
  if (!SAFE_SCHEME.test(href)) return <>{label}</>
  return (
    <a className="md-link" href={href} target="_blank" rel="noreferrer noopener" title={href}>
      {label}
    </a>
  )
}
