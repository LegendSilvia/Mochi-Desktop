# Permission Modes — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four permission modes — Manual, Accept edits, Plan, Auto — selectable per session on the subscription backend, plus a Plan widget that keeps an approved plan readable after the card that gated it is gone.

**Architecture:** A `PermissionMode` type in `src/shared/` maps Mochi's mode names onto the Agent SDK's at the edge. The main process reads the mode off the *persisted session* rather than trusting the request body, passes it to `query()` at construction, and switches it mid-turn through the `liveRuns` registry that already exists for `/agent-sdk/stop`. Plan mode needs no new gate: the CLI's `ExitPlanMode` tool is not in `AUTO_APPROVED`, so it already lands in `canUseTool` and reaches the existing permission card, which grows a plan-shaped rendering. The Plan widget derives its content from the transcript, the way `TasksPane` already does.

**Tech Stack:** TypeScript, Electron, React 19, `@anthropic-ai/claude-agent-sdk`, Hono, lucide-react.

## Global Constraints

- **Bypass permissions must not be reachable.** Not in the type, not in the picker, not via a hand-edited `settings.json`. The SDK's `bypassPermissions` also requires `allowDangerouslySkipPermissions: true`, which must never be set.
- **Fail closed.** Any path that cannot decide shows the permission card. A mode that cannot be honoured falls back to `manual` and warns.
- **Mode is per session**, stored on `Session`, never global.
- **Store Mochi's names, not the SDK's.** `'manual'`, never `'default'`.
- **`AUTO_APPROVED` is not modified by this phase.** It stays the floor beneath all four modes.
- **Phase 1 is the subscription backend only.** The Mastra backend ignores mode until Phase 3. Do not add `requireToolApproval` here.
- **`npm run typecheck` and `npm run build` must pass**, and `npx eslint <changed files>` must report 0 errors. The repo has ~10.8k pre-existing CRLF prettier warnings and 2 pre-existing eslint errors in `src/renderer/src/components/shell/CommandPalette.tsx` — do not attempt to fix those, and do not run `npm run format` (it would rewrite the whole repo).
- **No test runner exists.** Pure functions are verified with a Node script under `scripts/`, run as `node scripts/<name>.mjs`. Node 26 strips TypeScript types natively, so these import the real `.ts` module via a `file:///` URL. This is the pattern already used for `src/shared/mcp.ts`.
- **Run prettier only on files you author in full**: `npx prettier --write <file>`. Surgically-edited existing files are left alone.

---

## File Structure

**Created:**

- `src/shared/permission-modes.ts` — the `PermissionMode` type, labels, the mapping onto the SDK's vocabulary, the availability rule, and the plan-mode instruction body. Pure, no imports from `main` or `renderer`.
- `scripts/check-permission-modes.mjs` — assertions against the above.
- `src/renderer/src/components/chat/ModePicker.tsx` — the composer pill and its menu, including the Auto submenu.
- `src/renderer/src/components/widgets/panes/PlanPane.tsx` — the Plan widget body.

**Modified:**

- `src/shared/types.ts` — `Session.mode`, `Session.autoClassifierModel`, `AppSettings.defaultMode`, `WidgetKind` gains `'plan'`, `SubscriptionModel` gains `supportsAutoMode`.
- `src/shared/defaults.ts` — `defaultMode: 'manual'`.
- `src/main/agent-sdk-route.ts` — mode resolution, `permissionMode` + `planModeInstructions` on the main `query()`, the `/agent-sdk/mode` endpoint, `supportsAutoMode` on the model rows.
- `src/renderer/src/screens/Session.tsx` — mount `ModePicker`, post mode changes.
- `src/renderer/src/components/chat/PermissionCard.tsx` — the plan rendering.
- `src/renderer/src/components/widgets/registry.ts` — the `plan` widget entry.
- `src/renderer/src/components/widgets/WidgetHost.tsx` — the `plan` case.
- `src/renderer/src/screens/screens.css` and `src/renderer/src/components/chat/chat.css` — styles.

---

### Task 1: The mode type and its mapping

The whole phase rests on this file, and it is the only part that can be tested without launching Electron. Nothing else in this plan may hardcode an SDK mode string.

