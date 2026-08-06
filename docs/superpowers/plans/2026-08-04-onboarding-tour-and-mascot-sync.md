# Onboarding Tour + Mascot Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable slide-modal ("tour") system, use it for a 3-step first-run setup that captures the user's name and guides them to their first agent and session, and fix the mascot overlay so its settings actually take effect without an app restart.

**Architecture:** Tour steps are plain data interpreted by one `TourLayer` component; a step with a `goto` docks the card to a corner and unlocks `Next` only when its `requires` predicate passes. The mascot fix adds a `stateChanged` IPC broadcast so the overlay's separate `StoreProvider` stays in step with the app window, plus real `BrowserWindow.hide()` so "off" means off.

**Tech Stack:** Electron 39, React 19, TypeScript 5.9, electron-vite 5. No test framework.

## Global Constraints

- **No test runner exists in this repo.** There is no `test` script and no vitest/jest dependency. The approved spec accepts `npm run typecheck`, `npm run lint`, and a scripted manual pass as the verification gate. Every task below gates on those. Do **not** add a test framework as part of this plan — that is a separate decision for the repo owner.
- `npm run lint` currently reports **4 pre-existing errors** (2 in `components/shell/CommandPalette.tsx`, 1 in `screens/MascotStudio.tsx`, 1 in `screens/Session.tsx`) and ~8300 `prettier/prettier` CRLF warnings from cloning on Windows. The gate is **"no new errors, and none in files you touched"** — not a clean exit code.
- Design tokens only. Use `var(--surf)`, `var(--line)`, `var(--tx)`, `var(--tx2)`, `var(--tx3)`, `var(--ac)`, `var(--on-ac)`, `var(--shadow)`, `var(--r-card)`, `var(--r-modal)`, `var(--r-pill)`. No hard-coded hex, no pure black or white, nothing square-cornered.
- Never reintroduce the "Modernist" system (0px radius, `#ec3013`) — explicitly overridden by the user.
- Paths in main-process code are built with `join`, never hand-assembled with `/`.
- Run all commands from `C:\Development\Mochi-Desktop`.

## Deviations from the spec (deliberate, with reasons)

1. **Tour data lives at `src/renderer/src/state/tours.ts`, not `components/tour/tours.ts`.** The reducer needs the tour definitions to resolve a step's `goto` when advancing, and having `state/` import from `components/` is the wrong direction. `TourLayer` imports from `state/tours.ts`.
2. **The persist re-entrancy guard is a JSON snapshot compare, not a `fromSync` boolean.** A boolean only clears if the sync actually causes the persist effect to re-run; comparing against the last-persisted slice cannot leak a stuck flag, and it also dedupes redundant writes. Same intent, strictly safer.

---

### Task 1: Data model — new settings keys and mascot default off

**Files:**
- Modify: `src/shared/types.ts` (add to `AppSettings`, add `PersistedState`)
- Modify: `src/shared/defaults.ts` (`mascot.visible`, `userName`, `toursSeen`)
- Modify: `src/main/store.ts:11-18` (use the shared `PersistedState`)

**Interfaces:**
- Consumes: nothing.
- Produces: `AppSettings.userName: string`, `AppSettings.toursSeen: string[]`, and `PersistedState { settings, agents, sessions, rules }` exported from `@shared/types`. Tasks 2–8 all depend on these.

- [ ] **Step 1: Add the two settings keys**

In `src/shared/types.ts`, inside `interface AppSettings`, immediately after the `skills` line and before the closing brace:

```ts
  /** What agents call the user. Empty means no name is set. */
  userName: string
  /** Ids of tours already completed or skipped. */
  toursSeen: string[]
```

- [ ] **Step 2: Add the shared persisted-state type**

In `src/shared/types.ts`, directly after the `AppSettings` interface closes:

```ts
/**
 * The slice of state written to settings.json — and the payload broadcast to
 * every window when it changes, so the overlay never drifts from the app window.
 */
export interface PersistedState {
  settings: AppSettings
  agents: AgentLoadout[]
  sessions: Session[]
  rules: StickerRule[]
}
```

