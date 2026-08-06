import { useCallback, useEffect, useRef, useState } from 'react'
import { FileWarning, TriangleAlert } from 'lucide-react'
import type { WsDiagnostic } from '@shared/types'

/** How long to wait after the last keystroke before asking the language server.
 *  Every request opens and syncs the document, so firing per character would
 *  keep a server permanently busy re-parsing a half-written line. */
const DIAGNOSE_MS = 600
const HOVER_MS = 320

/** What to call each way a file can be un-openable. The message underneath
 *  carries the detail; this is the one-line verdict. */
const REFUSAL_TITLE: Record<string, string> = {
  binary: 'Not a text file',
  'too-large': 'Too large to open',
  directory: 'That is a folder',
  undecodable: 'Unreadable encoding'
}

/** Turn a caret offset into the line/character LSP wants. */
function positionAt(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset)
  const line = before.split('\n').length - 1
  const character = offset - (before.lastIndexOf('\n') + 1)
  return { line, character }
}

/**
 * A file, editable.
 *
 * A textarea rather than a code editor component, deliberately: this is for
 * reading what the agent did and fixing a line, not for writing a module. What
 * it does have is the two things that make that safe — diagnostics, so a broken
 * edit is visible before saving, and a stale-write guard, so saving over the
 * agent's work fails loudly instead of silently winning.
 */
