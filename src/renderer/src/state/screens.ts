/**
 * Screen identifiers and the gating lists.
 *
 * These live apart from `store.tsx` so that file exports only components and
 * hooks — mixing constants in breaks Fast Refresh for the whole store.
 */
export type Screen =
  | 'new'
  | 'chat'
  | 'agents'
  | 'mascot'
  | 'stickers'
  | 'models'
  | 'defaults'
  | 'memory'
  | 'rag'
  | 'tools'
  | 'channels'
  | 'voice'
  | 'workspaces'
  | 'storage'
  | 'longrun'
  | 'workflows'
  | 'browser'
  | 'ops'
  | 'notes'
  | 'overlay'

/** Screens that render inside the Settings modal rather than as destinations. */
export const SETTINGS_SCREENS: Screen[] = [
  'models',
  'defaults',
  'overlay',
  'memory',
  'rag',
  'tools',
  'channels',
  'voice',
  'workspaces',
  'storage',
  'longrun',
  'workflows',
  'browser',
  'ops',
  'notes'
]

/** Drafted in the prototype, deliberately not built. Gated behind this list. */
export const WIP_SCREENS: Screen[] = ['workflows', 'browser', 'ops']

/** Session types drafted on the start screen but not wired. */
export const WIP_SESSION_TYPES = ['supervised', 'standing'] as const

/** Said when poked while idle, as opposed to after finishing something. The
 *  fallback for a loadout with no generated poke lines of its own. */
export const POKE_LINES = [
  'hi hi!',
  'still here!',
  'poke received',
  'yes? yes?',
  'at your service'
]

export const BUBBLE_LINES = [
  'tests are green!',
  'logged it — go get coffee',
  'that one was tricky, but done',
  'i saved you 18 minutes',
  'ok. next?'
]