- [ ] **Step 3: Set the defaults**

In `src/shared/defaults.ts`, inside `DEFAULT_SETTINGS.mascot`, change:

```ts
    visible: true,
```

to:

```ts
    // Off on a fresh install: with no artwork yet the mascot renders an `art?`
    // placeholder, and a placeholder floating over the desktop is not a welcome.
    visible: false,
```

Then, in `DEFAULT_SETTINGS`, immediately after the `skills` line:

```ts
  userName: '',
  toursSeen: []
```

(The `skills` line currently ends the object without a trailing comma — add one.)

- [ ] **Step 4: Reuse the shared type in the main store**

In `src/main/store.ts`, replace lines 11–18 (the `import type` line and the local `interface Persisted`) with:

```ts
import type { PersistedState } from '../shared/types'
```

Then replace every remaining `Persisted` with `PersistedState` — there are four: the `seed()` return type, the `state` variable type, the `load()` return type, and the `save()` parameter type.

- [ ] **Step 5: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS, no output beyond the npm banner. If it fails with "Property 'userName' is missing", a `DEFAULT_SETTINGS` key was missed in Step 3.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/defaults.ts src/main/store.ts
git commit -m "feat: add userName and toursSeen settings, default mascot off"
```

---

### Task 2: Broadcast state changes to every window

**Files:**
- Modify: `src/main/ipc.ts` (add `stateChanged` channel, rewrite the `saveState` handler)
- Modify: `src/preload/index.ts` (add `onStateChanged`, fix `saveState` return type)
- Modify: `src/renderer/src/state/context.ts` (add the `sync` action)
- Modify: `src/renderer/src/state/store.tsx` (reducer case, listener, persist guard)

**Interfaces:**
- Consumes: `PersistedState` from Task 1.
- Produces: `window.mochi.onStateChanged(cb) => () => void`, and a `{ type: 'sync'; payload: PersistedState }` action. Task 3 adds the `setMascotVisible` call into the same `saveState` handler.

- [ ] **Step 1: Add the channel**

In `src/main/ipc.ts`, in the `IPC` object under the `// main → renderer` comment, after `mascotState`:

```ts
  mascotState: 'mochi:mascot-state',
  stateChanged: 'mochi:state-changed'
```

- [ ] **Step 2: Broadcast on save**

In `src/main/ipc.ts`, replace line 63:

```ts
  ipcMain.handle(IPC.saveState, (_e, patch) => save(patch))
```

with:

```ts
  /**
   * Persist, then tell the *other* windows.
   *
   * The overlay is a second window with its own store, seeded once at mount —
   * without this broadcast every settings change (mascot visibility, shell, size,
   * theme, accent) sat unseen there until the app was restarted.
   */
  ipcMain.handle(IPC.saveState, (e, patch) => {
    const next = save(patch)
    for (const win of [getWindow(), getMascotWindow()]) {
      if (!win || win.isDestroyed()) continue
      // Skip the sender: it already has this state, and echoing it back is how
      // a save loop starts.
      if (win.webContents.id === e.sender.id) continue
      win.webContents.send(IPC.stateChanged, next)
    }
    return next
  })
```

- [ ] **Step 3: Expose it in the preload bridge**

In `src/preload/index.ts`, add `PersistedState` to the existing `import type { … } from '../shared/types'` list.

In `interface MochiApi`, change:

```ts
  saveState: (patch: StatePatch) => Promise<void>
```

to:

```ts
  saveState: (patch: StatePatch) => Promise<PersistedState>
```

and after `onMascotState`:

```ts
  /** Another window persisted state; merge it so the two never drift. */
  onStateChanged: (cb: (s: PersistedState) => void) => () => void
```

In the `api` object, after the `onMascotState` line (add a comma to it):

```ts
  onStateChanged: (cb) => on<PersistedState>(IPC.stateChanged, cb)
```

- [ ] **Step 4: Add the sync action**

In `src/renderer/src/state/context.ts`, add `PersistedState` to the `@shared/types` type import, then add to the `Action` union after `pending-send`:

