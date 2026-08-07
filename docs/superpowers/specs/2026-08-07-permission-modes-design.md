# Permission modes — design

**Date:** 2026-08-07
**Status:** approved, not yet implemented

Four permission modes — Manual, Accept edits, Plan, Auto — selectable per session,
on both backends, plus a Plan widget that keeps an approved plan readable after
the card that gated it is gone.

## Why

Today every tool call outside `AUTO_APPROVED` stops at a permission card, and
that is the only behaviour there is. It is the right default and the wrong only
option: a long refactor is a hundred cards, and a question you want answered
before anything is touched has no way to say so. Claude Code solved this with a
mode switch, and Mochi's approval path is already the shape that needs.

## The mode

```ts
export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto'
```

Mochi's own names, mapped to each backend's vocabulary at the edge. Storing the
SDK's `'default'` would mean the UI says "Manual" and the file says something
else, and it stops meaning anything the day the SDK adds a mode.

**Bypass permissions is deliberately absent.** It is the fifth entry in Claude
Code's menu and the one that makes the other four decorative. Nothing in Mochi
should be able to reach it, including a hand-edited settings file.

### Where it lives

On `Session`:

```ts
mode: PermissionMode
/** Only meaningful when mode is 'auto'. Absent means the native classifier. */
autoClassifierModel?: string
```

Per session, not global — one session planning while another executes is the
normal case, not the exotic one. `AppSettings` gains `defaultMode` for what a new
session starts as, defaulting to `manual`.

### Mapping

| Mochi | Subscription (Agent SDK) | Mastra (API key) |
| --- | --- | --- |
| `manual` | `permissionMode: 'default'` | `requireToolApproval` → ask on anything not read-only |
| `acceptEdits` | `'acceptEdits'` | ask on execute, allow edits |
| `plan` | `'plan'` + `planModeInstructions` | read-only tool map + planning instructions |
| `auto`, no model | `'auto'` — the CLI's own classifier | the consequence table (see below) |
| `auto` + model | `'default'` + Mochi's classifier | **n/a** — no model list is offered here |

On the Mastra backend `auto` has exactly one meaning: the consequence table. The
Auto submenu offers no model list there and `autoClassifierModel` is ignored, so
there is no state in which a user picks a model and nothing uses it.

## The consequence table

One artifact, three uses. This is the piece that replaced a hand-written safety
floor *and* a separate keyword rule with a single thing to get right.

Every tool carries declared tags where Mochi defines it, and the gate also scans
the arguments the model passed. Either hitting sends the call to a card.

```
runSql({ q: "SELECT * FROM users" })   tags: data      args: —          → runs
runSql({ q: "DROP TABLE users" })      tags: data      args: /\bdrop\b/ → card
writeFile({ path: "a.ts" })            tags: data,write                 → card
```

The argument scan is what tags alone cannot do: `runSql` is harmless by name and
not by the `DROP TABLE` inside it. Tags alone would force every general-purpose
tool to be marked destructive always, so Auto would ask about every `SELECT`.

Tag vocabulary: `read`, `write`, `data`, `execute`, `network`, `destructive`.
Argument vocabulary starts at `delete`, `drop`, `truncate`, `rm -rf`, `--force`,
`format`, `secret`, `key`, `token`, `push`, and grows by evidence rather than by
imagination.

Used as:

1. **The whole decision** for Auto on the Mastra backend.
2. **The veto** the chosen model cannot override for Auto-with-a-model on the
   subscription backend. The model may only ever narrow what runs, never widen
   it — a `destructive` hit goes to a card whatever it says.
3. **Nothing** for native Auto. The CLI has its own, better-tuned classifier and
   its own safety checks; layering ours on top would be two policies disagreeing.

Regardless of tags, these always reach a card: writes outside the workspace root,
credential and key paths, `git` history rewrites, and anything touching
`%APPDATA%\Mochi` itself.

## Auto, three paths

- **Native** (`autoClassifierModel` absent) — `permissionMode: 'auto'`. Anthropic's
  classifier, its safety checks, and its escalation metadata. Subscription only.
- **A chosen model** — `permissionMode: 'default'` plus `src/main/classifier.ts`,
  which runs the named model with `maxTurns: 1` and a schema-forced
  `{ decision: 'allow' | 'deny' | 'ask', reason }`. Only ever consulted for calls
  that would otherwise show a card, so reads and the agent's own bookkeeping stay
  free and the spend is bounded without a cache.
- **The consequence table alone** — the Mastra backend. No second model call, no
  latency, and the verdict is auditable by reading a table.

**Fail closed, everywhere.** A classifier that errors, times out, or answers
something unparseable shows the card. A classifier that is down must never become
a classifier that says yes. Mastra's own `requireToolApproval` already behaves
this way — "if the function throws, the call requires approval as a fail-safe".

## The picker

A pill in `ask-dock-bar`, left of the model picker, reading the current mode.
Keys `1`–`4`. The `Auto` row expands to a submenu: **Native (Claude Code)** first,
then the model list.

