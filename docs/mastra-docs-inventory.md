# Mastra embedded docs — inventory

What is actually installed under `node_modules/@mastra/*/dist/docs/`, and which
backlog items it answers. Written 2026-08-04, against the versions in the table
below. Re-check the versions before trusting any of this.

Read alongside `docs/mastra-coverage.md`: that file says what Mochi uses and what
it doesn't. This file says what is *available to use* and where the docs for it
are. Where the two disagree about the question UX, this one is right — see
§"Correction to the coverage table".

**Every claim below is marked.** "Verified" means the export or method was found
in the installed build. "Doc" means it is only claimed by the docs and was not
exercised.

---

## 1. What is installed

| Package | Version | Reference docs |
|---|---|---|
| `@mastra/core` | 1.55.0 | 405 |
| `@mastra/memory` | 1.24.0 | 38 |
| `@mastra/libsql` | 1.18.0 | 25 |
| `@mastra/server` | 1.55.0 | 6 |
| `@mastra/ai-sdk` | 1.7.0 | none — no `dist/docs` |
| `@mastra/hono` | 1.5.12 | none |
| `@mastra/schema-compat` | 1.3.4 | none |

474 reference docs total. Naming is `<category>-<topic>.md` where category is
one of `docs`, `reference`, `guides`, `models`. `docs-*` is conceptual,
`reference-*` is API signatures.

The three packages with no `dist/docs` are the ones Mochi leans on hardest for
the server path — for those, read the `.d.ts` files directly.

Useful entry points:

```powershell
Get-ChildItem node_modules\@mastra\core\dist\docs\references -File | Select-Object -ExpandProperty Name
Get-Content node_modules\@mastra\core\dist\docs\assets\SOURCE_MAP.json   # export -> file
```

---

## 2. The headline: AgentController

`@mastra/core/agent-controller` — **verified**, the export path exists in
`package.json` and `dist/agent-controller/` ships `agent-controller.d.ts`,
`session.d.ts`, `session-run-engine.d.ts`, `tools.d.ts`, `types.d.ts`.

Marked **beta** in its own docs: "subject to breaking changes in minor versions".

It is a session controller that sits between a UI and the agent loop, owning
threads, modes, persistent state, tool approvals and subagents. That is very
close to what Mochi hand-rolled across `Session.tsx` and `store.tsx`. Mastra's
own flagship implementation of it is Mastra Code, a terminal coding agent.

Docs: `docs-agent-controller-overview.md`, `-session.md`,
`-threads-and-state.md`, `-tool-approvals.md`, `-modes.md`, `-subagents.md`,
`-channels.md`, and `reference-agent-controller-agent-controller-class.md`.

### Built-in tools it gives every agent

From `docs-agent-controller-tool-approvals.md` (doc):

| Tool | Purpose |
|---|---|
| `ask_user` | free text, single-select, or multi-select question |
| `submit_plan` | submit a plan for review and approval |
| `task_write` / `task_update` / `task_complete` / `task_check` | structured task list |
| `subagent` | spawn a focused child agent |

Disable individually with `disableBuiltinTools: ['submit_plan']`.

`askUserTool`, `submitPlanTool` and all four `task*Tool`s are also exported
standalone from `@mastra/core/tools` — **verified** in
`dist/tools/index.d.ts`, along with types `AskUserOption`,
`AskUserSelectionMode`, `AskUserSuspendPayload`.

---

## 3. Backlog mapping

Item numbers are from `docs/HANDOFF-2026-08-04.md` §5.