```ts
  | { type: 'sync'; payload: PersistedState }
```

- [ ] **Step 5: Handle sync in the reducer**

In `src/renderer/src/state/store.tsx`, add a case before `default:`:

```ts
    case 'sync':
      return {
        ...state,
        settings: action.payload.settings,
        agents: action.payload.agents,
        sessions: action.payload.sessions,
        rules: action.payload.rules
      }
```

- [ ] **Step 6: Subscribe, and stop the echo**

In `src/renderer/src/state/store.tsx`, inside `StoreProvider`, next to `const burstId = useRef(0)`:

```ts
  // Snapshot of what was last written or received. The persist effect compares
  // against it so state arriving over `sync` is not immediately written back —
  // a boolean flag would stay stuck if the merge produced no change.
  const lastPersisted = useRef('')
```

Add this effect after the boot effect:

```ts
  // Another window saved. Merge rather than reload, so in-flight UI state
  // (open popovers, the active tour) survives.
  useEffect(() => {
    if (!window.mochi?.onStateChanged) return
    return window.mochi.onStateChanged((next) => {
      lastPersisted.current = JSON.stringify(next)
      dispatch({ type: 'sync', payload: next })
    })
  }, [])
```

Then replace the existing persist effect body with:

```ts
  useEffect(() => {
    if (!state.ready) return
    const slice = {
      settings: state.settings,
      agents: state.agents,
      sessions: state.sessions,
      rules: state.rules
    }
    const json = JSON.stringify(slice)
    if (json === lastPersisted.current) return
    lastPersisted.current = json
    void window.mochi?.saveState(slice)
  }, [state.ready, state.settings, state.agents, state.sessions, state.rules])
```

Finally, seed the snapshot at boot so the `ready` dispatch does not trigger a redundant write. In the boot effect, immediately before `dispatch({ type: 'ready', … })`:

```ts
      lastPersisted.current = JSON.stringify({
        settings: boot.settings,
        agents: boot.agents,
        sessions: boot.sessions,
        rules: boot.rules
      })
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/main/ipc.ts src/preload/index.ts src/renderer/src/state/store.tsx src/renderer/src/state/context.ts --quiet`
Expected: no errors (CRLF warnings are suppressed by `--quiet`).

- [ ] **Step 8: Verify the sync actually crosses windows**

The overlay is hidden by default after Task 1, so temporarily make it visible to observe the sync.

1. Close the app. Edit `%APPDATA%\Mochi\settings.json` and set `settings.mascot.visible` to `true`.
2. `npm run dev`. The mascot overlay appears.
3. In the app window, open Settings → Defaults and click a different **Accent** swatch.

Expected: the mascot card's accent updates **immediately**, with no restart. Before this task it would not have.

4. Close the app and set `visible` back to `false`.

- [ ] **Step 9: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/renderer/src/state/store.tsx src/renderer/src/state/context.ts
git commit -m "fix: broadcast persisted state to all windows so the overlay stays in sync"
```

---

### Task 3: Make the mascot window actually hide

**Files:**
- Modify: `src/main/mascot-window.ts` (add `setMascotVisible`, gate `ready-to-show`)
- Modify: `src/main/ipc.ts` (call it from the `saveState` handler)

**Interfaces:**
- Consumes: `load()` from `./store`, the `saveState` handler from Task 2.
- Produces: `setMascotVisible(visible: boolean): void` exported from `./mascot-window`.

- [ ] **Step 1: Gate the initial show and add the setter**

In `src/main/mascot-window.ts`, add to the imports:

```ts
import { load } from './store'
```

Replace:

```ts
  win.on('ready-to-show', () => win?.showInactive())
```

with:

```ts
  // Respect the persisted setting: a window that always shows itself on ready
  // cannot be started hidden, which is the default on a fresh install.
  win.on('ready-to-show', () => {
    if (load().settings.mascot.visible) win?.showInactive()
  })
```

Then add at the end of the file:

```ts
/**
 * Show or hide the overlay.
 *
 * `MascotLayer` returning null is not enough on its own — the transparent,
 * always-on-top window still covers the whole work area. Hiding the window is
 * what makes "off" actually mean off.
 */
