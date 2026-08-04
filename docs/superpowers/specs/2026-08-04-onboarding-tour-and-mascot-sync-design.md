# Onboarding tour + mascot state sync — design

Date: 2026-08-04
Status: approved, not yet implemented

## Context

Mochi's first-run state was recently emptied: `DEFAULT_AGENTS`, `DEFAULT_SESSIONS`
and `DEFAULT_RULES` are now `[]`, and `defaultAgentId` is `''`. A fresh install
therefore lands on a Start screen with nothing to pick and no explanation of what
to do next.

Two pieces of work follow from that, and they share a spec because they touch the
same store and IPC plumbing:

1. A reusable slide-modal ("tour") system, first used as a 3-step first-run setup.
2. A fix for the mascot overlay, whose visibility toggle does nothing because
   settings changes are never propagated to the overlay window.

## Goals

- A tour system where a new hint is *data*, not a new component.
- A first-run tour that captures the user's name, then guides them through
  creating their first agent and starting their first session.
- The captured name reaches the agent, so it addresses the user by name.
- `mascot.visible` (and every other setting) takes effect in the overlay window
  immediately, without an app restart.
- Mascot hidden by default on a fresh install.

## Non-goals

- Spotlight/element-anchored coach marks. The tour docks to a corner instead.
- A tour editor or any UI for authoring tours. Tours are code.
- Rebuilding the Mastra server when agents change (see Known limitations).
- A fourth "meet your mascot" slide. Three slides, as specified.

---

## Part 1 — The tour system

### Shape

A tour is a list of steps. Steps are plain data; the renderer interprets them.

```ts
// src/renderer/src/components/tour/tours.ts

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
  /** Navigate here when the step opens. Presence of this ⇒ docked mode. */
  goto?: Screen
  /** Next stays locked until this returns true. Absent ⇒ always unlocked. */
  requires?: (s: TourSnapshot) => boolean
  /** Shown beside the spinner while `requires` is unmet. */
  waiting?: string
}

export interface Tour {
  id: string
  steps: TourStep[]
}

export const TOURS: Tour[] = [FIRST_RUN]
```

### Two presentation modes

Chosen per step, from the presence of `goto`:

| `goto` | Mode | Behaviour |
|---|---|---|
| absent | **Centred** | Card centred, backdrop dims and captures clicks. The app is inert. |
| present | **Docked** | Backdrop fades out, card animates to a small card docked bottom-**left** of the content area. The app is fully interactive. |

Bottom-left, not bottom-right: the mascot overlay is a separate always-on-top
window that occupies the bottom-right of the work area and would cover the card.

### State

Renderer store gains:

```ts
tour: { id: string; step: number } | null
```

with actions `tour-start`, `tour-step`, `tour-end`.

Persisted in `AppSettings`:

```ts
/** Ids of tours already completed or skipped. */
toursSeen: string[]
```

### Trigger

In `StoreProvider`, after the `ready` dispatch: pick the first tour in `TOURS`
whose `id` is not in `settings.toursSeen` and start it. Completing or skipping a
tour appends its id to `toursSeen`, which persists through the existing
`saveState` effect.

### Card contents

Progress dots (one per step), title, body, an optional `field`, a `Skip`
affordance, and `Back` / `Next`. On the final step `Next` reads `Done`.

When `requires` is unmet, `Next` is disabled and the `waiting` label shows beside
a spinner. `Skip` is always enabled — a locked step must never trap the user.

A `field` writes its value on `Next`, not on every keystroke, so an abandoned or
skipped step leaves no partial value behind.

### Replay

Settings → Defaults gets a "Replay the welcome tour" row that removes `first-run`
from `toursSeen` and starts the tour immediately. This makes the tour testable
without deleting `settings.json`, and is the mechanism any future hint reuses.

---

## Part 2 — The first-run tour

```ts
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
      body: 'An agent is a loadout — a name, a model, instructions and the tools it may use. Hit "New loadout" to build one.',
      goto: 'agents',
      requires: (s) => s.agents.length > 0,
      waiting: 'waiting for your first agent…'
    },
    {
      title: 'Start a session',
      body: 'Pick your agent, choose a session type, and type the first message. That is the whole loop.',
      goto: 'new',
      requires: (s) => s.sessions.length > 0,
      waiting: 'waiting for your first session…'
    }
  ]
}
```

Step 1's name field is optional — an empty value simply means no name is set, and
`Next` stays enabled. Requiring it would make the very first interaction a wall.

---

## Part 3 — The user's name

### Storage

```ts
// AppSettings
/** What agents call the user. Empty means no name is set. */
userName: string
```

Default `''`.

### Consumers

- **`AccountPopover.tsx:35`** currently renders a hardcoded `Tan`. It becomes
  `settings.userName || 'You'`.
- **The agent.** `main/agent-sdk-route.ts:452` builds the system prompt via
  `buildSystemPrompt(agent)`. That function gains the name and appends a line:
  `The user's name is <name>. Address them as <name>.` — omitted entirely when
  `userName` is empty, rather than emitting a sentence about an absent name.

The `/agent-sdk/chat/:agentId` route calls `load()` per request, so the name
applies to the very next message with no restart. This is the default path
(`preferSubscription: true`).

