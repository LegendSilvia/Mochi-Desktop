import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import type { AnyWorkspace } from '@mastra/core/workspace'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import { Memory } from '@mastra/memory'
import { TaskSignalProvider } from '@mastra/core/signals'
import { LibSQLStore, LibSQLVector } from '@mastra/libsql'
import { chatRoute } from '@mastra/ai-sdk'
import { mochiTools, type MochiToolId } from './tools/mochi-tools'
import { DEFAULT_AGENTS, DEFAULT_RECALL_TOP_K } from '../shared/defaults'
import type { AgentLoadout } from '../shared/types'

/**
 * The Mastra instance Mochi runs against.
 *
 * Constructed by the Electron main process and served over an embedded Hono
 * server (src/main/mastra-server.ts) — there is no separate `mastra dev` process
 * in the shipped app.
 */

/**
 * Embedding servers that run on this machine and speak OpenAI's
 * `/v1/embeddings` shape.
 *
 * Passing a `url` makes the model router skip both its provider registry and
 * its API-key check, which is the whole point: Anthropic has no embeddings API,
 * so someone on a Claude subscription has no key for this and no way to get
 * one. A local embedder is what keeps semantic recall from being a feature only
 * OpenAI customers can switch on.
 *
 * Same server RAG already talks to (src/main/rag.ts) — one local embedder for
 * the app, not two.
 */
const LOCAL_EMBEDDERS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434/v1'
}

/**
 * The embedder for a model-role string, or null when none can be built.
 *
 * Semantic recall needs a vector store *and* a reachable embedder, so this is
 * decided up front: recall degrades to plain message history rather than
 * taking the whole server down.
 *
 * The hosted branch lets the router do the deciding rather than keeping a
 * second copy of its provider table here. Its constructor already throws both
 * for a provider it doesn't know and for a missing key. The copy this replaces
 * had drifted: it answered "yes, that works" for any provider it didn't
 * recognise, so pointing embeddings at `ollama/…` — which is *not* a router
 * provider — threw `Unknown provider` while building the agent and took the
 * whole Mastra server down at startup.
 */
export function embedderFor(embeddingModel: string): ModelRouterEmbeddingModel | null {
  const [providerId, ...rest] = (embeddingModel ?? '').split('/')
  const modelId = rest.join('/')
  if (!providerId || !modelId) return null

  const url = LOCAL_EMBEDDERS[providerId]
  if (url) return new ModelRouterEmbeddingModel({ providerId, modelId, url })

  try {
    // The object form, not `provider/model`. The string form splits on every
    // slash and rejects anything that isn't exactly two parts, which rules out
    // every OpenRouter id — they carry the upstream provider in the model, as
    // in `openrouter` + `openai/text-embedding-3-small`.
    return new ModelRouterEmbeddingModel({ providerId, modelId })
  } catch {
    // No key for this provider, or not one the router knows.
    return null
  }
}

/**
 * How many matches recall pulls in, clamped to the range the UI offers.
 *
 * Loadouts saved before this setting existed have no value at all — the store
 * merges settings shallowly and does not backfill agents — so the default is
 * applied here rather than trusted to be present.
 */
function recallTopK(loadout: AgentLoadout): number {
  const wanted = loadout.recallTopK ?? DEFAULT_RECALL_TOP_K
  return Math.min(20, Math.max(1, Math.round(wanted)))
}

export interface BuildAgentOptions {
  databaseUrl: string
  embeddingModel: string
  /** Injected by main — the folder-keyed Workspace cache in src/main/workspace.ts.
   *  Passed in rather than imported so this module stays free of main-process
   *  imports; both run in the same process, but the dependency only points one
   *  way. */
  workspaceFor?: (folder: string) => AnyWorkspace | null
}

