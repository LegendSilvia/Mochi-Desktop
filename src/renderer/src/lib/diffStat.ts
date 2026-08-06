import type { UIMessage } from 'ai'

/**
 * What an edit actually did, read back off the tool call.
 *
 * The transcript carries the tool's *input*, not the file, so this works from
 * `old_string`/`new_string` rather than from disk. That is enough for counts and
 * for showing the hunk, and deliberately not enough for absolute line numbers:
 * locating the hunk in the file needs the file, and inventing plausible-looking
 * numbers would be worse than showing none.
 */
export interface DiffStat {
  added: number
  removed: number
}

export interface Hunk extends DiffStat {
  /** Lines pulled out, in order. */
  removedLines: string[]
  /** Lines put in, in order. */
  addedLines: string[]
}

/** Blank trailing line from a trailing newline is not a line of content. */
function lines(text: string): string[] {
  if (!text) return []
  const split = text.split('\n')
  if (split.length > 0 && split[split.length - 1] === '') split.pop()
  return split
}

interface EditInput {
  file_path?: string
  filePath?: string
  path?: string
  old_string?: string
  new_string?: string
  content?: string
  edits?: Array<{ old_string?: string; new_string?: string }>
}

export function pathOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const i = input as EditInput
  return i.file_path ?? i.filePath ?? i.path ?? null
}

/**
 * The hunk for one file-writing tool call, or null if it isn't one.
 *
 * `Write` counts its whole body as added: a write replaces the file, and we have
 * no view of what was there before, so calling the removal zero is the only
 * claim the data supports.
 */
export function hunkOf(toolName: string, input: unknown): Hunk | null {
  if (typeof input !== 'object' || input === null) return null
  const i = input as EditInput

  if (toolName === 'Write') {
    const addedLines = lines(i.content ?? '')
    if (addedLines.length === 0) return null
    return { addedLines, removedLines: [], added: addedLines.length, removed: 0 }
  }

  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    // MultiEdit carries a list; a plain Edit is the same shape with one entry.
    const edits = Array.isArray(i.edits)
      ? i.edits
      : [{ old_string: i.old_string, new_string: i.new_string }]

    const removedLines: string[] = []
    const addedLines: string[] = []
    for (const e of edits) {
      removedLines.push(...lines(e.old_string ?? ''))
      addedLines.push(...lines(e.new_string ?? ''))
    }
    if (removedLines.length === 0 && addedLines.length === 0) return null
    return {
      removedLines,
      addedLines,
      added: addedLines.length,
      removed: removedLines.length
    }
  }

  return null
}

/** `+4 −1`, or null when there is nothing to say. */
export function formatStat(stat: DiffStat): string | null {
  const parts: string[] = []
  if (stat.added > 0) parts.push(`+${stat.added}`)
  // U+2212 minus, not a hyphen — it lines up with the plus at these sizes.
  if (stat.removed > 0) parts.push(`−${stat.removed}`)
  return parts.length > 0 ? parts.join(' ') : null
}

interface ToolPartish {
  type: string
  toolCallId?: string
  input?: unknown
}

/**
 * Every file the run wrote to, with its running totals.
 *
 * Totals accumulate across calls, so a file edited four times reads as the sum
 * of all four rather than only the last one — which is what the panel's "files
 * it touched" is actually claiming.
 */
export function touchedFiles(messages: UIMessage[]): Array<{ path: string } & DiffStat> {
  const byPath = new Map<string, DiffStat>()
  const seen = new Set<string>()

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!part.type.startsWith('tool-')) continue
      const tool = part as unknown as ToolPartish
      // A tool call appears once per state transition; counting it each time
      // would multiply every total by however many renders it went through.
      if (tool.toolCallId) {
        if (seen.has(tool.toolCallId)) continue
        seen.add(tool.toolCallId)
      }
      const name = part.type.replace(/^tool-/, '')
      const path = pathOf(tool.input)
      const hunk = hunkOf(name, tool.input)
      if (!path || !hunk) continue

      const running = byPath.get(path) ?? { added: 0, removed: 0 }
      byPath.set(path, {
        added: running.added + hunk.added,
        removed: running.removed + hunk.removed
      })
    }
  }

  return [...byPath.entries()].map(([path, stat]) => ({ path, ...stat }))
}