**Files:**
- Create: `src/shared/permission-modes.ts`
- Create: `scripts/check-permission-modes.mjs`
- Modify: `src/shared/types.ts` (add to `Session`, `AppSettings`, `SubscriptionModel`)
- Modify: `src/shared/defaults.ts` (add `defaultMode`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto'`
  - `PERMISSION_MODES: readonly PermissionMode[]`
  - `MODE_LABELS: Record<PermissionMode, string>`
  - `MODE_HINTS: Record<PermissionMode, string>`
  - `type SdkPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto'`
  - `toSdkPermissionMode(mode: PermissionMode, classifierModel?: string): SdkPermissionMode`
  - `nativeAutoBlocked(opts: { backend: 'subscription' | 'mastra'; supportsAutoMode?: boolean }): string | null`
  - `coerceMode(value: unknown): PermissionMode`
  - `PLAN_MODE_INSTRUCTIONS: string`

- [ ] **Step 1: Write the failing test**

Create `scripts/check-permission-modes.mjs`:

```js
import {
  PERMISSION_MODES,
  MODE_LABELS,
  toSdkPermissionMode,
  nativeAutoBlocked,
  coerceMode
} from 'file:///C:/Development/Mochi-Desktop/src/shared/permission-modes.ts'

let fail = 0
const eq = (label, got, want) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a !== b) {
    fail++
    console.log(`FAIL ${label}\n  got  ${a}\n  want ${b}`)
  } else console.log(`ok   ${label}`)
}

// The four modes, and only the four.
eq('four modes', PERMISSION_MODES, ['manual', 'acceptEdits', 'plan', 'auto'])
eq('no bypass in the list', PERMISSION_MODES.includes('bypassPermissions'), false)
eq('every mode is labelled', PERMISSION_MODES.every((m) => Boolean(MODE_LABELS[m])), true)

// Mapping onto the SDK's vocabulary.
eq('manual maps to default', toSdkPermissionMode('manual'), 'default')
eq('acceptEdits passes through', toSdkPermissionMode('acceptEdits'), 'acceptEdits')
eq('plan passes through', toSdkPermissionMode('plan'), 'plan')
eq('auto with no model is native', toSdkPermissionMode('auto'), 'auto')
eq('auto with a model is default', toSdkPermissionMode('auto', 'anthropic/claude-sonnet-5'), 'default')
eq('an empty model string is not a model', toSdkPermissionMode('auto', ''), 'auto')

// Availability of the native classifier.
eq(
  'native auto is fine on subscription with support',
  nativeAutoBlocked({ backend: 'subscription', supportsAutoMode: true }),
  null
)
eq(
  'native auto is blocked on mastra',
  typeof nativeAutoBlocked({ backend: 'mastra' }),
  'string'
)
eq(
  'native auto is blocked when the model cannot run it',
  typeof nativeAutoBlocked({ backend: 'subscription', supportsAutoMode: false }),
  'string'
)

// Anything unrecognised is the safest mode, never the loosest.
eq('unknown coerces to manual', coerceMode('bypassPermissions'), 'manual')
eq('undefined coerces to manual', coerceMode(undefined), 'manual')
eq('a real mode survives', coerceMode('plan'), 'plan')

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-permission-modes.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` — `src/shared/permission-modes.ts` does not exist yet.

- [ ] **Step 3: Write the module**

Create `src/shared/permission-modes.ts`:

```ts
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

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'manual',
  'acceptEdits',
  'plan',
  'auto'
]

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
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `node scripts/check-permission-modes.mjs`
Expected: PASS — `all passed`, exit 0.

- [ ] **Step 5: Add the fields to the shared types**

In `src/shared/types.ts`, add the import at the top with the other type imports:

```ts
import type { PermissionMode } from './permission-modes'
```

Inside `export interface Session`, after `busy: boolean`, add:

```ts
  /**
   * What this session is allowed to do without asking.
   *
   * Per session rather than global: one session planning while another executes
   * is the normal case, not the exotic one. Absent on sessions saved before
   * this existed — the store merges shallowly and does not backfill — so every
   * reader goes through `coerceMode`.
   */
  mode?: PermissionMode
  /** Only meaningful when `mode` is `'auto'`. Absent means the native
   *  classifier; a model id means Mochi's own (Phase 2). */
  autoClassifierModel?: string
```

Inside `export interface AppSettings`, next to `skills`, add:

```ts
  /** What a newly created session starts in. */
  defaultMode: PermissionMode
```

Find `export type WidgetKind` and add `'plan'` to the union, next to `'tasks'`.

Find the `SubscriptionModel` interface and add:

```ts
  /** Whether this model can run the SDK's native Auto classifier. Off the
   *  SDK's own model list; absent on rows from a CLI too old to report it. */
  supportsAutoMode?: boolean
```

- [ ] **Step 6: Add the default**

In `src/shared/defaults.ts`, inside `DEFAULT_SETTINGS`, next to the `skills` entry:

```ts
  // Manual, because the modes that ask less are the ones a user should turn on
  // deliberately rather than discover after something has already run.
  defaultMode: 'manual',
```

- [ ] **Step 7: Verify the build**

Run: `npm run typecheck`
Expected: PASS. If `WidgetKind` errors with a missing case, that is Task 5's `WIDGETS` record — add a temporary `plan` entry there copying the `tasks` entry, and Task 5 replaces it.

- [ ] **Step 8: Commit**

```bash
git add src/shared/permission-modes.ts scripts/check-permission-modes.mjs src/shared/types.ts src/shared/defaults.ts
git commit -m "feat: four permission modes, and no way to spell the fifth"
```

---

### Task 2: The main process honours the mode

**Files:**
- Modify: `src/main/agent-sdk-route.ts`

**Interfaces:**
- Consumes: `PermissionMode`, `toSdkPermissionMode`, `coerceMode`, `PLAN_MODE_INSTRUCTIONS` from Task 1.
- Produces: `POST /agent-sdk/mode` accepting `{ id: string; mode: PermissionMode }` and answering `{ ok: boolean; live: boolean }`. `live: true` means a running turn was switched; `live: false` means it applies next turn.

- [ ] **Step 1: Add the imports**

At the top of `src/main/agent-sdk-route.ts`, beside the existing `import { mcpNameError, mcpSecretKey } from '../shared/mcp'`:

```ts
import {
  coerceMode,
  PLAN_MODE_INSTRUCTIONS,
  toSdkPermissionMode,
  type PermissionMode
} from '../shared/permission-modes'
```

- [ ] **Step 2: Add the mode resolver**

Add next to `filesystemAccess()`:

```ts
/**
 * The mode a session is in, and what to hand the SDK for it.
 *
 * Read from the persisted session, never from the request body. The body is
 * renderer-supplied, and a body that could name its own permission mode would
 * be a permission system that asks the thing being restrained what it should be
 * restrained by. The folder is already resolved this way for the same reason.
 */
function sessionMode(sessionId: string): PermissionMode {
  const { sessions, settings } = load()
  const stored = sessions.find((s) => s.id === sessionId)?.mode ?? settings.defaultMode
  const mode = coerceMode(stored)
  if (stored !== undefined && stored !== mode) {
    console.warn(`[mochi] session ${sessionId} asked for mode "${String(stored)}" — using manual`)
  }
  return mode
}
```

- [ ] **Step 3: Pass the mode to the main query**

In the `runTurn` `query({ options: … })` block, immediately after the `...filesystemAccess(),` line, add:

```ts
              // The session's mode. `allowDangerouslySkipPermissions` is never
              // set, so even a mapping bug cannot reach bypass — the SDK
              // refuses that mode without it.
              permissionMode: toSdkPermissionMode(
                sessionMode(chatId),
                load().sessions.find((s) => s.id === chatId)?.autoClassifierModel
              ),
              planModeInstructions: PLAN_MODE_INSTRUCTIONS,
```

- [ ] **Step 4: Add the mode endpoint**

Add immediately after the `app.post('/agent-sdk/stop', …)` handler, copying its shape:

```ts
  /**
   * Change a session's mode while it is running.
   *
   * The persisted session is the source of truth and the renderer has already
   * written it; this is only what makes the change take effect *now* rather
   * than on the next turn. `setPermissionMode` is streaming-input only, which
   * `inputChannel` already satisfies.
   *
   * A session with no live run is not an error — it is the ordinary case of
   * changing mode between turns, and the next `query()` reads the stored value.
   */
  app.post('/agent-sdk/mode', async (c) => {
    const { id, mode } = (await c.req.json().catch(() => ({}))) as {
      id?: string
      mode?: string
    }
    if (!id) return c.json({ ok: false, live: false }, 400)

    const wanted = coerceMode(mode)
    const run = liveRuns.get(id)
    if (!run) return c.json({ ok: true, live: false })

    try {
      const session = load().sessions.find((s) => s.id === id)
      await run.setPermissionMode(toSdkPermissionMode(wanted, session?.autoClassifierModel))
      return c.json({ ok: true, live: true })
    } catch (err) {
      // An older CLI, or a run that ended between the lookup and the call.
      // Neither is worth failing the request: the stored mode still applies to
      // the next turn.
      console.warn('[mochi] setPermissionMode failed:', err)
      return c.json({ ok: true, live: false })
    }
  })
```

- [ ] **Step 5: Report `supportsAutoMode` on the model rows**

In `listSubscriptionModels`, the `.map((m) => ({ … }))` that builds the rows currently produces `id`, `label` and `hint`. Add:

```ts
        supportsAutoMode: m.supportsAutoMode
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/main/agent-sdk-route.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/agent-sdk-route.ts
git commit -m "feat: the session's mode reaches the run, and can change mid-turn"
```

---

### Task 3: The mode picker

**Files:**
- Create: `src/renderer/src/components/chat/ModePicker.tsx`
- Modify: `src/renderer/src/screens/Session.tsx`
- Modify: `src/renderer/src/components/chat/chat.css`

**Interfaces:**
- Consumes: `PermissionMode`, `PERMISSION_MODES`, `MODE_LABELS`, `MODE_HINTS`, `nativeAutoBlocked` from Task 1; `supportsAutoMode` on the model rows from Task 2.
- Produces: `<ModePicker mode backend models currentModelId classifierModel onChange />` where `onChange(mode: PermissionMode, classifierModel?: string): void`.

- [ ] **Step 1: Write the component**

Create `src/renderer/src/components/chat/ModePicker.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, ShieldCheck } from 'lucide-react'
import {
  MODE_HINTS,
  MODE_LABELS,
  PERMISSION_MODES,
  nativeAutoBlocked,
  type PermissionMode
} from '@shared/permission-modes'
import './chat.css'

