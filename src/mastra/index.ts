import { Mastra } from '@mastra/core'
import { Agent, type ToolsInput } from '@mastra/core/agent'
import type { AnyWorkspace } from '@mastra/core/workspace'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import { Memory } from '@mastra/memory'
import { TaskSignalProvider } from '@mastra/core/signals'
import { LibSQLStore, LibSQLVector } from '@mastra/libsql'
import { chatRoute } from '@mastra/ai-sdk'
import { docTools, mochiTools, type MochiToolId } from './tools/mochi-tools'
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
  /** The loadout as it stands on disk right now, injected the same way. Without
   *  it the agent answers with whatever it was built from at startup. */
  loadoutFor?: (id: string) => AgentLoadout | undefined
}

/** Build a Mastra Agent from a Mochi loadout. Loadout *is* the agent. */
export function agentFromLoadout(loadout: AgentLoadout, opts: BuildAgentOptions): Agent {
  /*
   * The loadout as it is *now*, not as it was at boot.
   *
   * Mastra builds these agents once, when the server starts, so a captured copy
   * makes every edit a lie until the app is restarted: changing the model in the
   * loadout kept answering on the old one, and the memory switches did nothing.
   * Mastra's own answer to this is `DynamicArgument` — `model`, `instructions`,
   * `tools` and `memory` all accept a function resolved per request — so each of
   * them reads through this instead of closing over the startup value.
   */
  const current = (): AgentLoadout => opts.loadoutFor?.(loadout.id) ?? loadout

  const toolsFor = (l: AgentLoadout): ToolsInput => ({
    // The library is not a loadout choice. `toolIds` is not editable anywhere in
    // the UI, so gating these behind it would hide them from every agent that
    // already exists — and the subscription backend offers them unconditionally,
    // so an agent that lost its library merely by switching backend was the
    // asymmetry worth closing.
    ...docTools,
    ...Object.fromEntries(
      l.toolIds.filter((id): id is MochiToolId => id in mochiTools).map((id) => [id, mochiTools[id]])
    )
  })

  // Chattiness and "can push without asking" are behaviour knobs, not model
  // params — the cheapest honest way to honour them is to say so in the prompt.
  const behaviourFor = (l: AgentLoadout): string =>
    [
      l.chattiness <= 3
        ? 'Keep replies short. No preamble.'
        : l.chattiness >= 8
          ? 'You may think out loud and explain your reasoning.'
          : 'Explain briefly, then get to the point.',
      l.canPushWithoutAsking
        ? ''
        : 'Never push to git without asking the user first. Show the diff and wait.'
    ]
      .filter(Boolean)
      .join('\n')

  /*
   * Memory, rebuilt only when the settings that shape it change.
   *
   * A fresh `Memory` per request would open a new LibSQL store and vector index
   * every turn, so this is keyed by the switches that actually alter it. In the
   * common case — nothing changed — it is one lookup and the same instance the
   * last turn used.
   */
  const memories = new Map<string, Memory>()
  const memoryFor = (l: AgentLoadout): Memory => {
    const key = [l.workingMemory, l.semanticRecall, l.recallScope, recallTopK(l)].join('|')
    const cached = memories.get(key)
    if (cached) return cached

    // The vector store is only built once we know an embedder exists to fill it.
    // A fresh install with no keys and no local embedder still starts and chats —
    // it just falls back to plain message history.
    const embedder = l.semanticRecall ? embedderFor(opts.embeddingModel) : null
    const recallParts = embedder
      ? {
          vector: new LibSQLVector({ id: `mochi-vector-${loadout.id}`, url: opts.databaseUrl }),
          embedder
        }
      : {}
    const built = new Memory({
      storage: new LibSQLStore({ id: `mochi-store-${loadout.id}`, url: opts.databaseUrl }),
      ...recallParts,
      options: {
        lastMessages: 20,
        workingMemory: { enabled: l.workingMemory },
        /**
         * Recall is what reaches past `lastMessages` — the twenty-first message
         * back is gone otherwise, however relevant it is.
         *
         * `messageRange` is not a loadout knob because a bare match is close to
         * useless: recalling "use the staging bucket" without the question it
         * answered gives the model a fragment it has to guess the context of.
         * Two either side is the smallest window that keeps a match legible.
         *
         * Scope is the loadout's call. `thread` recovers what fell out of the
         * recent-message window; `resource` reaches into past sessions too,
         * which is what "do you remember last time?" is actually asking for.
         * The resource is per agent (see `memoryResource` in Session.tsx), so
         * the wide setting means "this agent's own history" rather than every
         * conversation in the app.
         */
        semanticRecall: embedder
          ? {
              topK: recallTopK(l),
              messageRange: 2,
              scope: l.recallScope === 'resource' ? ('resource' as const) : ('thread' as const)
            }
          : false
      }
    })
    memories.set(key, built)
    return built
  }

  return new Agent({
    id: loadout.id,
    name: loadout.name,
    instructions: () => `${current().instructions}\n\n${behaviourFor(current())}`,
    model: () => current().model,
    tools: () => toolsFor(current()),
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
    memory: () => memoryFor(current())
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
  /** Injected by main so an edited loadout takes effect on the next turn rather
   *  than the next launch. Omit and each agent stays as `loadouts` described it. */
  loadoutFor?: (id: string) => AgentLoadout | undefined
}

export function createMastra({
  databaseUrl,
  loadouts = DEFAULT_AGENTS,
  embeddingModel = 'openai/text-embedding-3-small',
  workspaceFor,
  loadoutFor
}: CreateMastraOptions): Mastra {
  const agents = Object.fromEntries(
    loadouts.map((l) => [
      l.id,
      agentFromLoadout(l, { databaseUrl, embeddingModel, workspaceFor, loadoutFor })
    ])
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