---

## Part 4 — Mascot overlay

### Root cause

`main/ipc.ts:63` is `ipcMain.handle(IPC.saveState, (_e, patch) => save(patch))`.
It writes to disk and notifies nobody.

The overlay is a separate `BrowserWindow` (`mascot-window.ts`) running its own
`StoreProvider` (`mascot.tsx:23`), seeded once by `bootstrap()` at mount. The
preload exposes only three main→renderer listeners — `onLibraryChanged`,
`onStickerFired`, `onMascotState` — and none carry settings.

So `MascotLayer.tsx:241` (`if (!cfg.visible) return null`) is correct code that
never receives the changed value. The toggle can only take effect on restart.

This is not specific to `visible`: theme, accent, and every Mascot Studio control
(shell, size, opacity, idle motion) are equally stale in the overlay.

### Fix A — broadcast state changes

New channel `IPC.stateChanged = 'mochi:state-changed'`.

```ts
ipcMain.handle(IPC.saveState, (e, patch) => {
  const next = save(patch)
  for (const win of [getWindow(), getMascotWindow()]) {
    if (win && !win.isDestroyed() && win.webContents.id !== e.sender.id) {
      win.webContents.send(IPC.stateChanged, next)
    }
  }
  setMascotVisible(next.settings.mascot.visible)
  return next
})
```

Preload gains `onStateChanged(cb)`. `StoreProvider` subscribes and dispatches a
`sync` action that merges settings, agents, sessions and rules.

**Re-entrancy guard.** The receiving window's persist effect would otherwise fire
and echo the state back. A `fromSync` ref is set immediately before the `sync`
dispatch; the persist effect returns early and clears it when set. Excluding the
sender bounds this to one hop, and the guard stops that hop from becoming a loop.

### Fix B — actually hide the window

`MascotLayer` returning `null` leaves a transparent, always-on-top, full-work-area
window in place. `mascot-window.ts` gains:

```ts
export function setMascotVisible(visible: boolean): void {
  if (!win || win.isDestroyed()) return
  if (visible) win.showInactive()
  else win.hide()
}
```

`ready-to-show` consults persisted settings rather than unconditionally calling
`showInactive()`. The window is still *created* when hidden, so toggling on is
instant.

### Fix C — default off

`DEFAULT_SETTINGS.mascot.visible` becomes `false`. On a fresh install nothing
floats over the desktop until the user opts in — which matters more now that a
fresh install has no artwork and the mascot would render an `art?` placeholder.

---

## Data model changes

```ts
interface AppSettings {
  // …existing
  /** What agents call the user. Empty means no name is set. */
  userName: string
  /** Ids of tours already completed or skipped. */
  toursSeen: string[]
}
```

`main/store.ts` shallow-merges persisted settings over defaults, so both keys
appear on existing installs without a migration.

---

## Files

**New**
- `src/renderer/src/components/tour/TourLayer.tsx`
- `src/renderer/src/components/tour/tours.ts`
- `src/renderer/src/components/tour/tour.css`

**Edited**
- `src/shared/types.ts` — `userName`, `toursSeen`
- `src/shared/defaults.ts` — defaults for both; `mascot.visible: false`
- `src/renderer/src/state/context.ts` — tour state, `tour-*` and `sync` actions
- `src/renderer/src/state/store.tsx` — reducer cases, boot trigger, sync listener, persist guard
- `src/renderer/src/App.tsx` — mount `TourLayer`
- `src/renderer/src/components/shell/AccountPopover.tsx` — real name
- `src/renderer/src/screens/settings/DefaultsPane.tsx` — name field + "Replay the welcome tour"
- `src/main/ipc.ts` — `stateChanged` broadcast
- `src/main/mascot-window.ts` — `setMascotVisible`, conditional `ready-to-show`
- `src/main/agent-sdk-route.ts` — name in system prompt
- `src/preload/index.ts` — `onStateChanged`

## Verification

There is no test runner in this repo (no `test` script), so verification is
`npm run typecheck`, `npm run lint`, and a manual pass:

1. Delete `%APPDATA%\Mochi\settings.json`, launch. Tour appears centred on step 1.
2. Enter a name, Next. Card docks bottom-left and the app navigates to Agents.
3. `Next` is locked and shows the waiting label. Create a loadout — `Next` unlocks.
4. Next → navigates to Start a session; locked until a session is started.
5. Done → `toursSeen` contains `first-run`; relaunching does not show it again.
6. Account popover shows the entered name. Send a message; the agent uses it.
7. Mascot is absent on first launch. Toggling it on in Settings shows the overlay
   **without a restart**; toggling off hides it. Same for size and shell.
8. "Replay the welcome tour" in Defaults re-runs it.

## Known limitations

- **The Mastra path does not see the name until restart.** `startMastraServer`
  builds agents once at boot and returns early on subsequent calls, so agents
  built there bake in their instructions. This only affects
  `preferSubscription: false` (an API key), not the default subscription path.
  The same limitation already applies to every agent edit and is out of scope.
- Tour steps observe state by polling the store on each render. That is adequate
  for `agents.length > 0`; a step needing genuinely external state would want an
  event instead.