export function EditorPane({
  folder,
  path
}: {
  folder: string
  path?: string
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [mtime, setMtime] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  /** Set when the file is not editable text at all — binary, too big, or in an
   *  encoding we cannot decode. Draws a notice instead of the textarea. */
  const [refusal, setRefusal] = useState<{ error: string; kind?: string; size?: number } | null>(
    null
  )
  const [large, setLarge] = useState(false)
  const [busy, setBusy] = useState(false)
  const [diags, setDiags] = useState<WsDiagnostic[]>([])
  const [hover, setHover] = useState<string | null>(null)
  const [caret, setCaret] = useState({ line: 0, character: 0 })
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)

  const dirty = text !== saved

  /** Reads nothing into state before its first await. An effect that calls this
   *  would otherwise be setting state synchronously during the commit, which
   *  cascades a second render before the first has painted. */
  const load = useCallback(async (): Promise<void> => {
    if (!path) return
    const result = await window.mochi?.wsRead(folder, path)
    if (!result) return
    if ('error' in result) {
      // A refusal carries a `kind`; anything else is a genuine failure.
      if (result.kind) setRefusal(result)
      else setError(result.error)
      return
    }
    setRefusal(null)
    setError(null)
    setStale(false)
    setText(result.text)
    setSaved(result.text)
    setMtime(result.mtime)
    setLarge(Boolean(result.large))
  }, [folder, path])

  /*
   * The first read.
   *
   * Written as a `.then` rather than `void load()` so every state change happens
   * in a callback the linter can see is asynchronous — calling an async function
   * from an effect body reads as a synchronous setState to it, however many
   * awaits are inside.
   *
   * No reset either: WidgetHost keys this component on folder+path, so pointing
   * the editor at a different file remounts it and text, diagnostics and the
   * dirty flag all start clean by construction.
   */
  useEffect(() => {
    if (!path) return
    let alive = true
    void window.mochi?.wsRead(folder, path).then((result) => {
      if (!alive || !result) return
      if ('error' in result) {
        if (result.kind) setRefusal(result)
        else setError(result.error)
        return
      }
      setError(null)
      setStale(false)
      setText(result.text)
      setSaved(result.text)
      setMtime(result.mtime)
      setLarge(Boolean(result.large))
    })
    return () => {
      alive = false
    }
  }, [folder, path])

  // Diagnostics track the buffer, not the file on disk — squiggles for what you
  // are typing rather than what you last saved.
  useEffect(() => {
    if (!path || refusal) return
    const timer = setTimeout(() => {
      void window.mochi?.wsDiagnose(folder, path, text).then((d) => setDiags(d ?? []))
    }, DIAGNOSE_MS)
    return () => clearTimeout(timer)
  }, [folder, path, text, refusal])

  // Type information for whatever the caret is sitting on.
  useEffect(() => {
    if (!path || refusal) return
    const timer = setTimeout(() => {
      void window.mochi
        ?.wsHover(folder, path, caret.line, caret.character)
        .then((h) => setHover(h ?? null))
    }, HOVER_MS)
    return () => clearTimeout(timer)
  }, [folder, path, caret, refusal])

  const save = useCallback(async (): Promise<void> => {
    if (!path || !dirty) return
    setBusy(true)
    const result = await window.mochi?.wsWrite(folder, path, text, mtime)
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      setError(result.error)
      setStale(Boolean(result.stale))
      return
    }
    setError(null)
    setStale(false)
    setSaved(text)
    setMtime(result.mtime)
  }, [folder, path, text, mtime, dirty])

  const syncCaret = (): void => {
    const area = areaRef.current
    if (area) setCaret(positionAt(area.value, area.selectionStart))
  }

  if (!path) {
    return <div className="wg-empty meta">Pick a file in the Files widget to open it here.</div>
  }

  /*
   * Not editable text.
   *
   * Showing the decoded bytes instead would be worse than showing nothing: a
   * screen of replacement characters reads as a rendering bug, and it invites
   * you to edit and save it — which would destroy the original file.
   */
  if (refusal) {
    return (
      <div className="wg-refuse">
        <FileWarning size={22} strokeWidth={1.6} />
        <div className="wg-refuse-title">{REFUSAL_TITLE[refusal.kind ?? ''] ?? 'Cannot open'}</div>
        <div className="wg-refuse-body meta">{refusal.error}</div>
        <div className="mono wg-refuse-path">{path}</div>
        <button className="wg-btn-text" onClick={() => void load()}>
          Try again
        </button>
      </div>
    )
  }

  const lines = text.split('\n')
  const bad = new Map<number, WsDiagnostic>()
  for (const d of diags) if (!bad.has(d.line)) bad.set(d.line, d)

  return (
    <div className="wg-editor">
      <div className="wg-editor-bar">
        <span className="mono wg-editor-path" title={path}>
          {path}
        </span>
        {dirty && <span className="wg-dot" title="Unsaved changes" />}
        <span className="wg-spacer" />
        {diags.length > 0 && (
          <span className="meta wg-editor-count">
            {diags.filter((d) => d.severity === 1).length} err ·{' '}
            {diags.filter((d) => d.severity === 2).length} warn
          </span>
        )}
        <button className="wg-btn-text" onClick={() => void load()}>
          Reload
        </button>
        <button className="wg-btn-text primary" onClick={() => void save()} disabled={!dirty || busy}>
          Save
        </button>
      </div>

      {large && !error && (
        <div className="wg-editor-warn">
          <TriangleAlert size={13} strokeWidth={1.9} />
          This is a large file — editing and diagnostics may be slow.
        </div>
      )}

      {error && (
        <div className="wg-editor-err">
          {stale ? (
            <>
              This file changed on disk since you opened it — most likely the agent edited it.
              Saving would discard that.{' '}
              <button className="wg-btn-text" onClick={() => void load()}>
                Reload it
              </button>
            </>
          ) : (
            error
          )}
        </div>
      )}

      <div className="wg-editor-main">
        <div className="wg-gutter mono" ref={gutterRef}>
          {lines.map((_, i) => (
            <div key={i} className="wg-gutter-line" data-bad={bad.has(i) ? bad.get(i)!.severity : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={areaRef}
          className="wg-code mono"
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            syncCaret()
          }}
          onClick={syncCaret}
          onKeyUp={syncCaret}
          // Keeps the line numbers aligned with the text as it scrolls.
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
          }}
          onKeyDown={(e) => {
            if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void save()
            }
          }}
        />
      </div>

      {(hover || diags.length > 0) && (
        <div className="wg-editor-foot">
          {diags.length > 0 ? (
            <div className="wg-diags">
              {diags.slice(0, 6).map((d, i) => (
                <button
                  key={i}
                  className="wg-diag"
                  data-sev={d.severity}
                  onClick={() => {
                    // Put the caret on the offending line so the textarea
                    // scrolls to it — the only jump-to a plain textarea affords.
                    const area = areaRef.current
                    if (!area) return
                    const offset =
                      lines.slice(0, d.line).reduce((n, l) => n + l.length + 1, 0) + d.character
                    area.focus()
                    area.setSelectionRange(offset, offset)
                    syncCaret()
                  }}
                >
                  <span className="mono">{d.line + 1}</span> {d.message}
                </button>
              ))}
            </div>
          ) : (
            <div className="wg-hover mono">{hover}</div>
          )}
        </div>
      )}
    </div>
  )
}