export function setMascotVisible(visible: boolean): void {
  if (!win || win.isDestroyed()) return
  if (visible) win.showInactive()
  else win.hide()
}
```

- [ ] **Step 2: Drive it from saveState**

In `src/main/ipc.ts`, change the import:

```ts
import { getMascotWindow, setMascotInteractive } from './mascot-window'
```

to:

```ts
import { getMascotWindow, setMascotInteractive, setMascotVisible } from './mascot-window'
```

In the `saveState` handler from Task 2, add immediately before `return next`:

```ts
    setMascotVisible(next.settings.mascot.visible)
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/main/mascot-window.ts src/main/ipc.ts --quiet`
Expected: no errors.

- [ ] **Step 4: Verify the toggle works live**

1. Delete `%APPDATA%\Mochi\settings.json`. Run `npm run dev`.
2. Expected: **no mascot anywhere on screen.**
3. Press `Ctrl+M`. Expected: the mascot appears immediately.
4. Press `Ctrl+M` again. Expected: it disappears immediately.
5. Confirm it is the window and not just the component: with the mascot off, click on a desktop icon in the bottom-right region. The click must land — nothing invisible may swallow it.

- [ ] **Step 5: Commit**

```bash
git add src/main/mascot-window.ts src/main/ipc.ts
git commit -m "fix: hide the mascot BrowserWindow when the mascot is turned off"
```

---

### Task 4: The user's name, end to end

**Files:**
- Modify: `src/renderer/src/components/shell/AccountPopover.tsx:19,35`
- Modify: `src/main/agent-sdk-route.ts:124,244,452`
- Modify: `src/renderer/src/screens/settings/DefaultsPane.tsx`

**Interfaces:**
- Consumes: `AppSettings.userName` from Task 1.
- Produces: nothing later tasks depend on. `buildSystemPrompt` gains a second parameter.

- [ ] **Step 1: Use the real name in the rail footer**

In `src/renderer/src/components/shell/AccountPopover.tsx`, change line 6:

```tsx
  const { menuOpen, dispatch } = useStore()
```

to:

```tsx
  const { menuOpen, dispatch, settings } = useStore()
  const name = settings.userName.trim()
```

Replace line 19:

```tsx
          <div className="pop-label mono">tan@localhost</div>
```

with:

```tsx
          <div className="pop-label mono">{(name || 'you').toLowerCase()}@localhost</div>
```

Replace line 35:

```tsx
          <span className="rail-account-name">Tan</span>
```

with:

```tsx
          <span className="rail-account-name">{name || 'You'}</span>
