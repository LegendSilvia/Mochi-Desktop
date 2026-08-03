# Mastra coverage

What Mochi actually uses from [mastra.ai/docs](https://mastra.ai/docs), and what it
doesn't. Taxonomy taken from `mastra.ai/llms.txt`.

Read this alongside `TASKS.md`: that file is the *intended* surface, this one is the
*implemented* surface. Where they disagree, this file is right.

---

## In use

| Area | Where | Notes |
|---|---|---|
| **Agents** | `src/mastra/index.ts` → `agentFromLoadout` | One `Agent` per loadout, built from persona + model + tools. |
| **Tools** (`createTool`) | `src/mastra/tools/mochi-tools.ts` | `sendSticker`, `setMascotState`, `askUser`. |
| **Models / model router** | `src/shared/models.ts`, loadout `model` | `provider/model` strings; picker in `ModelPicker.tsx`. |
| **Memory** (`@mastra/memory`) | `src/mastra/index.ts` | Working memory + semantic recall, per-loadout toggles. Both constructed only when a key exists — see below. |
| **Embeddings config** | `settings.modelRoles.embeddings` | Consumed by RAG. |
| **Storage — LibSQL** | `src/mastra/index.ts`, `src/main/paths.ts` | `LibSQLStore`; also backs the RAG tables. |
| **Server — Hono adapter** | `src/main/mastra-server.ts` | `MastraServer` mounted on our own Hono app, inside the Electron main process. No `mastra dev` shipped. |
| **Custom API routes** | `src/mastra/index.ts` → `apiRoutes` | `chatRoute({ path: '/chat/:agentId' })`. |
| **Streaming** (`@mastra/ai-sdk`) | `chatRoute` → `useChat` | AI SDK UI-message-stream; the Agent SDK route re-implements the same wire format. |

### One correction worth carrying forward

`createMastra` sets `server.cors`, but that config only applies to Mastra's
**standalone** server. Embedding via `new MastraServer({ app, mastra })` never reads
it, so CORS is registered on the Hono app directly in `mastra-server.ts`. Without
that every renderer request failed its preflight.

---

## Built outside Mastra

These features exist in Mochi but are **not** implemented with Mastra's version of
them, because the app's primary backend is the Claude Agent SDK (so it can run on a
Claude subscription rather than an API key).

| Feature | Mastra offers | Mochi uses instead |
|---|---|---|
| **RAG** | `@mastra/rag` — chunking, vector stores, GraphRAG | `src/main/rag.ts` — LibSQL FTS5 (BM25) + cosine over stored vectors, merged by reciprocal rank. Hand-rolled so keyword search works with no model or key at all. |
| **MCP** | `@mastra/mcp` client/server | Agent SDK `mcpServers`, configured in `ToolsPane.tsx`. |
| **Skills** | Mastra skills | Agent SDK `skills` + `settingSources`. |
| **Subagents / A2A** | Supervisor agents, A2A, Agent Controller | `delegate` tool spawning isolated Agent SDK sessions (`agent-sdk-route.ts`). |
| **Scheduling** | Scheduled workflows, durable agents | Renderer-side idle timer only (`store.tsx`). Not durable — it does not survive a restart. |

---

## Not used at all

Nothing below is wired. Several have UI that is explicitly marked WIP.

**Workflows** — overview, state, control flow, snapshots, suspend/resume,
human-in-the-loop, time-travel debugging, error handling, scheduled workflows.
*(WIP pane exists.)*

**Durable / long-running** — durable agents, background tasks, goals, signals,
Agent Controller (sessions, execution modes, subagent orchestration, tool approvals).
*(`supervised` and `standing` session types are disabled in the UI.)*

**Agent extras** — structured output, agent approval workflows, guardrails,
processors, code mode, ACP.

**Voice** — TTS, STT, speech-to-speech, realtime. *(Deliberately out of scope.)*

**Browser** — AgentBrowser, Stagehand, Firecrawl, recording, BrowserViewer.
*(WIP pane exists.)*

**Channels** — Slack, Teams, Discord, Telegram, WhatsApp, custom adapters.

**Workspaces** — filesystem access, code sandboxes (Docker/E2B/Modal/Vercel/…),
LSP inspection, workspace indexing and search.

**Observability** — Pino logging, metrics, tracing/spans, and every exporter
(Datadog, OTel, Langfuse, LangSmith, Braintrust, Arize, Sentry, PostHog).
*(WIP pane exists.)*

**Evals & scorers** — custom and built-in scorers, quick checks, multi-turn evals,
gates and verdicts, datasets and experiments.

**Auth** — Auth0, Better Auth, Clerk, Firebase, JWT, Okta, Supabase, WorkOS,
fine-grained authorization. *(Single-user desktop app; no server to protect.)*

**Storage beyond LibSQL** — Postgres, MongoDB, DynamoDB, MSSQL, ClickHouse, Redis,
DuckDB, Convex, Upstash; vector stores (Pinecone, Qdrant, Chroma, PgVector,
Weaviate); cloud storage; retention/pruning policies. *(`storageProvider` exists in
settings but only `libsql` is implemented.)*

**Deployment** — every target (Lambda, Cloudflare, Vercel, Netlify, Kubernetes,
Temporal, Inngest). *(Electron app; `electron-builder` instead.)*

**Server extras** — non-Hono adapters, middleware, request context, PubSub.

**Studio** — agent builder, visual tool/skill registries, prompt editor.
*(Mochi's own UI is the alternative.)*

**Networks** — agent networks.

---

## Known gaps in what *is* built

Being explicit so this file isn't read as a completeness claim:

- Semantic recall and the memory embedder are constructed **only when an embedding
  key is present**. Without one, agents fall back to plain message history — running
  purely on a Claude subscription means no semantic recall.
- The Mastra `/chat/:agentId` route is fully wired but is not the default path;
  `preferSubscription` sends traffic to the Agent SDK route instead.
- Storage retention/pruning is unimplemented, so threads and RAG chunks grow without
  bound.
