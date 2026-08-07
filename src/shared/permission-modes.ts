/**
 * The four permission modes, and what each backend calls them.
 *
 * Mochi keeps its own names rather than storing the SDK's. Storing `'default'`
 * would mean the picker says "Manual" and the settings file says something
 * else, and it stops meaning anything the day the SDK adds a mode.
 *
 * There is deliberately no bypass mode. It is the fifth entry in Claude Code's
 * own menu and the one that makes the other four decorative, so it is absent
 * from the type — which is what stops a hand-edited settings.json reaching it.
 */
export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto'

export const PERMISSION_MODES: readonly PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto']

export const MODE_LABELS: Record<PermissionMode, string> = {
  manual: 'Manual',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto'
}

export const MODE_HINTS: Record<PermissionMode, string> = {
  manual: 'every write and command stops at a card',
  acceptEdits: 'edits run, commands still ask',
  plan: 'reads and researches, changes nothing',
  auto: 'a classifier decides, dangerous calls still ask'
}

/** The Agent SDK's own vocabulary. Narrower than its `PermissionMode` by one
 *  member, because `bypassPermissions` and `dontAsk` are not reachable here. */
export type SdkPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto'

/**
 * What to pass the SDK for a mode.
 *
 * The interesting case is `auto`. With no classifier model the SDK's own native
 * classifier runs, which is what `'auto'` means to it. Naming a model instead
 * selects Mochi's classifier, which works by leaving the SDK in `'default'` and
 * answering `canUseTool` ourselves — so from the SDK's side that is an ordinary
 * prompting session. Mochi's classifier arrives in Phase 2; until then a named
 * model simply behaves as Manual, which is the safe direction to be wrong in.
 */
export function toSdkPermissionMode(
  mode: PermissionMode,
  classifierModel?: string
): SdkPermissionMode {
  switch (mode) {
    case 'acceptEdits':
      return 'acceptEdits'
    case 'plan':
      return 'plan'
    case 'auto':
      return classifierModel ? 'default' : 'auto'
    default:
      return 'default'
  }
}

/**
 * Why the native classifier cannot be used, or null when it can.
 *
 * Two reasons, and the picker shows whichever applies rather than greying the
 * row out silently — an option that is off for an unstated reason reads as a
 * bug.
 */
export function nativeAutoBlocked(opts: {
  backend: 'subscription' | 'mastra'
  supportsAutoMode?: boolean
}): string | null {
  if (opts.backend !== 'subscription') {
    return 'The native classifier belongs to the Claude Code CLI, so it needs an agent on your subscription.'
  }
  if (opts.supportsAutoMode === false) {
    return 'This model cannot run the native classifier. Pick a model below instead, or switch the agent’s model.'
  }
  return null
}

/**
 * A stored value turned into a mode.
 *
 * Anything unrecognised becomes `manual`, never a looser mode. This is the
 * check that makes the absence of bypass real: a settings.json edited by hand
 * to say `bypassPermissions` gets Manual and a warning, not what it asked for.
 */
export function coerceMode(value: unknown): PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode) ? (value as PermissionMode) : 'manual'
}

/**
 * The plan-mode workflow body.
 *
 * Replaces the CLI's default, which describes implementing a code change. The
 * CLI still wraps this with its own read-only enforcement preamble and the
 * ExitPlanMode protocol footer, so this says what a good plan *here* looks like
 * and nothing about the mechanics of staying read-only.
 */
export const PLAN_MODE_INSTRUCTIONS = [
  'Work out what the user actually wants before proposing anything. Read the',
  'code, the docs and the recent commits that bear on it.',
  '',
  'A plan is worth reading when it names the files it will touch, says what',
  'each change is for, and is honest about what it is unsure of. A plan that',
  'restates the request in more words is not a plan.',
  '',
  'If the request is ambiguous in a way that changes the work, say so and ask,',
  'rather than picking a reading and planning against it.',
  '',
  'Call ExitPlanMode when you have something worth acting on. Do not call it to',
  'ask a question — answer in the conversation instead.'
].join('\n')