| # | Backlog item | Mastra answer | Where | Status |
|---|---|---|---|---|
| 4 | Queue messages until reply lands | `agentController.followUp({content})`; `session.followUps.count()`; `steer()` redirects mid-run instead of queueing | `docs-agent-controller-session.md` | doc |
| 5 / D1 | Turn lost on session switch / close | Threads persist to storage; `agent.listSuspendedRuns({threadId, resourceId})` rediscovers pending runs after restart | `docs-agents-agent-approval.md` §"Resuming after a restart" | method verified in `agent.d.ts:1226` |
| 6 | Stop spam-answering a question | `askUserTool` genuinely suspends the run via `suspend()`; resume is one-shot per `toolCallId` | `reference-tools-ask-user-tool.md` | export verified |
| 7 | Multi-choice support | `selectionMode: 'single_select' \| 'multi_select'`; resume with `string[]` | same | doc |
| 7 | Multi-**question** support | **Not covered.** `askUserTool` asks one question. Sequential suspends or a custom tool with its own `suspendSchema` | — | gap |
| 8 | Render question from composer | `tool_suspended` event carries `toolCallId`, `toolName`, `suspendPayload` — render it wherever you like | `docs-agent-controller-tool-approvals.md` | doc |
| 9 | Disable chat input while question active | `session.displayState` is a reducer-maintained snapshot holding run status, pending approvals, queued follow-ups; re-render on `display_state_changed` | `docs-agent-controller-session.md` | doc |
| 10 | Cancel a question | `declineToolCall()`, or `agentController.abort()` | `docs-agents-agent-approval.md` | doc |
| 11 | Permission prompt | Policies `allow`/`ask`/`deny` per tool or per category (`read`/`edit`/`execute`/`mcp`/`other`); `tool_approval_required` event; `respondToToolApproval({decision})` with `approve`/`decline`/`always_allow_category` | `docs-agent-controller-tool-approvals.md` | doc |
| 12 | Workspace path not shown | `Workspace` + `LocalFilesystem({basePath})`; per-tool `requireApproval`, `requireReadBeforeWrite`, `enabled`, name remapping | `docs-workspace-overview.md`, `@mastra/core/workspace` | export verified |
| 13 | Model list hardcoded | Provider registry — see §5 | `scripts/provider-registry.mjs` | **run, see §5** |
| 15 | In-app debug logger | See §6 | — | doc |

Items 1–3 (markdown rendering, copy, edit/retry) and 14 (session drag) are
renderer concerns with no Mastra component. Build them directly.

### Correction to the coverage table

`docs/mastra-coverage.md` — and the table reproduced in the handoff — points the
question UX (items 6–10) at **Workflows**: suspend/resume, human-in-the-loop,
snapshots.

That is not the smallest path. Agent-level suspension covers it without
introducing Workflows at all:

- a tool calls `suspend(payload)` inside `execute`
- the stream emits a `tool-call-suspended` chunk carrying `suspendPayload`
- you resume with `agent.resumeStream(resumeData, { runId })`

`askUserTool` is exactly this, already built. Workflows are a separate primitive
for defined multi-step processes; they are not a prerequisite for a question UI.

Approval is a *second, distinct* mechanism — `requireApproval: true` on a tool,
or `requireToolApproval` on the request — which pauses *before* `execute` runs
and emits `tool-call-approval` instead. Both are documented in
`docs-agents-agent-approval.md`; do not conflate them.

Storage note from that doc: agent approval uses snapshots, so a persistent
storage provider must be configured or you get "snapshot not found". Mochi
already has `LibSQLStore`. Snapshots are minimal resume artifacts and are
deleted once the run finishes — they are not the conversation record.

---

## 4. The caveat that gates items 4–12

**Mochi's default chat path is the Claude Agent SDK route, not Mastra.**
`Session.tsx:59-64` picks the route from `settings.preferSubscription`, which
defaults to the Agent SDK. Every primitive in §3 only exists on the Mastra
`/chat/:agentId` path.

This is not news to the codebase. `src/mastra/tools/mochi-tools.ts:55-63` says
so directly — the current `askUser` is deliberately fire-and-forget:

```ts
execute: async () => ({ asked: true })
```

It returns the moment the question is posed. The renderer draws the options from
the tool *input*, and a click sends the chosen text back as an ordinary user
turn. The comment explains why: it "keeps the agent loop free of a
suspend/resume dance and behaves identically on both the Mastra and Agent SDK
backends, which have very different pause semantics."

That design is also the direct cause of backlog item 6. Nothing is suspended, so
nothing stops a second click.

So adopting Mastra's `askUserTool` is **not a drop-in**. It is a three-way
decision, and it should be settled before planning items 6–10:

1. Make the Mastra route the default — changes the billing model, since the
   Agent SDK route is what allows running on a Claude subscription.
2. Reimplement equivalent suspend/resume semantics on the Agent SDK route and
   keep the two in step.
3. Accept divergent behaviour per backend.

**The same applies to item 11.** Before designing anything, establish which
backend performs the file write. If it is the Agent SDK, Mastra's tool approvals
are irrelevant to that bug and the answer lies in Agent SDK permission wiring
instead.

---

## 5. Item 13 — resolved, and it found a live bug

Ran `.claude/skills/mastra/scripts/provider-registry.mjs`. All results below are
**verified** against the live registry on 2026-08-04.

The registry lists **162 providers**. `src/shared/models.ts` `MODEL_CATALOG`
hardcodes 4 providers / 11 entries.

