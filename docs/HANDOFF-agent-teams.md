# Handoff — agent teams

Branch `feat/run-control` (PR #3). Everything described as landed is committed
and pushed. This file is the spec for what is **not** built yet.

## Answering the question that prompted this

**Do all agents share one memory right now? No.** Since `2141ba4` the memory
resource is per agent — `mochi-user:<agentId>` — so Fraux and Helper keep
separate working memory and separate recall.

Two things make it *look* shared, and both are real gaps:

1. **The Memory pane has no agent picker.** It always shows
   `settings.defaultAgentId`, with the heading "What Fraux keeps between
   sessions". There is no way to see Helper's memory at all.
2. **OPEN BUG — the pane showed empty when it should not have.** Earlier the
   same session read 492 characters back for `fraux` through the very same IPC
   (`memoryGet('fraux')`), and a later screenshot showed the editor blank.
   Not diagnosed. Suspects, in order: `readWorkingMemory` passes the constant
   `EDITOR_THREAD` while the agent writes under the session's thread, and
   `getWorkingMemory` may not resolve resource-scoped memory from an unknown
   thread id; or `resetRecall()` on every settings save rebuilt the Memory with
   `workingMemory` disabled. **Reproduce before building on top of this** — the
   team feature assumes memory reads are trustworthy.

## What Mastra gives, and what it does not

Researched against the installed docs, not from memory.

- **Agent networks are deprecated.** `docs-agents-networks.md` says so outright
  and links a migration guide. Do not build on them.
- **Supervisor agents are the current pattern** — `agents: {}` on an Agent, then
  `.stream()`. Crucially: *"By default, subagents receive the full conversation
  context from the supervisor"* (`docs-agents-supervisor-agents.md:150`). Shared
  context is the Mastra default. Mochi's "memory isolated" delegation is Mochi's
  own choice, not a framework limit.
- Also available there: `delegation.messageFilter` to trim what is shared,
  `onDelegationStart` / `onDelegationComplete` hooks with `context.bail()` and
  feedback injection, and `maxSteps`.
- **A2A is not it.** It is for remote agents across vendor boundaries and keeps
  each agent's memory deliberately private.
- **No round-table primitive exists.** Supervisor is hierarchical: one router
  delegates down, replies return as tool results. Peer-to-peer tagging is
  orchestration Mochi has to own.

**The backend matters more than the framework.** The user runs
`preferSubscription: true`, so none of the supervisor machinery is in play.
Delegation today is Mochi's own `delegate` tool in `agent-sdk-route.ts`, which
opens a separate Agent SDK session — that is where "memory isolated" comes from.
Build the team there.

## The feature, as asked for

1. Both the user and any agent can tag another agent into the chat.
2. Agents can tag each other and pass information or instructions.
3. Every agent sees every other agent's messages — shared memory.
4. **Only a user message or an agent tag may trigger a turn.** Nothing else.
5. Tagging can also reference an old session, not just an agent.
6. Tools in the loadout for inspecting an agent's memory.
7. The transcript must show who is speaking, now that it is not always one agent.

## Suggested build order

**7 first.** Speaker names are a prerequisite for everything else being legible,
and they are self-contained. Assistant messages currently render an avatar and
no name (`.msg-group[data-role=assistant]` in `Session.tsx`). Carry the agent id
on the message — `metadata.agentId` survives JSON, which is how `mochiError`
already works — and render name plus that agent's own art.

**3 next: the shared thread.** No new primitive needed. Mastra `Memory` is keyed
by `threadId` + `resourceId`; agents sharing a thread share history by
construction. Today `memoryResource(agentId)` deliberately separates them, so a
team needs a *session-scoped* resource — something like
`mochi-team:<sessionId>` — used by every agent in that session, while solo
sessions keep the per-agent resource. Do not simply revert to one global
resource: that is the bug `2141ba4` fixed, where asking one agent surfaced
another's unrelated work.

**4 with it: the turn policy.** This is the safety property and the whole risk.
A tag enqueues exactly one turn for the tagged agent. Requirements:

- A hard depth cap per user message (Mastra's `maxSteps` is the analogue). Two
  agents tagging each other will otherwise loop until the five-hour subscription
  window is gone.
- The cap must be *visible* in the transcript when hit — a silent stop looks
  identical to an agent that had nothing to say.
- An agent may not tag itself, and a tag already satisfied in this chain must
  not re-fire.
- Reuse the existing `inFlight` semaphore idea from `delegate` (`capped` mode).

**5: tagging old sessions.** Different mechanism — closer to recall than
delegation. A tagged session id should inject that thread's context, so route it
through `recallContext`/`Memory.recall` against that thread rather than starting
a session.

**6: memory-inspection tools.** Ambiguous in the original request — it could mean
tools *for the agent* to read memory, or UI in the loadout screen. Ask before
building. If it is tools, the read path already exists in
`src/main/recall.ts` (`readWorkingMemory`), and it needs a per-turn
`MemoryContext` exactly like `updateMemory` already receives.

## Also asked for, not started

**Editable agent id** (screenshot: the "Agent id" field is read-only). This is
not a text-field change. The id is a foreign key in at least four places:
`Session.agentId`, the memory resource `mochi-user:<id>`, the LibSQL store and
vector ids `mochi-store-<id>` / `mochi-vector-<id>`, and the recall cache key.
Renaming without migrating those silently orphans an agent's memory and every
session pointing at it. Either migrate all references in one transaction, or
keep the id immutable and let the *name* be editable — which it already is.

## Ground rules learned the hard way today

- **Drive the app; do not reason about it.** Every bug found today was invisible
  to typecheck, lint and build.
- Real key events reach the composer. **Synthetic React events do not** — and
  `input.value` + dispatch fails even on untouched controls.
- The loadout editor holds edits in a **draft until Save**. Twice this made
  working controls look broken.
- Controls in the loadout must read `edited`, never `selected` — see `7125866`.
- Never write JSON the app reads with PowerShell; `Set-Content -Encoding utf8`
  emits a BOM and `JSON.parse` refuses it. Use Node.
- Never `pkill -f electron`; filter on `CommandLine -like '*electron.exe .*'`.
- Baseline lint is **2 errors** (both `set-state-in-effect` in
  `CommandPalette.tsx`). It was 3 until `109672f`.
