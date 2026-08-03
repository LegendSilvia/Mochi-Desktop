# Mochi

A Windows-first desktop console for [Mastra](https://mastra.ai) AI agents, with a
configurable mascot that reacts to what the agent is doing and fires **sticker +
sound as a single synchronised event**.

Electron + Vite + React + TypeScript. The full feature backlog lives in
[`TASKS.md`](TASKS.md) — 197 tasks mapped against every area of the Mastra docs.

## Running it

```bash
npm install
npm run dev
```

You need an API key for at least one model provider. Add it in **Settings →
Models & providers** — it goes into the Windows Credential Manager via Electron's
`safeStorage`, never into a file in the repo. Without a key the app still starts
and every screen works; only the agent call fails.

```bash
npm run typecheck   # tsc over main, preload and renderer
npm run lint
npm run build       # typecheck + electron-vite build
npm run build:win   # NSIS installer
```

## How it's wired

**The renderer talks to Mastra over HTTP, not IPC.** The design handoff assumed
IPC, but Mastra's documented path is an HTTP server, and going through it is what
gives us streaming, tool-call parts and approval states without hand-rolling
stream framing. So:

- `src/mastra/` — the Mastra instance: agents built from loadouts, `sendSticker`
  and `setMascotState` as first-class tools, LibSQL storage, `chatRoute()`.
- `src/main/mastra-server.ts` — runs that instance on an embedded Hono server
  **inside the Electron main process**, bound to a free port on `127.0.0.1`. One
  process, no `mastra dev` to ship. The port is chosen at runtime; 4111 is never
  assumed available.
- `src/main/` — window chrome, the `mochi-asset://` protocol for user artwork,
  the credential store, and the folder watcher.
- `src/preload/` — the typed bridge. IPC is kept for what is genuinely
  main-process-only: filesystem, keychain, window, toasts.
- `src/renderer/` — the UI.
- `src/shared/` — types and seed data used by all three.

Verified end to end: the server binds, `/api/agents` lists both agents with their
tool schemas, and `POST /chat/:agentId` streams AI SDK frames.

## The mascot layer

The reason the app exists, so it is an app-level overlay rather than a
per-screen component (`src/renderer/src/components/mascot/`).

- Four shells (`bare` / `card` / `orb` / `terrarium`), four idle motions, six
  states, size 72–200px.
- Drag writes straight to `transform` one frame at a time — never through React
  state, or the drag feels like mud. Position persists, and a stored position
  that would cover the rail or title bar is **rejected** rather than clamped.
- `fireSticker()` is the single entry point: sound, squash-and-stretch, state
  label and render targets all happen in one call, so they cannot drift apart.
- Three choreography modes — `chat`, `bubble`, `overlay` — any combination.
- The mascot follows the **live agent stream**: `thinking` while streaming,
  `error` on failure, back to `idle` when ready. An agent can also drive it
  directly through `setMascotState`.

Drop your own artwork into the folders under `%APPDATA%\Mochi\` — `mascots/`,
`stickers/`, `sounds/`. The grid updates live; the file name becomes the state
(`work.png` fills `tool-running`). Until then, tiles show `art?` placeholders and
a built-in chime stands in for sound.

## What's built vs. drafted

Built and usable: app shell, rail with drag-to-pin, mascot layer, Start a
session, Session with live streaming, Agents & loadouts, Mascot studio, Stickers
& sound with the rules table, and the Settings panes for Models & providers,
Defaults, Memory, Tools & MCP, Storage, Channels, Voice, Workspace access, RAG
and Goals & schedules.

Deliberately **not** built, and gated in the UI as `wip`: Workflows, Browser,
Traces & evals, and the *Supervised* / *Standing* session types. They render a
pane saying what they will be and which tasks cover them, rather than a fake UI
that looks finished.

Several settings panes render the real shape from the handoff but are not yet
wired to the Mastra capability behind them. Each one says so on screen and cites
its task ID. **Settings → Design notes & coverage** has the full map.

### VOICEVOX

Skipped on purpose. It is not an MCP server — it's a local HTTP text-to-speech
service on `localhost:50021`, so wiring it means an HTTP client plus a running
Windows process to test against, and neither the voice pipeline (M10-01..M10-06)
nor a machine to verify it on was in reach here. The Voice pane says it is
unwired rather than pretending otherwise.

## Known gaps

- Semantic recall needs a vector store **and** a reachable embedder. Both are
  constructed only when the embedding provider's key is present; otherwise the
  agent degrades to plain message history instead of failing to start.
- Working-memory facts in the Memory pane are local to the UI (M4-03).
- Spend figures on the Models pane are a placeholder until provider billing is
  wired (M12-09).
- Never tested on real Windows — built and verified headless on Linux. The
  Windows-specific chrome (`titleBarOverlay`, toasts, Credential Manager) is
  written to the documented APIs but wants a pass on real hardware.

## Design constraints

Soft, low-contrast, easy on the eyes. No hard edges, no saturated accents, no
pure black or pure white. Nothing is square-cornered. Dark is the default;
contrast is a multiplier over one palette rather than three hand-written ones.

The "Modernist" system attached to the source project (0px radius, `#ec3013`) was
deliberately overridden by the user. Do not reintroduce it.