| Catalog entry | Registry |
|---|---|
| `anthropic/claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | all valid (15 models listed) |
| `openai/gpt-5`, `gpt-5-mini`, `text-embedding-3-small` | all valid (47 models listed) |
| `google/gemini-2.5-pro` | valid |
| `ollama/llama3.2`, `ollama/qwen2.5-coder` | **`ollama` is not a provider.** |

There is no `ollama` provider in the registry. The nearest entries are
`ollama-cloud` (19 models) and `lmstudio` (3), and neither `llama3.2` nor
`qwen2.5-coder` appears under `ollama-cloud`.

So `src/shared/models.ts:61-62` is exactly the failure the handoff predicted for
item 13: a stale id that `ModelPicker.tsx` will happily offer, failing as a
silent 404 at request time. Worth confirming whether a locally-running Ollama is
reached some other way before deleting the entries — the file's own header
claims the router "takes any `provider/model` string" — but the registry does
not resolve them.

Also unoffered but available: `anthropic/claude-fable-5`, `claude-opus-4-7`,
`claude-opus-4-6`.

Usage:

```powershell
node .claude\skills\mastra\scripts\provider-registry.mjs --list
node .claude\skills\mastra\scripts\provider-registry.mjs --provider anthropic
```

`MastraModelGateway` (`reference-core-mastra-model-gateway.md`) is the extension
point if the catalogue should be generated rather than hand-typed —
`fetchProviders()` returns `Record<string, ProviderConfig>` with `models`,
`apiKeyEnvVar` and `docUrl` per provider, which is close to what
`ProviderGroup` already wants.

---

## 6. Item 15 — material for the debug logger

Nothing here is wired. All doc-only.

- `reference-logging-pino-logger.md` — the logger itself
- `reference-core-listLogs.md`, `reference-core-listLogsByRunId.md` — read logs
  back out of storage, which is what an in-app pane needs
- `reference-observability-tracing-spans.md`, `-configuration.md`,
  `-instances.md`, `-interfaces.md`, `-span-filtering.md`
- `reference-observability-tracing-exporters-console-exporter.md` — simplest
  exporter to start from
- `reference-observability-tracing-processors-sensitive-data-filter.md` —
  relevant given provider keys go through `safeStorage`
- `docs-observability-metrics-querying.md`, `docs-observability-feedback.md`

---

## 7. Unwired and not mentioned in `mastra-coverage.md`

Worth knowing exists before hand-rolling any of it.

**Processors** — 22 of them, `reference-processors-*.md`. Notable:
`stream-error-retry-processor` (directly relevant to defect D2 — errored turns),
`token-limiter-processor`, `response-cache`, `tool-call-filter`,
`message-history-processor`, `pii-detector`, `moderation-processor`,
`cost-guard-processor`, `prefill-error-handler`.

**Streaming** — `reference-streaming-ChunkType.md` is the enumeration of every
stream chunk type, which is the reference for handling `tool-call-suspended` and
`tool-call-approval`. Also `streamUntilIdle`, `smoothStream`,
`MastraModelOutput`.

**Memory beyond what Mochi uses** — `docs-memory-observational-memory.md`
(automatic summarisation across threads), `docs-memory-multi-user-threads.md`,
`reference-memory-cloneThread.md` (branch a conversation),
`reference-memory-summarizeThread.md`, `generateTitle` for auto thread titles in
a sidebar. `recall()` supports pagination, date-range and metadata filters.

**Long-running** — `docs-long-running-agents-durable-agents.md`,
`-background-tasks.md`, `-goals.md`, `-schedules.md`, `-signals.md`,
`-signal-providers.md`. `followUp`/`steer` are built on signals.

**Auto-resume** — `autoResumeSuspendedTools: true` in an agent's
`defaultOptions` makes a suspended tool resume from the user's *next natural
language message* on the same thread, rather than a button click. Requires
memory, the same thread, and a `resumeSchema` on the tool. Potentially a much
better fit for a chat app than a modal.

---

## 8. Standing rule

From `.agents/skills/mastra/SKILL.md`, and the user's explicit instruction:

> Everything you know about Mastra is likely outdated or wrong. Never rely on
> memory. Always verify against current documentation.

Lookup order: embedded docs → installed source and `.d.ts` → remote
`https://mastra.ai/llms.txt` only if packages are absent. This file is a map of
the first tier, not a substitute for it. Read the actual doc before writing code
against anything listed here.
