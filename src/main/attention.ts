import type { BrowserWindow } from 'electron'
import { bus } from '../mastra/events'
import type { StickerEvent } from '../shared/types'

/**
 * "Is the user actually looking at Mochi?"
 *
 * The focus test has to live in main: the overlay is a `focusable: false`
 * window, so `document.hasFocus()` there is always false and the renderer cannot
 * tell being-in-the-background from being-the-overlay.
 *
 * It lives in its own module rather than inside the IPC handlers because the
 * agent route needs it too — a tool parked on an approval the user cannot see is
 * a stalled turn, and that is exactly the case where nobody is looking.
 */

let getWindow: () => BrowserWindow | null = () => null

/** Called once from `registerIpc`, which already owns the window accessor. */
export function setAttentionWindow(fn: () => BrowserWindow | null): void {
  getWindow = fn
}

export function isUserLooking(): boolean {
  const win = getWindow()
  return Boolean(win && !win.isDestroyed() && win.isFocused() && !win.isMinimized())
}

/**
 * Surface something through the mascot, but only if the user has looked away.
 *
 * Emitted on the sticker bus rather than a bespoke channel so it reaches the
 * overlay by the same path every other sticker takes and obeys the same surface
 * settings. Answers whether it actually fired.
 */
export function notifyIfAway(event: StickerEvent, caption: string): boolean {
  if (isUserLooking()) return false
  bus.emitSticker({ event, caption })
  return true
}
