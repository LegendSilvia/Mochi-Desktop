# Mochi — Feature Backlog

Mochi is a Windows-first Electron desktop console for Mastra AI agents, with a
user-configurable mascot that reacts to agent state and fires **sticker + sound as a
single synchronised event**.

**Goal of this backlog:** every capability in the Mastra documentation
(<https://mastra.ai/docs>) has a home in Mochi. Source of truth is
<https://mastra.ai/llms.txt> — re-fetch it before starting a milestone, the surface
moves fast.

Design source: `design_handoff_mochi_console/` (prototype HTML + README). The
prototype is a **look-and-behaviour reference, not code to port**.

## How to read this

| Field | Meaning |
| --- | --- |
| ID | Stable reference, e.g. `M4-03`. Never renumber. |
| Status | `ready` shipping · `wip` drafted, gated behind a flag · `planned` not started · `n/a` structurally out of scope (reason given) |
| Screen | Where it lands in the UI, per the handoff |

Every task that touches a Mastra API must follow the `mastra` skill: check
`node_modules/@mastra/*/dist/docs/` first, remote docs second. **Do not write Mastra
code from memory.**

---

## Verified environment (checked at time of writing)

| Package | Version |
| --- | --- |
| `mastra` (CLI) | 1.21.0 |
| `@mastra/core` | 1.55.0 |
| `@mastra/memory` | 1.24.0 |
| `@mastra/libsql` | 1.18.0 |
| `@mastra/ai-sdk` | 1.7.0 |
| `@mastra/rag` | 2.4.2 |
| `@mastra/mcp` | 1.15.0 |
| `@mastra/evals` | 1.6.0 |
| `@mastra/client-js` | 1.36.0 |
| `@mastra/observability` | 1.16.3 |
| `@mastra/server` | 1.55.0 |
| `@mastra/deployer` | 1.55.0 |
| `@mastra/pg` | 1.18.1 |

Mastra is on **v1.x**. The handoff's title bar reads `mastra 0.20` — that is stale
placeholder copy; render the real resolved version at runtime (`M0-11`).

Package names for Workspaces, Browser, Channels, Agent Controller, Schedules,
Signals and VOICEVOX voice were **not** resolvable under the obvious
`@mastra/<name>` guesses. Confirm the real import path from the docs page listed on
each task before adding a dependency. Do not guess.

---

## Two architecture decisions to settle first

**1. How the renderer reaches Mastra.** The handoff assumes "Mastra SDK in the main
process, renderer talks over IPC". The official guide
(<https://mastra.ai/guides/getting-started/electron.md>) does something different: it
runs a **Mastra server on `localhost:4111`** and the renderer calls it over HTTP with
`chatRoute()` + `useChat()`, which is what gets you streaming, tool-call parts and
approval states for free.

Recommendation: **embed the Mastra server in the Electron main process** on a random
free port, and have the renderer speak HTTP to it. You keep the documented streaming
path instead of hand-rolling stream framing over IPC, and you avoid shipping a
separate `mastra dev` process. IPC stays for things that are genuinely
main-process-only: filesystem, `safeStorage`, window chrome, toasts. This affects
`M0-04`..`M0-08` — settle it before writing them.

**2. "All Mastra features" includes things a single-user desktop app cannot use.**
Multi-tenant server auth, cloud deploy targets, and Studio itself are structurally
`n/a` here. They are listed in the coverage matrix with a reason rather than dropped,
so the decision is visible and reversible. Everything else has a real task.

---

## M0 · Foundation

| ID | Task | Status |
| --- | --- | --- |
| M0-01 | Scaffold electron-vite + React + TS (`npm create @quick-start/electron@latest --template react-ts`) | planned |
| M0-02 | `npx mastra@latest init`; commit `src/mastra/` (config, agents, tools) | planned |
| M0-03 | TS config: `target`/`module` **ES2022**, `moduleResolution: bundler`. CommonJS breaks Mastra | planned |
| M0-04 | Decide + document the renderer↔Mastra transport (see above); write it as an ADR | planned |
| M0-05 | Embed the Mastra server in the main process; pick a free port, expose it to the renderer | planned |
| M0-06 | `chatRoute()` wired for agent-scoped chat (`/chat/:agentId`) | planned |
| M0-07 | CSP + CORS for the chosen origin/port — not `origin: '*'` in production | planned |
| M0-08 | Typed IPC bridge for main-only concerns (fs, keychain, window, toasts) | planned |
| M0-09 | LibSQL storage under `%APPDATA%\Mochi\`; run migrations on first launch | planned |
| M0-10 | Design tokens as CSS custom properties; dark default, light swap, contrast multiplier (×0.62 / ×1 / ×1.5) | planned |
| M0-11 | Title bar shows the **resolved** Mastra version, not a hard-coded string | planned |
| M0-12 | Bundle Plus Jakarta Sans + JetBrains Mono locally as `@font-face` (neither ships with Windows) | planned |
| M0-13 | Lucide icon set, 1.7–1.9 stroke, round caps | planned |
| M0-14 | Platform key-label helper — `Ctrl`/`Alt` on Windows, `⌘`/`⌥` later. Never hard-code a glyph | planned |
| M0-15 | Frameless `BrowserWindow`, `titleBarStyle: 'hidden'` + `titleBarOverlay`; re-apply overlay colours on theme change | planned |
| M0-16 | App shell: 1440×888 design size, `minWidth: 1180`, `minHeight: 760`; verify at 125% and 150% scaling | planned |
| M0-17 | Restyled scrollbars; 2px accent focus ring, 2px offset — never the browser default | planned |

## M1 · Mascot layer (the differentiator — build before any Mastra screen)

Docs: Mochi-specific, no Mastra equivalent. Screen: app-level overlay.

| ID | Task | Status |
| --- | --- | --- |
| M1-01 | Overlay element at `z-index: 40`, column layout: bubble · shell · ground shadow | planned |
| M1-02 | Four shell variants: `bare`, `card` (default), `orb`, `terrarium`; `.35s ease` transition | planned |
| M1-03 | Sprite 112px default, range 72–200, `object-fit: contain`, `pointer-events: none` | planned |
| M1-04 | Idle loops `breathe` / `float` / `sway` / `still` — **must not restart on re-render** | planned |
| M1-05 | Ground ellipse 66×8, `blur(5px)`, animated in step with the idle loop | planned |
| M1-06 | Drag via pointer capture → `transform: translate3d()` direct, one write per frame, never through React state | planned |
| M1-07 | Persist position to `localStorage['mochi.mascot.pos']`; settle bounce 420ms `cubic-bezier(.2,1.4,.4,1)` | planned |
| M1-08 | On load, clamp into frame; **reject** a stored position covering rail or title bar (`x < 252 \|\| y < 92`) | planned |
| M1-09 | Six states: `idle` `thinking` `tool-running` `error` `done` `sleeping` | planned |
| M1-10 | `fireSticker()` — one call: sound + squash-stretch (720ms) + state label + render. This is the core contract | planned |
| M1-11 | Choreography `chat` — sticker pops in thread, 620ms | planned |
| M1-12 | Choreography `bubble` — speech bubble, 2600ms in/hold/out, random line from the copy set | planned |
| M1-13 | Choreography `overlay` — full-frame scrim + 280px card, 1500ms | planned |
| M1-14 | Web Audio playback of user files; gentle envelope; resume suspended `AudioContext` on first gesture | planned |
| M1-15 | Recreate `AudioContext` on `devicechange` (headphones unplugged mid-session) | planned |
| M1-16 | Respect global sound toggle + quiet hours before any sound | planned |
| M1-17 | Windows toast + taskbar flash when a sticker fires while unfocused; register an AppUserModelID | planned |
| M1-18 | Bind mascot state to **live agent state** from Mastra streaming — the layer is worthless if it doesn't react | planned |

## M2 · Agents core

Docs: `/docs/agents/*`. Screen: Agents & loadouts, Session.

| ID | Task | Status |
| --- | --- | --- |
| M2-01 | Agent CRUD — loadout **is** the agent (persona, sprite, stickers, voice, tools, model, memory, sliders) | planned |
| M2-02 | Agents & loadouts grid: 52px avatar, chips, status line, dashed "New loadout" tile | planned |
| M2-03 | Config panel — identity (name, id, instructions, expected output, model) | planned |
| M2-04 | Behaviour panel — chattiness + sticker-frequency sliders, memory/recall/voice toggles | planned |
| M2-05 | Tools on agents — `/docs/agents/using-tools` | planned |
| M2-06 | Structured output — `/docs/agents/structured-output` | planned |
| M2-07 | Agent approval — `/docs/agents/agent-approval`; surfaces as "what it may do here" chips | planned |
| M2-08 | Supervisor agents + `@mention` delegation — `/docs/agents/supervisor-agents` | planned |
| M2-09 | Subagent memory isolation — only delegation prompt + response persist | planned |
| M2-10 | Delegation block UI: iteration count, elapsed, `prompt →`, lock-icon footnote | planned |
| M2-11 | Guardrails — `/docs/agents/guardrails` | planned |
| M2-12 | Processors — `/docs/agents/processors` | planned |
| M2-13 | Code mode — `/docs/agents/code-mode` | planned |
| M2-14 | Agent skills — `/docs/agents/skills` | planned |
| M2-15 | Skill registries — `/docs/agent-builder/skill-registries` | planned |
| M2-16 | A2A connection — `/docs/agents/a2a` | planned |
| M2-17 | ACP connection — `/docs/agents/acp` | planned |
| M2-18 | SDK agents — `/docs/agents/sdk-agents` | planned |
| M2-19 | Mochi-native tools `sendSticker()` and `setMascotState()` as first-class agent tools | planned |

## M3 · Session (Agent Controller)

Docs: `/docs/agent-controller/*`, `/guides/concepts/streaming`. Screen: Session.

| ID | Task | Status |
| --- | --- | --- |
| M3-01 | Session model + rail list with Pinned / Recents, drag to re-group | planned |
| M3-02 | Agent Controller session — `/docs/agent-controller/session` | planned |
| M3-03 | Controller modes — `/docs/agent-controller/modes` | planned |
| M3-04 | Threads and state — `/docs/agent-controller/threads-and-state` | planned |
| M3-05 | Subagents — `/docs/agent-controller/subagents` | planned |
| M3-06 | Tool approvals — `/docs/agent-controller/tool-approvals` | planned |
| M3-07 | Streaming render: text parts, tool parts, approval states (`input-streaming` → `output-error`) | planned |
| M3-08 | Message list — user bubble, agent message, tool-call group card | planned |
| M3-09 | Sticker message tile (186px) + play pill + 5-bar waveform + rule caption | planned |
| M3-10 | Diff card with gutter, `+n` accent / `−n` rose tinted rows | planned |
| M3-11 | Repo strip — branch, `+22 −0` chip, workspace path; only when the session touches code | planned |
| M3-12 | Branch strip above composer with **Review** action | planned |
| M3-13 | Composer + toolbar (attach, workspace, `@agent`, sticker, mic, send) + hint row | planned |
| M3-14 | `@mention` popover — "Sprout stays the supervisor" | planned |
| M3-15 | Right panel: mascot card, agents-in-session, this-run timeline, rules armed, background tasks, files touched, open file, permission chips | planned |
| M3-16 | Start-a-session screen — agent required, default pre-selected, 4 session types | planned |
| M3-17 | Session types `Supervised` and `Standing` behind a feature flag | wip |
| M3-18 | `Scratch` session type — no memory, nothing saved | planned |

## M4 · Memory

Docs: `/docs/memory/*`. Screen: Settings → Memory.

| ID | Task | Status |
| --- | --- | --- |
| M4-01 | Memory overview wiring — `/docs/memory/overview` | planned |
| M4-02 | Message history — `/docs/memory/message-history` | planned |
| M4-03 | Working memory as editable fact cards + "add a fact" | planned |
| M4-04 | Semantic recall — toggle, top-matches slider, scope pills | planned |
| M4-05 | Observational memory — `/docs/memory/observational-memory` | planned |
| M4-06 | Memory processors — `/docs/memory/memory-processors` | planned |
| M4-07 | Thread list + "where it lives" panel | planned |
| M4-08 | Multi-user threads — `/docs/memory/multi-user-threads` | n/a — single-user desktop; revisit if Mochi gets sharing |

## M5 · Workflows

Docs: `/docs/workflows/*`. Screen: Settings → Workflows (drafted WIP in the prototype).

| ID | Task | Status |
| --- | --- | --- |
| M5-01 | Workflow registry + list | wip |
| M5-02 | Workflow state — `/docs/workflows/workflow-state` | planned |
| M5-03 | Control flow (branch, parallel, loop) — `/docs/workflows/control-flow` | planned |
| M5-04 | Agents and tools as steps — `/docs/workflows/agents-and-tools` | planned |
| M5-05 | Snapshots — `/docs/workflows/snapshots` | planned |
| M5-06 | Suspend and resume — `/docs/workflows/suspend-and-resume` | planned |
| M5-07 | Human-in-the-loop, surfaced as a mascot prompt | planned |
| M5-08 | Time travel — `/docs/workflows/time-travel` | planned |
| M5-09 | Error handling — `/docs/workflows/error-handling` | planned |
| M5-10 | Scheduled workflows — `/docs/workflows/scheduled-workflows` | planned |
| M5-11 | Graph editor UI (the actual WIP screen) | wip |

## M6 · Workspaces

Docs: `/docs/workspace/*`. Screen: Settings → Workspace access + Session panel.

| ID | Task | Status |
| --- | --- | --- |
| M6-01 | Workspace overview + registration | planned |
| M6-02 | Filesystem access — `/docs/workspace/filesystem` | planned |
| M6-03 | Sandbox — `/docs/workspace/sandbox` | planned |
| M6-04 | LSP inspection — `/docs/workspace/lsp` | planned |
| M6-05 | Workspace skills — `/docs/workspace/skills` | planned |
| M6-06 | Search and indexing — `/docs/workspace/search` | planned |
| M6-07 | File tree + preview + Allowed/Never permission chips | planned |
| M6-08 | Windows paths only — never build with `/`; show native form | planned |

## M7 · RAG

Docs: `/docs/rag/*`. Screen: Settings → RAG & sources.

| ID | Task | Status |
| --- | --- | --- |
| M7-01 | Source table — Source / Kind / Chunks / State | planned |
| M7-02 | Chunking + embedding, strategy pills, chunk-size and overlap sliders | planned |
| M7-03 | Vector databases — `/docs/rag/vector-databases` | planned |
| M7-04 | Retrieval + rerank rows | planned |
| M7-05 | GraphRAG — `/docs/rag/graph-rag` | planned |
| M7-06 | "Try a question" box with scored results | planned |

## M8 · Tools & MCP

Docs: `/docs/mcp/*`, `/docs/agents/using-tools`. Screen: Settings → Tools & MCP.

| ID | Task | Status |
| --- | --- | --- |
| M8-01 | Tool table — id / description / from | planned |
| M8-02 | MCP client + server cards with live status — `/docs/mcp/overview` | planned |
| M8-03 | MCP Apps — `/docs/mcp/mcp-apps` | planned |
| M8-04 | Tool providers / integrations — `/docs/agent-builder/integrations` | planned |
| M8-05 | `sendSticker` + `setMascotState` listed as first-class Mochi tools | planned |

## M9 · Channels (two-way command, not notifications)

Docs: `/docs/capabilities/channels/*`, `/docs/agent-controller/channels`. Screen: Settings → Channels.

| ID | Task | Status |
| --- | --- | --- |
| M9-01 | Channel overview + "Listening in" list with unread counts | planned |
| M9-02 | Slack — `/docs/capabilities/channels/slack` | planned |
| M9-03 | Discord — `/docs/capabilities/channels/discord` | planned |
| M9-04 | Microsoft Teams | planned |
| M9-05 | Telegram | planned |
| M9-06 | WhatsApp | planned |
| M9-07 | Other adapters + web widget | planned |
| M9-08 | *How it hears you* — mention / prefix / every message, thread follow-ups, read uploads, share memory | planned |
| M9-09 | *Who can command it* — per-person permission rows, allowlist refusal path | planned |
| M9-10 | *What it may send back* — text, files, **stickers**, voice notes, sound (off; chat apps can't autoplay) | planned |
| M9-11 | Sticker delivery mode + quiet hours | planned |
| M9-12 | Stickers uploaded as images to the channel; sound plays on desktop only | planned |

## M10 · Voice

Docs: `/docs/voice/*`. Screen: Settings → Voice.

| ID | Task | Status |
| --- | --- | --- |
| M10-01 | Text to speech | planned |
| M10-02 | Speech to text + push-to-talk (`Alt Space` as a global shortcut — collides with the Windows system menu) | planned |
| M10-03 | Speech to speech | planned |
| M10-04 | Realtime voice | planned |
| M10-05 | VOICEVOX card — endpoint `localhost:50021`, speaker, style, speed/pitch/intonation, "Hear it" | planned |
| M10-06 | Mascot lip-sync, ducking, "speak every reply" (off by default) | planned |
| M10-07 | Detect VOICEVOX/Ollama not running; friendly state + install link, never silent failure | planned |

## M11 · Long-running agents

Docs: `/docs/long-running-agents/*`. Screen: Settings → Goals & schedules.

| ID | Task | Status |
| --- | --- | --- |
| M11-01 | Durable agents — `/docs/long-running-agents/durable-agents` | planned |
| M11-02 | Background tasks with spinner rows + elapsed time | planned |
| M11-03 | Goals with progress bars | planned |
| M11-04 | Schedules (cron) | planned |
| M11-05 | Signals — `/docs/long-running-agents/signals` | planned |
| M11-06 | Signal providers — `/docs/long-running-agents/signal-providers` | planned |
| M11-07 | Stickers queue while the user is away, replay on return | planned |
| M11-08 | `Standing` session type wired to schedules | wip |

## M12 · Models & providers

Docs: `/models/*`. Screen: Settings → Models & providers.

| ID | Task | Status |
| --- | --- | --- |
| M12-01 | Provider table — Provider / Billed via / Account, with `subscription` `api key` `local` chips | planned |
| M12-02 | Add-a-provider card — *Sign in with a plan* ↔ *Paste an API key* | planned |
| M12-03 | Store keys in Windows Credential Manager via `safeStorage`, **never** a JSON file | planned |
| M12-04 | Model router `"provider/model"` format; validate against the live registry, never a hard-coded list | planned |
| M12-05 | *Which model does what* — conversation / quick jobs / embeddings / eval grader | planned |
| M12-06 | Prefer-subscription and fall-back-to-Ollama-when-offline toggles | planned |
| M12-07 | Embeddings config — `/models/embeddings` | planned |
| M12-08 | Gateways — `/models/gateways` | planned |
| M12-09 | Spend tracker with cap, progress bar, 80% warning toggle | planned |
| M12-10 | Environment variables — `/models/environment-variables` | planned |

## M13 · Storage

Docs: `/docs/storage/overview`. Screen: Settings → Storage.

| ID | Task | Status |
| --- | --- | --- |
| M13-01 | LibSQL (default, local) | planned |
| M13-02 | Postgres option — `@mastra/pg` | planned |
| M13-03 | Upstash option | planned |
| M13-04 | Table listing: `mastra_threads`, `mastra_messages`, `mastra_vectors`, `mochi_mascot_presets`, `mochi_sticker_events` | planned |
| M13-05 | Mochi-owned tables + migrations for presets and sticker events | planned |

## M14 · Observability & Evals

Docs: `/docs/observability/*`, `/docs/evals/*`. Screen: Settings → Traces & evals (WIP).

| ID | Task | Status |
| --- | --- | --- |
| M14-01 | Tracing — `/docs/observability/tracing/overview` | wip |
| M14-02 | Logging — `/docs/observability/logging` | planned |
| M14-03 | Metrics + querying | planned |
| M14-04 | Feedback — `/docs/observability/feedback` | planned |
| M14-05 | `SensitiveDataFilter` processor — required before any exporter leaves the machine | planned |
| M14-06 | Exporters (Langfuse, LangSmith, Braintrust, Datadog, Sentry, PostHog, Arize, Arthur, Laminar, OTel) | planned |
| M14-07 | Bridges — Datadog, OpenTelemetry | planned |
| M14-08 | Built-in scorers — `/docs/evals/built-in-scorers` | planned |
| M14-09 | Custom scorers | planned |
| M14-10 | Quick checks, gates and verdicts | planned |
| M14-11 | Multi-turn evals, evals with memory | planned |
| M14-12 | Datasets + running experiments | planned |
| M14-13 | Running in CI — `/docs/evals/running-in-ci` | planned |
| M14-14 | Trace Intelligence view (private beta) — themes across goal/outcome/behavior/sentiment | planned |

## M15 · Browser

Docs: `/docs/browser/*`. Screen: Settings → Browser (WIP).

| ID | Task | Status |
| --- | --- | --- |
| M15-01 | AgentBrowser — `/docs/browser/agent-browser` | wip |
| M15-02 | BrowserViewer live agent view | wip |
| M15-03 | Stagehand | planned |
| M15-04 | Firecrawl | planned |
| M15-05 | Recording — `/docs/browser/recording` | planned |

## M16 · Stickers & sound (Mochi-native)

Screen: Stickers & sound, Mascot studio.

| ID | Task | Status |
| --- | --- | --- |
| M16-01 | Sticker grid, tag filter pills, dashed `+` tile | planned |
| M16-02 | Sound list with play buttons + drop target for wav/mp3/ogg | planned |
| M16-03 | Rules table — When / Sticker / Sound / Show as / How often / on-off | planned |
| M16-04 | "Agent may also pick freely" toggle → exposes `sendSticker()` | planned |
| M16-05 | Rate limiting — `always` / `once per hour` / `once` | planned |
| M16-06 | Mascot studio: 6 state tiles, drop target (filename → state), recolour swatches, hue-shift | planned |
| M16-07 | Studio stage — 190px sprite, radial accent wash, live state chips | planned |
| M16-08 | Size/opacity sliders, idle-motion pills, physics toggles | planned |
| M16-09 | State → sprite → sound table | planned |
| M16-10 | Personality panel + hotkeys | planned |
| M16-11 | `chokidar`-style folder watcher — dropping a PNG updates the grid live | planned |

## M17 · Shell, settings, polish

| ID | Task | Status |
| --- | --- | --- |
| M17-01 | Settings modal shell — 1120×690, grouped nav (You / Agent / Work / Reach / System) | planned |
| M17-02 | Rail: head, scroll body, footer + account popover | planned |
| M17-03 | Drag-to-pin / drag-to-unpin with dashed accent drop zones | planned |
| M17-04 | Search pill + `Ctrl K` palette over agents, tools, stickers | planned |
| M17-05 | Full keyboard map (see handoff table); user-rebindable | planned |
| M17-06 | Theme + contrast + accent switching, live | planned |
| M17-07 | **Design notes & coverage** pane — renders this backlog's coverage matrix in-app | planned |
| M17-08 | Defaults pane — default agent, default session type, on-launch behaviour | planned |
| M17-09 | Placeholder `art?` tiles wherever user artwork is absent | planned |

## M18 · Packaging & release

| ID | Task | Status |
| --- | --- | --- |
| M18-01 | electron-builder NSIS installer, per-user (no admin prompt) | planned |
| M18-02 | Code-sign the installer — unsigned means a SmartScreen warning for every first-time user | planned |
| M18-03 | Auto-update feed, wired early | planned |
| M18-04 | Windows Defender Firewall first-launch prompt shown as a friendly state | planned |
| M18-05 | Bundle the Mastra server runtime into the packaged app (no separate `mastra dev`) | planned |
| M18-06 | Crash reporting + opt-in diagnostics | planned |

---

## Mastra coverage matrix

Every section of <https://mastra.ai/llms.txt> and where it lands. Keep this in sync —
`M17-07` renders it inside the app.

| Mastra docs area | Mochi home | Tasks | Status |
| --- | --- | --- | --- |
| Agents: overview, tools, structured output | Agents & loadouts | M2-01..06 | planned |
| Agents: approval | Session permission chips | M2-07, M3-06 | planned |
| Agents: supervisor | Session `@mention` | M2-08..10 | planned |
| Agents: guardrails, processors, code mode | Agent config | M2-11..13 | planned |
| Agents: skills, skill registries | Agent config | M2-14, M2-15 | planned |
| Agents: A2A, ACP, SDK agents | Agent connections | M2-16..18 | planned |
| MCP: overview, MCP Apps | Tools & MCP | M8-02, M8-03 | planned |
| Workflows (all 10 pages) | Settings → Workflows | M5-01..11 | wip |
| Memory (7 pages) | Settings → Memory | M4-01..08 | planned |
| Agent Controller (7 pages) | Session | M3-02..06 | planned |
| Workspaces (6 pages) | Workspace access | M6-01..08 | planned |
| Browser (6 pages) | Settings → Browser | M15-01..05 | wip |
| Channels (7 pages) | Settings → Channels | M9-01..12 | planned |
| RAG (5 pages) | RAG & sources | M7-01..06 | planned |
| Voice (5 pages) | Settings → Voice | M10-01..07 | planned |
| Long-running agents (6 pages) | Goals & schedules | M11-01..08 | planned |
| Storage | Settings → Storage | M13-01..05 | planned |
| Models, embeddings, gateways, env vars | Models & providers | M12-01..10 | planned |
| Observability (all) | Traces & evals | M14-01..07 | wip |
| Evals (9 pages) | Traces & evals | M14-08..13 | planned |
| Trace Intelligence | Traces & evals | M14-14 | planned |
| Server: custom API routes, Mastra Client | Foundation | M0-05, M0-06 | planned |
| Server: middleware, request context, PubSub | Internal | M0-05 | planned |
| Server: adapters | Embedded server | M18-05 | planned |
| File-based agents | Loadout import/export | M2-01 | planned |
| Streaming | Session render | M3-07 | planned |
| Multi-agent systems | Supervisor | M2-08 | planned |
| AI SDK / AI SDK UI | Session render | M0-06, M3-07 | planned |
| Electron guide | Foundation | M0-01..08 | planned |
| Server auth (14 providers) | — | — | **n/a** — single local user, no multi-tenant surface |
| Studio, Agent Builder, Editor | — | — | **n/a** — Mochi *is* the alternative console; borrow ideas, don't embed |
| Deployment (cloud, workers, monorepo, sandbox) | — | M18-05 | **n/a** except local packaging |
| Memory: multi-user threads | — | M4-08 | **n/a** — single user |
| Guides: Next.js/Astro/Nuxt/Express/etc. | — | — | **n/a** — not a web app |
| Migrations v1.0 | — | — | **n/a** — greenfield on v1.x |

**Four `n/a` groups are a judgement call, not a gap.** If Mochi ever grows team
sharing or a hosted mode, server auth, multi-user threads and cloud deployment come
back on the board. Flagging them here so that decision is explicit.

---

## Suggested order

1. **M0** foundation — nothing else can start
2. **M1** mascot layer — it is the product's reason to exist; building it late means
   retrofitting state plumbing through every screen
3. **M2 + M3** agents and sessions — the app becomes usable
4. **M4, M8, M12, M13** memory, tools, models, storage — the agent becomes capable
5. **M16, M17** stickers and shell — the app becomes *Mochi*
6. **M6, M7, M10, M11** workspaces, RAG, voice, long-running
7. **M9** channels — reach beyond the desktop
8. **M5, M14, M15** workflows, observability, browser — the WIP screens made real
9. **M18** packaging

## Standing rules

- Re-fetch `https://mastra.ai/llms.txt` before each milestone.
- Never write Mastra code from memory — embedded docs first, remote docs second.
- Verify model names with `node .agents/skills/mastra/scripts/provider-registry.mjs
  --provider <name>` (needs `@mastra/core` installed).
- Every Mastra capability carries the mascot/sticker/sound layer with it, including
  agents reached over Slack and Discord.
- Soft, low-contrast, easy on the eyes. No hard edges, no saturated accents, no pure
  black or white. Nothing is square-cornered.
- The attached "Modernist" design system (0px radius, `#ec3013`) was **deliberately
  overridden by the user**. Do not reintroduce it.
