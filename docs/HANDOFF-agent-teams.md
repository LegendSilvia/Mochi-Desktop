# Agent teams — what is built, and what is not

Branch `feat/run-control` (PR #3). This replaces the spec written before any of
it existed; that version's two named suspects for the memory bug both turned out
to be wrong, which is a good reason not to trust a plan over a log.

## Built

**Speaker names** (`283a1dd`). Assistant messages carry `metadata.agentId`,
written by the subscription route before the first token. The name prints when
it changes, not over every reply. Anything without metadata — every message
written before this, and everything from the Mastra route, whose `chatRoute` has
no hook for stamping any — falls back to the tag on the question it answered.

**Shared thread** (`3b77ef9`). Resources stay per agent. Giving a session its own
resource is the bug `2141ba4` fixed wearing a different hat: it merges two
agents' private notes and files each one's replies under the other's name. What
they share is the *thread*, and Mastra filters thread-scoped recall on
`thread_id` alone, so `recallContext` runs a second query with the scope
overridden. Excerpts from another agent are labelled as such, never as "You".

**Tag routing** (`f9d8709`). `@name` hands that agent the turn; it answers as
itself. Position decides address from mention: leading or trailing is an
address, mid-sentence is a reference. Each agent keeps its own backend, so
tagging one on an OpenRouter model routes to the API key while the rest stay on
the subscription. The tag is stripped before the model sees it — left in, an
agent read its own tag as an instruction about someone else and delegated to
itself.

**Peer tagging** (`a9827cb`). An agent ending a reply with a tag hands over the
turn, carrying what it said. The handoff rides as a user-role message with
`metadata.handoff`, because that is the only role the backends read a prompt
from; it renders as nothing.

**Per-role subagents** (`7777bd8`). `researcher` and `reviewer` are read-only and
sit wholly inside `AUTO_APPROVED`; `builder` adds Write/Edit/Bash and still asks.
Capability rather than permission: a researcher cannot be talked into writing by
a confused plan or by text injected into a page it fetched.

## KNOWN GAP — the chain cap has never been seen to fire

`TAG_CHAIN_LIMIT` is 4 passes per user message, and hitting it appends a
`chainStopped` message that renders as "Stopped here…". **That branch has never
executed.** Verified up to depth 4 — handoffs alternate correctly, depths count
1,2,3,4, each reply carries the right `agentId` — and then both agents stop on
their own, every time, including when explicitly told not to. Fraux, asked to
keep going: *"last round I stopped at four myself, so your guard never actually
fired."*

So the safety property of the whole feature rests on one untested comparison.
Two ways to close it, neither done:

1. A test harness. There is none in the repo, which is why this is open. The
   unit under test is small: seed messages whose last handoff has `depth: 4`,
   run the finish handler, assert a `chainStopped` message appears and no
   `sendMessage` fires.
2. Drive it from the app by seeding a transcript ending in a `handoff.depth: 4`
   user message and re-running that turn, so `messages[len-2]` carries the
   depth. Needs a way to trigger a turn without appending a message —
   `regenerate` is the candidate.

Until then, treat "two agents cannot loop forever" as **believed, not shown**.

## Not built

**Tagging old sessions.** Different mechanism from tagging an agent — closer to
recall than to a turn. A tagged session id should inject that thread's context,
so route it through `recallContext` against that thread rather than starting
anything.

**Memory-inspection tools.** Still ambiguous between two readings. The concrete
gap is that Settings → Memory has no agent picker: it always shows
`settings.defaultAgentId`, so Helper's memory is not reachable at all. The other
reading — a tool letting an agent read its own memory — is weak now that working
memory is injected every turn and `appendMemory` dedupes.

**Editable agent id.** The id is a foreign key: `Session.agentId`,
`settings.defaultAgentId`, `subagentIds`, and the memory resource
`mochi-user:<id>`, which is stored on `mastra_resources.id`,
`mastra_threads.resourceId` and `mastra_messages.resourceId`. The LibSQL store
and vector `id`s are only instance labels — the tables are shared — so they do
*not* need migrating. Renaming without rewriting the rest orphans the agent's
memory and every session pointing at it.

## Ground rules learned the hard way

- **Drive the app; do not reason about it.** Every bug found here was invisible
  to typecheck, lint and build.
- **Read the log after a run.** Two separate recall failures were swallowed by a
  `catch` and appeared nowhere on screen: the feature was simply off.
- A `catch` around two operations loses both. Fail them independently and name
  which one it was.
- Real key events reach the composer. **Synthetic React events do not** — and
  React drops characters typed back-to-back with no frame between, so the CDP
  helper types with a delay.
- The loadout editor holds edits in a **draft until Save**. Twice this made
  working controls look broken.
- Controls in the loadout must read `edited`, never `selected` — see `7125866`.
- Never write JSON the app reads with PowerShell; `Set-Content -Encoding utf8`
  emits a BOM and `JSON.parse` refuses it. Use Node.
- Never `pkill -f electron`; filter on `CommandLine -like '*electron.exe .*'`.
- Baseline lint is **2 errors** (both `set-state-in-effect` in
  `CommandPalette.tsx`).
