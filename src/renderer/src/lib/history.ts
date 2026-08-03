import type { UIMessage } from 'ai'

/**
 * Chat transcripts, per session.
 *
 * `useChat` keeps messages in memory only, so switching sessions or restarting
 * the app lost the thread — the session list survived but every conversation in
 * it came back empty.
 *
 * Stored per session rather than in the main settings file: transcripts grow
 * without bound and settings.json is rewritten on every preference change, so
 * putting them together would mean repeatedly serialising megabytes to save a
 * toggle.
 */

const KEY = (sessionId: string): string => `mochi:thread:${sessionId}`

/** Cap on stored turns. Long threads are the ones worth trimming, and the model
 *  gets its own history from Mastra memory or the Agent SDK session anyway —
 *  this store only backs what the UI redraws. */
const MAX_MESSAGES = 400

export function loadMessages(sessionId: string | undefined): UIMessage[] {
  if (!sessionId) return []
  try {
    const raw = localStorage.getItem(KEY(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as UIMessage[]) : []
  } catch {
    // A corrupt transcript should cost you that thread's scrollback, not the app.
    return []
  }
}

export function saveMessages(sessionId: string | undefined, messages: UIMessage[]): void {
  if (!sessionId) return
  try {
    if (messages.length === 0) {
      localStorage.removeItem(KEY(sessionId))
      return
    }
    localStorage.setItem(KEY(sessionId), JSON.stringify(messages.slice(-MAX_MESSAGES)))
  } catch {
    // Quota exceeded — losing scrollback is survivable, crashing the render is not.
  }
}

export function forgetMessages(sessionId: string): void {
  try {
    localStorage.removeItem(KEY(sessionId))
  } catch {
    /* nothing useful to do */
  }
}
