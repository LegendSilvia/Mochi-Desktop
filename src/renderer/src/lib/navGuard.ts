/**
 * A veto on screen changes.
 *
 * The agent editor holds edits in a draft until you press Save, which means
 * navigating away can silently discard work. Screen changes are dispatched from
 * nine different components, so checking for unsaved work at each call site
 * would mean touching all of them and would rot the moment a tenth appeared.
 *
 * Instead the store wraps its own `dispatch` and asks here before letting a
 * `screen` action through. One place to enforce it, and a screen that has
 * nothing to protect simply never registers.
 *
 * The guard returns `true` to allow the navigation and `false` to block it. It
 * is expected to be synchronous — it runs inside dispatch — so a confirmation
 * has to be a native `confirm()` rather than a custom modal.
 */

type Guard = () => boolean

let guard: Guard | null = null

export function setNavGuard(fn: Guard): void {
  guard = fn
}

/** Only clears when the caller still owns the guard, so a screen unmounting
 *  after another has already registered cannot wipe the newer one. */
export function clearNavGuard(fn: Guard): void {
  if (guard === fn) guard = null
}

export function mayLeaveScreen(): boolean {
  return guard ? guard() : true
}
