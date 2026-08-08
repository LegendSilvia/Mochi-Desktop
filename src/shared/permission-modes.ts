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
 * prompting session.
 *
 * That classifier is live as of Phase 2, so a named model no longer behaves as
 * Manual. It now judges each call that `assess()` in `shared/consequences.ts`
 * did not already stop, and only an explicit `allow` from it runs without a
 * card. The table's `card` is not something it can appeal, and everything else
 * it can produce — `ask`, an answer that will not parse, a timeout, a model
 * this backend cannot run — arrives at the same card Manual would have shown.
 * A named model is therefore never looser than Manual; it is only quieter about
 * the calls both would have allowed.
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
 * Which of Auto's two policies stopped a call.
 *
 * `table` is `shared/consequences.ts` — a fixed rule that applies to everyone
 * and that the classifier model was not even consulted about. `model` is the
 * model the user chose in the Auto submenu: its own judgement, or its failure
 * to give one.
 */
export type EscalationSource = 'table' | 'model'

/**
 * How a card introduces the reason it is showing.
 *
 * The design spec asks that a card say whether a *safety check* or the
 * *classifier* stopped it, and one string with one prefix cannot: "Auto stopped
 * this: it touches an SSH key" and "Auto stopped this: I am not sure what this
 * script does" read as the same kind of event, when in fact one is a rule the
 * user cannot change by picking a different model and the other is a judgement
 * that a different model might make differently.
 *
 * The fallback wording is for a card from before this was recorded — a session
 * restored from disk — where claiming either source would be inventing one.
 */
export function escalationLead(source?: EscalationSource): string {
  if (source === 'table') return 'A safety rule stopped this'
  if (source === 'model') return 'The classifier stopped this'
  return 'Auto stopped this'
}

/**
 * The hint shown for a mode — honest about whether it does anything.
 *
 * Every mode is implemented on the subscription backend (`agent-sdk-route.ts`)
 * and none of them on the Mastra/API-key backend yet — that is Phase 3. The
 * subscription hints ("edits run, commands still ask") are claims about
 * enforcement that is simply absent there, so showing them on that backend
 * told the user a mode was working when nothing was checking anything.
 * Selecting a mode there still stores it, for when Phase 3 lands — same
 * reason the Auto submenu lets you pick an inactive classifier model rather
 * than hiding it.
 */
export function modeHint(mode: PermissionMode, backend: 'subscription' | 'mastra'): string {
  if (backend === 'mastra') {
    return 'not enforced yet on this backend — Phase 3'
  }
  return MODE_HINTS[mode]
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