On the subscription backend, Native is disabled with a line saying why when the
session model's `supportsAutoMode` is false — which means `SubscriptionModel`
grows that field from `supportedModels()`. The model list below it is *not*
filtered by `supportsAutoMode`: there the model is only being asked a question,
and any model can answer one.

On the Mastra backend the submenu does not appear at all. `Auto` is a plain row,
because there is only one thing it can mean.

Switching mid-turn calls `query.setPermissionMode()` on the live query, which is
streaming-input only — Mochi's `inputChannel` already satisfies that. This needs
a `Map<sessionId, Query>` in `agent-sdk-route.ts`, which currently drops the
`Query` handle once the turn starts. With no live query the change simply applies
to the next turn.

## Plan mode

On the subscription path the CLI already runs the protocol. When the agent
finishes planning it calls `ExitPlanMode` with the plan as its input, and since
that tool is not in `AUTO_APPROVED` it arrives in `canUseTool` — the path the
permission card already owns.

- The card renders the plan as markdown with **Approve → \<follow-on mode\>** and
  **Keep planning**. Approve resolves the permission *and* calls
  `setPermissionMode()` in one action, so the agent carries on in the same turn
  rather than waiting to be told again.
- The same payload populates a new **Plan widget**: `WidgetKind` gains `'plan'`,
  `auto: true`, added to `PANEL_KINDS`, icon `ClipboardList` (`ListChecks` belongs
  to Tasks). It holds the plan markdown, its status — proposed / approved /
  superseded — and which mode it was approved into, so a plan stays readable
  after the card is gone instead of scrolling out of the transcript.
- `planModeInstructions` carries a Mochi-specific body rather than the CLI's
  default code-implementation workflow. The CLI still wraps it with its own
  read-only enforcement preamble and ExitPlanMode footer.
- The Mastra backend has no `ExitPlanMode`, so a `mochi` tool `proposePlan` with
  `requireApproval: true` takes the same shape and feeds the same card and widget.

## Backends

### Subscription

`permissionMode` is passed at `query()` construction from the session's mode.
Escalations keep landing in `canUseTool` and keep using the existing card, now
annotated with `decision_reason_type` and `classifier_approvable` when the SDK
supplies them — so a card can say whether a safety check or the classifier
stopped it.

### Mastra

`requireToolApproval` as a function, reading the mode out of `requestContext` —
the channel `workspacePath` already travels on.

**The function is built in the route handler, never accepted from the wire.**
`speakerAwareChatRoute` builds its params from `await c.req.json()`, and a
function cannot survive JSON. Building it server-side is also the safer shape:
the renderer can never post `requireToolApproval: () => false`.

Plan mode additionally swaps the tool map through the existing `tools: () => …`
dynamic argument, so the writers are absent rather than merely gated.

**Needs verification during implementation:** Mastra documents function-based
`requireToolApproval` as available on regular `stream()` / `generate()` only,
not on durable or stored agents, because a function cannot be serialised. Mochi
calls `handleChatStream`, which should be the regular path, but that has not been
confirmed against a running server.

## Failure and drift

- A mode the backend cannot honour — native Auto on Mastra — is unreachable in the
  picker. If a hand-edited `settings.json` asks for it anyway, main falls back to
  `manual` and warns, the same pattern the MCP name check uses.
- The existing Permissions widget gains the current mode as a line, so one place
  answers "what is this session allowed to do right now".
- An approval that is never answered still times out at `APPROVAL_TIMEOUT_MS`.
  Modes do not change that; a parked promise nobody answers is still a hung turn.

## Out of scope

- Bypass permissions, in any form.
- Per-tool permission rules in the UI. The SDK's `alwaysAllow` suggestion path
  already exists and is untouched.
- Rewriting `AUTO_APPROVED`. The consequence table describes tools the modes gate;
  the auto-approved list stays the floor beneath all four modes.
- Adopting Mastra's `AgentController`. It models modes well, but Mochi's Mastra
  backend is a plain `Agent` and switching is a re-architecture, not a config
  change.

## Verification

The repository has no test runner. Pure functions — the mode-to-backend mapping,
the consequence table, classifier response parsing — get a Node script run against
the real module, the way `parseCommand` was checked in `src/shared/mcp.ts`.

Everything else needs the app running: mode switching mid-turn, the plan card,
the plan widget, and the Mastra approval path. That cannot be done from the
development environment this was designed in, so it needs a pass on Windows
before any of it is called done.

## Build order

Three phases, each shippable alone:

1. **Subscription modes + Plan widget.** The mode type, the picker, the four modes
   on the Agent SDK, native Auto, the plan card and the plan widget.
2. **The consequence table + custom classifier.** Tags on Mochi's tools, the
   argument scan, `src/main/classifier.ts`, and Auto-with-a-model on the
   subscription backend.
3. **Mastra parity.** `requireToolApproval`, the read-only tool map for Plan,
   `proposePlan`, and Auto driven by the consequence table.