/** Build a Mastra Agent from a Mochi loadout. Loadout *is* the agent. */
export function agentFromLoadout(loadout: AgentLoadout, opts: BuildAgentOptions): Agent {
  const tools = Object.fromEntries(
    loadout.toolIds
      .filter((id): id is MochiToolId => id in mochiTools)
      .map((id) => [id, mochiTools[id]])
  )

  // Chattiness and "can push without asking" are behaviour knobs, not model
  // params — the cheapest honest way to honour them is to say so in the prompt.
  const behaviour = [
    loadout.chattiness <= 3
      ? 'Keep replies short. No preamble.'
      : loadout.chattiness >= 8
        ? 'You may think out loud and explain your reasoning.'
        : 'Explain briefly, then get to the point.',
    loadout.canPushWithoutAsking
      ? ''
      : 'Never push to git without asking the user first. Show the diff and wait.'
  ]
    .filter(Boolean)
    .join('\n')

  // The vector store is only built once we know an embedder exists to fill it.
  // A fresh install with no keys and no local embedder still starts and chats —
  // it just falls back to plain message history.
  const embedder = loadout.semanticRecall ? embedderFor(opts.embeddingModel) : null
  const recallParts = embedder
    ? {
        vector: new LibSQLVector({ id: `mochi-vector-${loadout.id}`, url: opts.databaseUrl }),
        embedder
      }
    : {}

  return new Agent({
    id: loadout.id,
    name: loadout.name,
    instructions: `${loadout.instructions}\n\n${behaviour}`,
    model: loadout.model,
    tools,
    // Task tracking. Registered as a signal provider rather than by adding the
    // four task tools by hand: the provider also installs `TaskStateProcessor`,
    // and without that the tools work for a single turn and then silently lose
    // the list. Not a loadout toggle — nothing happens unless the model chooses
    // to call them, and a plan that vanishes when you switch loadout would be
    // worse than no plan. Requires a memory-backed thread, which the `memory`
    // below always provides (only *semantic recall* needs an embedding key).
    signals: [new TaskSignalProvider()],
    /**
     * The folder, resolved per request.
     *
     * The agent is built once at startup, long before any session picks a
     * folder, so this cannot be a fixed workspace. Resolving it per request from
     * `requestContext` also means one agent serves every session rather than
     * needing a rebuild each time a folder changes.
     *
     * What comes back is the *same* Workspace object the file navigator, editor
     * and search widgets use — one LocalFilesystem, one sandbox, one LSP per
     * folder. That is what makes an agent edit and a widget save collide
     * honestly through mtimes instead of silently overwriting each other.
     */
    workspace: opts.workspaceFor
      ? ({ requestContext }): AnyWorkspace | undefined => {
          const folder = requestContext?.get('workspacePath')
          if (typeof folder !== 'string' || !folder) return undefined
          return opts.workspaceFor?.(folder) ?? undefined
        }
      : undefined,
    memory: new Memory({
      storage: new LibSQLStore({ id: `mochi-store-${loadout.id}`, url: opts.databaseUrl }),
      ...recallParts,
      options: {
        lastMessages: 20,
        workingMemory: { enabled: loadout.workingMemory },
        /**
         * Recall is what reaches past `lastMessages` — the twenty-first message
         * back is gone otherwise, however relevant it is.
         *
         * `messageRange` is not a loadout knob because a bare match is close to
         * useless: recalling "use the staging bucket" without the question it
         * answered gives the model a fragment it has to guess the context of.
         * Two either side is the smallest window that keeps a match legible.
         *
         * Thread scope, deliberately. `scope: 'resource'` would search every
         * session at once, and every session shares one resource id — so a
         * question about one project would pull in fragments of every other,
         * which is worse than not recalling at all.
         */
        semanticRecall: embedder
          ? { topK: recallTopK(loadout), messageRange: 2, scope: 'thread' as const }
          : false
      }
    })
  })
}

export interface CreateMastraOptions {
  /** LibSQL file: URL, under %APPDATA%\Mochi on Windows. */
  databaseUrl: string
  loadouts?: AgentLoadout[]
  /** Model-router string for embeddings, e.g. `openai/text-embedding-3-small`. */
  embeddingModel?: string
  /** Injected by main so the agent and the widgets share one Workspace per
   *  folder. Omit and the agent simply has no file tools. */
  workspaceFor?: (folder: string) => AnyWorkspace | null
}

export function createMastra({
  databaseUrl,
  loadouts = DEFAULT_AGENTS,
  embeddingModel = 'openai/text-embedding-3-small',
  workspaceFor
}: CreateMastraOptions): Mastra {
  const agents = Object.fromEntries(
    loadouts.map((l) => [l.id, agentFromLoadout(l, { databaseUrl, embeddingModel, workspaceFor })])
  )

  return new Mastra({
    agents,
    storage: new LibSQLStore({ id: 'mochi-storage', url: databaseUrl }),
    server: {
      // The renderer loads from a different origin than the embedded server, so
      // CORS is required. Locked to the app's own origins — never '*'.
      cors: {
        origin: ['http://localhost:5173', 'file://'],
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization']
      },
      apiRoutes: [chatRoute({ path: '/chat/:agentId' })]
    }
  })
}