```

- [ ] **Step 2: Tell the agent the name**

In `src/main/agent-sdk-route.ts`, change the `buildSystemPrompt` signature (line 244) and add the name line:

```ts
function buildSystemPrompt(agent: AgentLoadout, userName: string): string {
  const parts = [agent.instructions, `Expected output: ${agent.expectedOutput}`]

  // Only when set — a sentence about an absent name is worse than no sentence.
  const name = userName.trim()
  if (name) parts.push(`The user's name is ${name}. Address them as ${name}.`)

  const allowed = agent.allowedStickerIds ?? []
```

(leave the rest of the function unchanged.)

Update **both** call sites. Line 124, inside the delegate tool where `settings` is already destructured from `load()` at line 86:

```ts
            systemPrompt: buildSystemPrompt(target, settings.userName),
```

Line 452, inside the chat route where `settings` is destructured at line 412:

```ts
              systemPrompt: agent
                ? [buildSystemPrompt(agent, settings.userName), describeSubagents(chatId)]
                    .filter(Boolean)
                    .join('\n\n')
                : undefined,
```

- [ ] **Step 3: Let the user change it in Settings**

In `src/renderer/src/screens/settings/DefaultsPane.tsx`, add a card as the **first** child of the first `<div className="pane-col">`, directly above the "Default agent" section:

```tsx
          <section className="config-card">
            <span className="section-label">You</span>
            <label className="field">
              <span className="field-label">What agents call you</span>
              <input
                className="field-input"
                value={settings.userName}
                placeholder="your name"
                onChange={(e) => dispatch({ type: 'settings', patch: { userName: e.target.value } })}
              />
            </label>
            <span className="meta">Leave it empty and agents just won&apos;t use a name.</span>
          </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: PASS. A failure here almost certainly means one of the two `buildSystemPrompt` call sites was missed.

Run: `npx eslint src/renderer/src/components/shell/AccountPopover.tsx src/main/agent-sdk-route.ts src/renderer/src/screens/settings/DefaultsPane.tsx --quiet`
Expected: no errors.

- [ ] **Step 5: Verify in the running app**

1. `npm run dev`. The rail footer reads **You**, and the popover reads `you@localhost`.
2. Settings → Defaults → "What agents call you": type a name.
3. Expected: the rail footer updates as you type.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/shell/AccountPopover.tsx src/main/agent-sdk-route.ts src/renderer/src/screens/settings/DefaultsPane.tsx
git commit -m "feat: capture a user name and give it to the agent"
```

---

### Task 5: Tour definitions

**Files:**
- Create: `src/renderer/src/state/tours.ts`

**Interfaces:**
- Consumes: `AgentLoadout`, `AppSettings`, `Session` from `@shared/types`; `Screen` from `./screens`.
- Produces: `TourSnapshot`, `TourStep`, `Tour`, `TOURS`. Tasks 6 and 7 both import from here.

- [ ] **Step 1: Write the file**

Create `src/renderer/src/state/tours.ts`:

```ts
import type { AgentLoadout, AppSettings, Session } from '@shared/types'
import type { Screen } from './screens'

/**
 * Tours: the reusable slide modal behind first-run setup and, later, any
 * feature hint.
 *
 * A step is data, not a component — adding a hint means adding an object here,
 * not writing another modal. Two presentation modes fall out of one field:
 * a step with a `goto` needs the user to *do* something, so the card docks to a
 * corner and the app stays interactive; a step without one is a plain centred
 * modal.
 */

/** Everything a step predicate is allowed to look at. */
export interface TourSnapshot {
  agents: AgentLoadout[]
  sessions: Session[]
  settings: AppSettings
}

export interface TourStep {
  title: string
  body: string
  /** Renders an extra interactive control inside the card. */
  field?: 'name'
  /** Navigate here when the step opens. Presence of this means docked mode. */
  goto?: Screen
  /** Next stays locked until this returns true. Absent means always unlocked. */
  requires?: (s: TourSnapshot) => boolean
  /** Shown beside the spinner while `requires` is unmet. */
  waiting?: string
}

export interface Tour {
  id: string
  steps: TourStep[]
}

const FIRST_RUN: Tour = {
  id: 'first-run',
  steps: [
    {
      title: 'What should I call you?',
      body: 'Your agents will use this when they talk to you. You can change it later in Settings.',
      field: 'name'
    },
    {
      title: 'Make your first agent',
      body:
        'An agent is a loadout — a name, a model, instructions and the tools it may use. ' +
        'Hit "New loadout" to build one.',
      goto: 'agents',
      requires: (s) => s.agents.length > 0,
      waiting: 'waiting for your first agent…'
    },
    {
      title: 'Start a session',
      body:
        'Pick your agent, choose a session type, and type the first message. ' +
        'That is the whole loop.',
      goto: 'new',
      requires: (s) => s.sessions.length > 0,
      waiting: 'waiting for your first session…'
    }
  ]
}

/** Every tour, in the order they are offered. First unseen one wins. */
export const TOURS: Tour[] = [FIRST_RUN]
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/state/tours.ts
git commit -m "feat: add tour definitions and the first-run tour"
```

---

### Task 6: Tour state in the store

**Files:**
- Modify: `src/renderer/src/state/context.ts` (state field + three actions)
- Modify: `src/renderer/src/state/store.tsx` (initial state, reducer cases, boot trigger)

**Interfaces:**
- Consumes: `TOURS` from Task 5, `toursSeen` from Task 1.
- Produces: `state.tour: { id: string; step: number } | null` and the `tour-start` / `tour-step` / `tour-end` actions, all consumed by Task 7.

- [ ] **Step 1: Add the state field and actions**

In `src/renderer/src/state/context.ts`, add to `interface State` after `pendingSend`:

```ts
  /** The running tour, or null. Steps are indexes into its definition. */
  tour: { id: string; step: number } | null
```

and to the `Action` union after the `sync` entry from Task 2:

```ts
  | { type: 'tour-start'; id: string }
  | { type: 'tour-step'; step: number }
  | { type: 'tour-end' }
```

- [ ] **Step 2: Seed it and add the reducer cases**

In `src/renderer/src/state/store.tsx`, add the import:

```ts
import { TOURS } from './tours'
```

Add to the `initial` object after `pendingSend: null`:

```ts
  tour: null
```

(add a comma to the `pendingSend` line.)

Add these cases before `default:`:

```ts
    // Navigation lives in the reducer rather than an effect: advancing a step and
    // moving the user to the screen that step is about are one atomic change, and
    // doing it in an effect would mean a render where the two disagree.
    case 'tour-start': {
      const goto = TOURS.find((t) => t.id === action.id)?.steps[0]?.goto
      return { ...state, tour: { id: action.id, step: 0 }, screen: goto ?? state.screen }
    }
    case 'tour-step': {
      if (!state.tour) return state
      const goto = TOURS.find((t) => t.id === state.tour?.id)?.steps[action.step]?.goto
      return {
        ...state,
        tour: { ...state.tour, step: action.step },
        screen: goto ?? state.screen
      }
    }
    case 'tour-end':
      return { ...state, tour: null }
```

- [ ] **Step 3: Start the first unseen tour at boot**

In `src/renderer/src/state/store.tsx`, in the boot effect, immediately after the `dispatch({ type: 'ready', … })` call and before the closing of the async function:

```ts
      // After ready, so the tour reads real persisted state rather than defaults.
      const pending = TOURS.find((t) => !(boot.settings.toursSeen ?? []).includes(t.id))
      if (pending) dispatch({ type: 'tour-start', id: pending.id })
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/renderer/src/state/store.tsx src/renderer/src/state/context.ts --quiet`
Expected: no errors.

- [ ] **Step 5: Verify the trigger fires exactly once**

1. Delete `%APPDATA%\Mochi\settings.json`. Run `npm run dev`.
2. Nothing visible changes yet — `TourLayer` does not exist until Task 7. Confirm via DevTools (`Ctrl+Shift+I`) that no error is thrown at boot.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/state/store.tsx src/renderer/src/state/context.ts
git commit -m "feat: track the running tour in the store"
```

---

### Task 7: The TourLayer component

**Files:**
- Create: `src/renderer/src/components/tour/TourLayer.tsx`
- Create: `src/renderer/src/components/tour/tour.css`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `TOURS`, `TourSnapshot` from Task 5; `tour` state and `tour-*` actions from Task 6; `userName` / `toursSeen` from Task 1.
- Produces: `<TourLayer />`, mounted once in `Shell`.

- [ ] **Step 1: Write the component**

Create `src/renderer/src/components/tour/TourLayer.tsx`:

```tsx
import { useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { TOURS, type TourSnapshot } from '@renderer/state/tours'
import './tour.css'

/**
 * The slide modal behind first-run setup and any future feature hint.
 *
 * Docked mode is what makes a guided step possible: the backdrop goes away and
 * the card shrinks into the corner, so the user can actually use the screen the
 * step is telling them about. It docks bottom-*left* because the mascot overlay
 * is a separate always-on-top window sitting bottom-right.
 */
export function TourLayer(): React.JSX.Element | null {
  const { tour, agents, sessions, settings, dispatch } = useStore()
  const [name, setName] = useState('')

  const def = TOURS.find((t) => t.id === tour?.id)
  const step = tour && def ? def.steps[tour.step] : undefined
  if (!tour || !def || !step) return null

  const snapshot: TourSnapshot = { agents, sessions, settings }
  const locked = step.requires ? !step.requires(snapshot) : false
  const docked = Boolean(step.goto)
  const last = tour.step === def.steps.length - 1

  const close = (): void => {
    dispatch({
      type: 'settings',
      // Deduped: close() can run twice (Skip on the last step), and a repeated id
      // would grow the list without changing what it means.
      patch: { toursSeen: [...new Set([...settings.toursSeen, tour.id])] }
    })
    dispatch({ type: 'tour-end' })
  }

  const next = (): void => {
    // Committed on Next, not per keystroke, so an abandoned step leaves nothing.
    // Only when non-empty: on a replay the field starts blank, and treating that
    // as "clear my name" would silently wipe a name the user already set.
    if (step.field === 'name' && name.trim()) {
      dispatch({ type: 'settings', patch: { userName: name.trim() } })
    }
    if (last) close()
    else dispatch({ type: 'tour-step', step: tour.step + 1 })
  }

  const card = (
    <div className="tour-card" role="dialog" aria-modal={!docked} aria-label={step.title}>
      <div className="tour-head">
        <div className="tour-dots" aria-label={`Step ${tour.step + 1} of ${def.steps.length}`}>
          {def.steps.map((_, i) => (
            <span key={i} className="tour-dot" data-on={i === tour.step} />
          ))}
        </div>
        <button className="pill-ghost tiny" onClick={close}>
          Skip
        </button>
      </div>

      <h2 className="tour-title">{step.title}</h2>
      <p className="tour-body">{step.body}</p>

      {step.field === 'name' && (
        <input
          className="field-input"
          value={name}
          placeholder={settings.userName || 'your name'}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') next()
          }}
        />
      )}

      <div className="tour-foot">
        {locked && (
          <span className="tour-waiting meta">
            <Loader2 size={13} strokeWidth={1.9} className="tour-spin" />
            {step.waiting}
          </span>
        )}
        <span className="tour-spacer" />
        {tour.step > 0 && (
          <button className="pill-ghost" onClick={() => dispatch({ type: 'tour-step', step: tour.step - 1 })}>
            Back
          </button>
        )}
        <button className="pill-primary" disabled={locked} onClick={next}>
          {last ? 'Done' : 'Next'}
          {!last && <ArrowRight size={14} strokeWidth={2.2} />}
        </button>
      </div>
    </div>
  )

  if (docked) return <div className="tour-dock">{card}</div>

  return (
    <div className="tour-backdrop" role="presentation">
      {card}
    </div>
  )
}
```

- [ ] **Step 2: Write the stylesheet**

Create `src/renderer/src/components/tour/tour.css`:

```css
.tour-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(2px);
}

/* Docked: bottom-left, clear of the mascot overlay window on the right. */
.tour-dock {
  position: fixed;
  left: calc(var(--rail-w) + 22px);
  bottom: 22px;
  z-index: 60;
}

.tour-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(420px, calc(100vw - 48px));
  padding: 20px 22px;
  border: 1px solid var(--line);
  border-radius: var(--r-modal);
  background: var(--surf);
  box-shadow: var(--shadow);
}

.tour-dock .tour-card {
  width: 320px;
  padding: 16px 18px;
  border-radius: var(--r-card);
}

.tour-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tour-dots {
  display: flex;
  gap: 6px;
}

.tour-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--line2);
  transition: background 160ms ease;
}

.tour-dot[data-on='true'] {
  background: var(--ac);
}

.tour-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--tx);
}

.tour-dock .tour-title {
  font-size: 15px;
}

.tour-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--tx2);
}

.tour-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.tour-spacer {
  flex: 1;
}

.tour-waiting {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--tx3);
}

.tour-spin {
  animation: tour-spin 1.1s linear infinite;
}

@keyframes tour-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tour-spin {
    animation: none;
  }
}
```

- [ ] **Step 3: Mount it**

In `src/renderer/src/App.tsx`, add the import after the `SettingsModal` import:

```tsx
import { TourLayer } from './components/tour/TourLayer'
```

and add it inside `Shell`, immediately after `<CommandPalette />`:

```tsx
      <TourLayer />
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/renderer/src/components/tour/TourLayer.tsx src/renderer/src/App.tsx --quiet`
Expected: no errors. If `react-hooks/rules-of-hooks` fires, `useState` was moved below the early `return null` — it must stay above it.

- [ ] **Step 5: Verify the whole flow**

1. Delete `%APPDATA%\Mochi\settings.json`. Run `npm run dev`.
2. Expected: centred card, "What should I call you?", dots showing step 1 of 3, no mascot on screen.
3. Type a name, click **Next**. Expected: card docks bottom-left, app navigates to Agents & loadouts, `Next` is disabled, "waiting for your first agent…" shows.
4. Click **New loadout**. Expected: `Next` unlocks the moment the agent exists.
5. Click **Next**. Expected: navigates to Start a session, locked again.
6. Start a session. Expected: unlocks; the button reads **Done**.
7. Click **Done**. Expected: card disappears; rail footer shows the name from step 1.
8. Quit and relaunch. Expected: **no tour** — `toursSeen` contains `first-run`.
9. Relaunch again and confirm `Back` from step 2 returns to step 1, and `Skip` at any step closes it permanently.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/tour/TourLayer.tsx src/renderer/src/components/tour/tour.css src/renderer/src/App.tsx
git commit -m "feat: add the tour slide modal with centred and docked modes"
```

---

### Task 8: Replay the tour from Settings

**Files:**
- Modify: `src/renderer/src/screens/settings/DefaultsPane.tsx`

**Interfaces:**
- Consumes: `toursSeen` from Task 1, `tour-start` from Task 6.
- Produces: nothing.

- [ ] **Step 1: Add the replay row**

In `src/renderer/src/screens/settings/DefaultsPane.tsx`, add to the "You" card from Task 4, directly below the existing `<span className="meta">` line and inside the same `<section>`:

```tsx
            <Row label="Welcome tour" hint="run the first-run walkthrough again">
              <button
                className="pill-ghost"
                onClick={() => {
                  dispatch({
                    type: 'settings',
                    patch: { toursSeen: settings.toursSeen.filter((t) => t !== 'first-run') }
                  })
                  dispatch({ type: 'tour-start', id: 'first-run' })
                }}
              >
                Replay
              </button>
            </Row>
```

`Row` is already imported in this file.

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src/renderer/src/screens/settings/DefaultsPane.tsx --quiet`
Expected: no errors.

- [ ] **Step 3: Verify in the app**

1. `npm run dev` on a profile that has already completed the tour.
2. Settings → Defaults → **Replay**.
3. Expected: the settings modal is still open, and the tour card appears on step 1. Close settings and confirm the tour is usable and completes normally.
4. **Name-preservation check.** Replay again. The name field is blank but shows your existing name as its placeholder. Click **Next** without typing.
   Expected: the rail footer still shows your original name — it must not revert to "You".

- [ ] **Step 4: Full regression pass**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint --silent 2>&1 | Select-String "problems"`
Expected: still exactly **4 errors** — the pre-existing ones listed in Global Constraints. Any fifth error is a regression from this plan.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/screens/settings/DefaultsPane.tsx
git commit -m "feat: replay the welcome tour from Settings"
```

---

## Self-review notes

**Spec coverage.** Part 1 (tour system) → Tasks 5, 6, 7, plus replay in 8. Part 2 (first-run tour) → Task 5. Part 3 (user name) → Task 4. Part 4 (mascot: broadcast, hide, default off) → Tasks 2, 3, and Task 1 Step 3. Data model → Task 1. Every spec section maps to a task.

**Known gap, carried from the spec.** The Mastra path (`preferSubscription: false`) still will not see the user's name until restart, because `startMastraServer` builds agents once at boot and returns early thereafter. The default subscription path is unaffected. Out of scope by agreement.

**Ordering constraint.** Task 3 depends on Task 2's rewritten `saveState` handler; do not reorder them. Tasks 5 → 6 → 7 are likewise strictly sequential. Task 4 is independent of the tour tasks and can move.
