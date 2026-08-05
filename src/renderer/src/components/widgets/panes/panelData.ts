import type { UIMessage } from 'ai'
import { isPresentational } from '@renderer/lib/toolKinds'

/* Data the widget panes read out of the transcript.

   Split from PanelPanes.tsx because a module that exports both components and
   plain functions breaks fast refresh — and WidgetHost needs these two to
   decide which bubbles have anything to show. */

/** Fields a tool uses to name the file it is working on. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path']

interface Activity {
  id: string
  name: string
  detail: string
  done: boolean
}

/** Every tool call in the thread, newest first. */
function readActivity(messages: UIMessage[]): Activity[] {
  const out: Activity[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (!part.type.startsWith('tool-')) continue
      const p = part as unknown as {
        type: string
        state?: string
        toolCallId?: string
        input?: Record<string, unknown>
      }
      const name = p.type.slice('tool-'.length)
      const input = p.input ?? {}
      const detail =
        PATH_KEYS.map((k) => input[k]).find((v) => typeof v === 'string') ??
        (typeof input.command === 'string' ? input.command : '') ??
        ''
      out.push({
        id: p.toolCallId ?? `${message.id}-${out.length}`,
        name,
        detail: String(detail),
        done: p.state === 'output-available' || p.state === 'output-error'
      })
    }
  }
  return out.reverse()
}

/** Consecutive calls to the same tool fold into one row with a count. */
export function foldedActivity(
  messages: UIMessage[]
): Array<{ name: string; detail: string; done: boolean; count: number }> {
  return readActivity(messages)
    .filter((a) => !isPresentational(a.name))
    .reduce<Array<{ name: string; detail: string; done: boolean; count: number }>>((rows, a) => {
      const last = rows[rows.length - 1]
      if (last && last.name === a.name) {
        last.count++
        last.done = last.done && a.done
        last.detail = a.detail
        return rows
      }
      rows.push({ ...a, count: 1 })
      return rows
    }, [])
}


export interface TaskRow {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

/**
 * The agent's plan, from whichever backend produced it.
 *
 * Read off the newest write rather than accumulated: all three tools take the
 * *whole* list every time, so the last call is the current plan by definition
 * and there is nothing to reconcile.
 *
 * Three names because the two backends spell it differently — the Agent SDK's
 * `TodoWrite` and Mastra's `task_write` describe an identical list. The widget
 * previously knew only the Mastra name, so on the subscription backend it sat
 * empty while a plan was plainly running in the transcript beside it. Same set
 * the transcript's own renderer matches (see ToolPart).
 */
const TASK_TOOLS = new Set(['tool-TodoWrite', 'tool-task_write', 'tool-taskWrite'])

export function latestTasks(messages: UIMessage[]): TaskRow[] {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m].parts
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p] as unknown as {
        type: string
        input?: { todos?: TaskRow[]; tasks?: TaskRow[] }
        output?: { todos?: TaskRow[]; tasks?: TaskRow[] }
      }
      if (!TASK_TOOLS.has(part.type)) continue
      const rows =
        part.output?.todos ?? part.output?.tasks ?? part.input?.todos ?? part.input?.tasks
      if (rows?.length) return rows
    }
  }
  return []
}