export interface ModePickerModel {
  id: string
  label: string
  supportsAutoMode?: boolean
}

/**
 * What this session is allowed to do, chosen where you are typing.
 *
 * Next to the composer rather than in Settings because it is a per-turn
 * decision: you switch to Plan because of the thing you are about to ask, and a
 * control two screens away would be one you never reach in time.
 *
 * Auto is the only row with a submenu. Leaving it on Native runs the Claude
 * Code classifier; naming a model instead runs Mochi's own, which is why the
 * model list is not filtered by `supportsAutoMode` — that flag is about the
 * native path, and a model being asked a question only has to answer one.
 */
export function ModePicker({
  mode,
  backend,
  models,
  currentModelId,
  classifierModel,
  onChange
}: {
  mode: PermissionMode
  backend: 'subscription' | 'mastra'
  models: ModePickerModel[]
  currentModelId: string
  classifierModel?: string
  onChange: (mode: PermissionMode, classifierModel?: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [autoOpen, setAutoOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // Click-away and Escape. Without these the menu survives navigating away from
  // it, which on an overlay-heavy screen leaves it floating over unrelated UI.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const supportsAutoMode = models.find((m) => m.id === currentModelId)?.supportsAutoMode
  const nativeBlocked = nativeAutoBlocked({ backend, supportsAutoMode })

  const pick = (next: PermissionMode, model?: string): void => {
    onChange(next, model)
    setOpen(false)
    setAutoOpen(false)
  }

  const summary =
    mode === 'auto' && classifierModel
      ? `${MODE_LABELS.auto} · ${models.find((m) => m.id === classifierModel)?.label ?? 'model'}`
      : MODE_LABELS[mode]

  return (
    <div className="mode-picker" ref={root}>
      <button
        className="mode-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ShieldCheck size={12} strokeWidth={1.9} />
        {summary}
      </button>

      {open && (
        <div className="mode-menu" role="menu">
          <span className="mode-menu-head">Mode</span>
          {PERMISSION_MODES.map((m, i) => {
            const isAuto = m === 'auto'
            return (
              <div key={m} className="mode-menu-item-wrap">
                <button
                  className="mode-menu-item"
                  role="menuitem"
                  data-on={mode === m}
                  onClick={() => (isAuto ? setAutoOpen((v) => !v) : pick(m))}
                >
                  <span className="mode-menu-label">{MODE_LABELS[m]}</span>
                  <span className="meta mode-menu-hint">{MODE_HINTS[m]}</span>
                  {isAuto ? (
                    <ChevronRight size={12} strokeWidth={2} />
                  ) : mode === m ? (
                    <Check size={12} strokeWidth={2.4} />
                  ) : (
                    <span className="mode-menu-key">{i + 1}</span>
                  )}
                </button>

                {isAuto && autoOpen && (
                  <div className="mode-submenu">
                    <button
                      className="mode-menu-item"
                      role="menuitem"
                      disabled={Boolean(nativeBlocked)}
                      data-on={mode === 'auto' && !classifierModel}
                      onClick={() => pick('auto')}
                    >
                      <span className="mode-menu-label">Native (Claude Code)</span>
                      {mode === 'auto' && !classifierModel && (
                        <Check size={12} strokeWidth={2.4} />
                      )}
                    </button>
                    {nativeBlocked && <p className="meta mode-blocked">{nativeBlocked}</p>}
                    <span className="mode-menu-head">Or a model of your own</span>
                    {models.map((m) => (
                      <button
                        key={m.id}
                        className="mode-menu-item"
                        role="menuitem"
                        data-on={mode === 'auto' && classifierModel === m.id}
                        onClick={() => pick('auto', m.id)}
                      >
                        <span className="mode-menu-label">{m.label}</span>
                        {mode === 'auto' && classifierModel === m.id && (
                          <Check size={12} strokeWidth={2.4} />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add the styles**

Append to `src/renderer/src/components/chat/chat.css`:

```css
.mode-picker {
  position: relative;
}
.mode-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--bg2);
  color: var(--tx2);
  font-size: 11.5px;
  cursor: pointer;
}
.mode-pill:hover {
  color: var(--tx);
}
.mode-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 30;
  min-width: 268px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.28);
}
.mode-menu-head {
  padding: 4px 8px;
  font-size: 10.5px;
  color: var(--tx3);
}
.mode-menu-item {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 2px 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  color: var(--tx);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.mode-menu-item:hover:not(:disabled) {
  background: var(--bg3, rgb(255 255 255 / 0.04));
}
.mode-menu-item:disabled {
  color: var(--tx3);
  cursor: default;
}
.mode-menu-item[data-on='true'] .mode-menu-label {
  color: var(--tx);
  font-weight: 500;
}
.mode-menu-hint {
  grid-column: 1 / -1;
  font-size: 10.5px;
}
.mode-menu-key {
  color: var(--tx3);
  font-size: 10.5px;
}
.mode-submenu {
  margin: 2px 0 4px 10px;
  padding-left: 8px;
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.mode-blocked {
  padding: 2px 8px 6px;
  color: var(--rose);
}
```

- [ ] **Step 3: Mount it in the composer**

Find the composer's control row with:

```bash
grep -n "ModelPicker\|composer-spacer\|pill-primary" src/renderer/src/screens/Session.tsx
```

It is the row holding the model picker and the send button. Add `<ModePicker … />` as its first child, so the mode sits left of the model exactly as in Claude Code. Wire it to the active session:

```tsx
<ModePicker
  mode={coerceMode(activeSession?.mode)}
  backend={
    preferSubscription && agent?.model.startsWith('anthropic/') ? 'subscription' : 'mastra'
  }
  models={subscriptionModels}
  currentModelId={agent?.model ?? ''}
  classifierModel={activeSession?.autoClassifierModel}
  onChange={setMode}
/>
```

`subscriptionModels` is the list already fetched for the model picker; if it is not in scope at this point, lift it rather than fetching twice.

- [ ] **Step 4: Write the change handler**

Add near the other session handlers in `Session.tsx`:

```tsx
  /**
   * Change the mode.
   *
   * Persisted first, because the persisted session is what the next turn reads
   * — the POST is only what makes a *running* turn switch too. Doing it the
   * other way round would leave a turn switched and the store disagreeing if
   * the write failed.
   */
  const setMode = (mode: PermissionMode, classifierModel?: string): void => {
    if (!activeSession) return
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) =>
        s.id === activeSession.id
          ? { ...s, mode, autoClassifierModel: mode === 'auto' ? classifierModel : undefined }
          : s
      )
    })
    if (!server) return
    void fetch(`${server.baseUrl}/agent-sdk/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeSession.id, mode })
    }).catch(() => {
      // No live run, or the run ended. The stored mode still applies next turn.
    })
  }
```

Add the imports at the top of `Session.tsx`:

```tsx
import { ModePicker } from '@renderer/components/chat/ModePicker'
import { coerceMode, type PermissionMode } from '@shared/permission-modes'
```

- [ ] **Step 5: Add the number shortcuts**

Locate the composer textarea with `grep -n "onKeyDown" src/renderer/src/screens/Session.tsx` and add this to its handler, before any existing Enter handling:

```tsx
    /*
     * 1–4 select a mode, but only in an empty composer.
     *
     * Without that guard the shortcut eats a digit out of every message that
     * starts with one — "1. first thing" would silently switch to Manual and
     * lose the character. An empty box is unambiguous: there is nothing there
     * a digit could belong to.
     */
    if (
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.currentTarget.value === '' &&
      /^[1-4]$/.test(e.key)
    ) {
      e.preventDefault()
      setMode(PERMISSION_MODES[Number(e.key) - 1])
      return
    }
```

Extend the Task 3 Step 4 import to carry the list:

```tsx
import { PERMISSION_MODES, coerceMode, type PermissionMode } from '@shared/permission-modes'
```

- [ ] **Step 6: Show the mode in the Permissions widget**

The spec asks for one place that answers "what is this session allowed to do right now". In `src/renderer/src/components/widgets/panes/PanelPanes.tsx`, add a `mode` prop to `PermissionsPane`:

```tsx
export function PermissionsPane({
  canPush,
  folder,
  mode
}: {
  canPush: boolean
  folder: string
  mode: PermissionMode
}): React.JSX.Element {
```

with `import { MODE_HINTS, MODE_LABELS, type PermissionMode } from '@shared/permission-modes'` at the top, and render it as the first row of the pane body:

```tsx
      <div className="rag-row">
        <span className="mono">{MODE_LABELS[mode]}</span>
        <span className="meta">{MODE_HINTS[mode]}</span>
      </div>
```

Then in `WidgetHost.tsx`, pass it: `<PermissionsPane canPush={…} folder={folder} mode={coerceMode(ctx.session?.mode)} />`. If `ctx` carries no session, thread the mode in alongside `ctx.agent` the way `folder` already is.

- [ ] **Step 7: Verify**

Run: `npx prettier --write src/renderer/src/components/chat/ModePicker.tsx`
Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/renderer/src/components/chat/ModePicker.tsx src/renderer/src/screens/Session.tsx`
Expected: no errors.

- [ ] **Step 8: Verify by hand — this needs Windows**

Run `npm run dev`. Confirm:
1. The pill reads "Manual" on a new session.
2. Opening it shows four rows and **no** bypass entry.
3. Picking Plan changes the pill and survives switching session away and back.
4. Auto expands; Native is disabled with a reason when the agent is on a non-Anthropic model.
5. Pressing `3` with an empty composer selects Plan; typing `3` into a message does not.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/chat/ModePicker.tsx src/renderer/src/components/chat/chat.css src/renderer/src/screens/Session.tsx src/renderer/src/components/widgets/
git commit -m "feat: pick what a session may do, next to where you type it"
```

---

### Task 4: The plan card

`ExitPlanMode` is not in `AUTO_APPROVED`, so it already arrives at `canUseTool` and reaches `PermissionCard` with the plan as its input. This task is a rendering change plus one extra action on approve — no new gate.

**Files:**
- Modify: `src/renderer/src/components/chat/PermissionCard.tsx`
- Modify: `src/renderer/src/components/chat/chat.css`

**Interfaces:**
- Consumes: `PermissionRequest` (existing), `Markdown` from `./Markdown`, `MODE_LABELS` from Task 1, `/agent-sdk/mode` from Task 2.
- Produces: nothing other tasks depend on. Task 5 reads the same transcript, not this component.

- [ ] **Step 1: Add the plan branch**

In `PermissionCard.tsx`, add these imports:

```tsx
import { ClipboardList } from 'lucide-react'
import { Markdown } from './Markdown'
import { MODE_LABELS, type PermissionMode } from '@shared/permission-modes'
```

Add two props to the component's signature:

```tsx
  /** The session, so approving a plan can also switch its mode. */
  sessionId?: string
  /** What approving a plan drops into. */
  planFollowOn?: PermissionMode
```

Immediately **before** the existing `if (stale || sent !== null)` block, add:

```tsx
  /*
   * A plan is not a permission question, even though it arrives as one.
   *
   * The CLI ends plan mode by calling ExitPlanMode, which lands here like any
   * other gated tool. Rendering it as "may I run ExitPlanMode" would show the
   * user a tool name and hide the only thing that matters, which is the plan
   * itself — so it gets a card of its own, and Approve does two things at once:
   * resolves the permission and moves the session out of Plan, so the agent
   * carries on in the same turn instead of waiting to be told again.
   */
  const planText = request.toolName === 'ExitPlanMode' ? planOf(request.input) : null
  if (planText && !stale && sent === null) {
    const follow = planFollowOn ?? 'acceptEdits'
    const approve = (): void => {
      if (sessionId) {
        void fetch(`${baseUrl}/agent-sdk/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, mode: follow })
        }).catch(() => {
          // The mode is still persisted by the picker's own write; worst case
          // the switch lands on the next turn rather than this one.
        })
      }
      answer('allow')
    }
    return (
      <div className="perm-card plan-card" data-done={false}>
        <div className="perm-head">
          <ClipboardList size={14} strokeWidth={1.9} />
          <span>
            <strong>{agentName ?? 'This agent'}</strong> has a plan
          </span>
        </div>
        <div className="plan-body">
          <Markdown text={planText} />
        </div>
        <div className="perm-actions">
          <button className="pill-primary" onClick={approve}>
            <Check size={13} strokeWidth={2.4} />
            Approve → {MODE_LABELS[follow]}
          </button>
          <button className="pill-ghost" onClick={() => answer('deny')}>
            <X size={13} strokeWidth={2.2} />
            Keep planning
          </button>
        </div>
      </div>
    )
  }
```

At the bottom of the file, beside `describeTarget`:

```ts
/** The plan out of an ExitPlanMode call. The SDK names the field `plan`; older
 *  CLIs have been seen to send `content`, so both are read before giving up. */
function planOf(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  for (const key of ['plan', 'content']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}
```

- [ ] **Step 2: Pass the new props where the card is used**

Find every call site with `grep -rn "<PermissionCard" src/renderer/src/` — there is one, in `Session.tsx`. Add two props to it:

```tsx
  sessionId={sessionId}
  planFollowOn="acceptEdits"
```

`acceptEdits` rather than `manual` because a plan you just read and approved is the case where you have *already* done the reviewing, and dropping into a mode that asks about every edit would make you approve the same work twice.

- [ ] **Step 3: Add the styles**

Append to `chat.css`:

```css
.plan-card {
  gap: 10px;
}
.plan-body {
  max-height: 340px;
  overflow-y: auto;
  padding: 2px 2px 2px 0;
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — Expected: PASS.
Run: `npx eslint src/renderer/src/components/chat/PermissionCard.tsx` — Expected: no errors.

- [ ] **Step 5: Verify by hand — needs Windows**

Run `npm run dev`, switch a session to Plan, and ask for something that needs a plan ("plan how to add a status bar"). Confirm the plan renders as markdown in its own card, that **Approve → Accept edits** both dismisses the card and flips the pill, and that **Keep planning** leaves the session in Plan.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/chat/PermissionCard.tsx src/renderer/src/components/chat/chat.css src/renderer/src/screens/Session.tsx
git commit -m "feat: a plan gets a card that shows the plan"
```

---

### Task 5: The Plan widget

**Files:**
- Create: `src/renderer/src/components/widgets/panes/PlanPane.tsx`
- Modify: `src/renderer/src/components/widgets/registry.ts`
- Modify: `src/renderer/src/components/widgets/WidgetHost.tsx`
- Modify: `src/renderer/src/screens/screens.css`

**Interfaces:**
- Consumes: `WidgetKind` gaining `'plan'` from Task 1; `planOf`'s field names from Task 4.
- Produces: `<PlanPane messages={UIMessage[]} />`.

- [ ] **Step 1: Write the pane**

Create `src/renderer/src/components/widgets/panes/PlanPane.tsx`:

```tsx
import { useMemo } from 'react'
import type { UIMessage, ToolUIPart } from 'ai'
import { Markdown } from '@renderer/components/chat/Markdown'

/**
 * The plan this session is working to.
 *
 * Derived from the transcript rather than held in state, the way TasksPane is:
 * the transcript is already on disk, so a plan survives a restart without a
 * second copy that can disagree with it.
 *
 * The last ExitPlanMode call wins. An agent that re-plans supersedes its own
 * earlier plan, and showing both would leave the user deciding which is live.
 */
export function PlanPane({ messages }: { messages: UIMessage[] }): React.JSX.Element {
  const plan = useMemo(() => latestPlan(messages), [messages])

  if (!plan) {
    return (
      <div className="wg-empty meta">
        No plan yet. Switch this session to Plan and ask for one.
      </div>
    )
  }

  return (
    <div className="plan-pane">
      <div className="plan-pane-status meta">
        {plan.approved ? 'Approved' : 'Proposed — waiting on you'}
      </div>
      <div className="plan-pane-body">
        <Markdown text={plan.text} />
      </div>
    </div>
  )
}

/** The most recent ExitPlanMode call, and whether it was allowed. */
function latestPlan(messages: UIMessage[]): { text: string; approved: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as ToolUIPart
      if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue
      if (part.type !== 'tool-ExitPlanMode') continue
      const input = part.input as Record<string, unknown> | undefined
      const text = ['plan', 'content']
        .map((k) => input?.[k])
        .find((v): v is string => typeof v === 'string' && Boolean(v.trim()))
      if (!text) continue
      return { text, approved: part.state === 'output-available' }
    }
  }
  return null
}
```

- [ ] **Step 2: Register the widget**

In `registry.ts`, add `ClipboardList` to the lucide import list, add the entry beside `tasks`:

```ts
  plan: { label: 'Plan', icon: ClipboardList, auto: true, size: { w: 360, h: 340 } },
```

and add `'plan'` to `PANEL_KINDS`, first — a plan is what the rest of the session is measured against:

```ts
export const PANEL_KINDS: WidgetKind[] = [
  'plan',
  'tasks',
  'activity',
  'files',
  'agents',
  'rules',
  'permissions'
]
```

- [ ] **Step 3: Render it**

In `WidgetHost.tsx`, add `PlanPane` to the panes import block and add the case beside `'tasks'`:

```tsx
      case 'plan':
        return <PlanPane messages={ctx.messages} />
```

If Task 1 Step 7 added a temporary `plan` entry to `WIDGETS`, delete it now — Step 2 is its real definition.

- [ ] **Step 4: Add the styles**

Append to `screens.css`:

```css
.plan-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
}
.plan-pane-status {
  flex: none;
}
.plan-pane-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
```

- [ ] **Step 5: Verify**

Run: `npx prettier --write src/renderer/src/components/widgets/panes/PlanPane.tsx`
Run: `npm run typecheck` — Expected: PASS.
Run: `npm run build` — Expected: builds clean.
Run: `npx eslint src/renderer/src/components/widgets/panes/PlanPane.tsx src/renderer/src/components/widgets/registry.ts src/renderer/src/components/widgets/WidgetHost.tsx` — Expected: no errors.

- [ ] **Step 6: Verify by hand — needs Windows**

Run `npm run dev`. Confirm the Plan bubble appears once a plan exists and not before, that the plan reads as markdown, that it says "Proposed" before approval and "Approved" after, and that it survives restarting the app.

- [ ] **Step 7: Run the full check and commit**

```bash
node scripts/check-permission-modes.mjs
npm run typecheck
npm run build
git add src/renderer/src/components/widgets/
git add src/renderer/src/screens/screens.css
git commit -m "feat: a plan widget, so an approved plan stays readable"
```

---

## What Phase 1 does not do

Recorded here so the next plan does not have to rediscover it:

- **Auto with a chosen model behaves as Manual.** `toSdkPermissionMode` returns `'default'` and nothing answers `canUseTool` differently yet. The picker will let you choose a model and the choice is stored; it has no effect until Phase 2 adds `src/main/classifier.ts`. Say so in the submenu if it ships before Phase 2.
- **The Mastra backend ignores mode entirely.** No `requireToolApproval`, no read-only tool map, no `proposePlan`. An API-key agent behaves exactly as it does today. Phase 3.
- **No consequence table.** Tool tags and the argument scan are Phase 2, and they are what the custom classifier's safety floor is built from.
