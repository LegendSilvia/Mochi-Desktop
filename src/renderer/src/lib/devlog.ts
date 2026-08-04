/**
 * The in-app debug log.
 *
 * Exists because a failed agent call currently leaves nothing to read — the two
 * open investigations (`docs/debug-missing-replies.md`,
 * `docs/debug-permission-prompt.md`) both ended at "we cannot see what the
 * backend did". This is the missing instrument.
 *
 * Deliberately a plain module-level ring buffer rather than React state:
 * entries arrive from effects, stream callbacks and IPC handlers, several per
 * second during a reply, and routing every one through a reducer would re-render
 * the whole chat to record that a token arrived. Subscribers are notified on a
 * frame boundary instead, so an open log pane repaints at most once per frame
 * and a closed one costs nothing but the push.
 *
 * Capture is gated by `arm()`, driven by `settings.devMode`. While disarmed
 * `push` returns immediately — the cost of leaving call sites in place all the
 * time is one boolean check.
 */

export type LogChannel = 'chat' | 'tool' | 'ipc' | 'state' | 'error'

export interface LogEntry {
  /** Monotonic within a session — the array index is not stable once the ring wraps. */
  seq: number
  at: number
  channel: LogChannel
  event: string
  /** Pre-flattened for display. Kept a string so a live object cannot be mutated
   *  out from under the pane after it was logged. */
  detail: string
}

/** Bounded so a long-running session cannot grow the buffer without limit. The
 *  log is for the last few minutes of behaviour, not an audit trail. */
const LIMIT = 500

let armed = false
let seq = 0
let entries: LogEntry[] = []
const listeners = new Set<() => void>()
let frame = 0

export function arm(on: boolean): void {
  if (armed === on) return
  armed = on
  if (!on) clear()
}

export function isArmed(): boolean {
  return armed
}

export function push(channel: LogChannel, event: string, detail?: unknown): void {
  if (!armed) return
  entries.push({ seq: seq++, at: Date.now(), channel, event, detail: flatten(detail) })
  if (entries.length > LIMIT) entries = entries.slice(-LIMIT)
  notify()
}

export function read(): LogEntry[] {
  return entries
}

export function clear(): void {
  entries = []
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Coalesce to one notification per frame — a stream can push far faster than a
 *  repaint is useful. */
function notify(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    for (const fn of listeners) fn()
  })
}

function flatten(detail: unknown): string {
  if (detail === undefined) return ''
  if (typeof detail === 'string') return detail
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`
  try {
    const json = JSON.stringify(detail)
    return json.length > 600 ? `${json.slice(0, 597)}…` : json
  } catch {
    // Circular, or something with a throwing getter. The event name alone still
    // tells you the thing happened, which is most of the value.
    return String(detail)
  }
}
