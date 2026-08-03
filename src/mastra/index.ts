import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import { Memory } from '@mastra/memory'
import { LibSQLStore, LibSQLVector } from '@mastra/libsql'
import { chatRoute } from '@mastra/ai-sdk'
import { mochiTools, type MochiToolId } from './tools/mochi-tools'
import { DEFAULT_AGENTS } from '../shared/defaults'
import type { AgentLoadout } from '../shared/types'

/**
 * The Mastra instance Mochi runs against.
 *
 * Constructed by the Electron main process and served over an embedded Hono
 * server (src/main/mastra-server.ts) — there is no separate `mastra dev` process
 * in the shipped app.
 */

/** Env var Mastra's model router reads for each provider prefix. */
const PROVIDER_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY'
}

/**
 * Semantic recall needs a vector store *and* a reachable embedder. The Memory
 * constructor throws outright when the vector store is missing, and a missing
 * API key fails later at query time — so we check up front and degrade to plain
 * message history rather than taking the whole server down.
 */
export function canEmbed(embeddingModel: string): boolean {
  const provider = embeddingModel.split('/')[0]
  const envVar = PROVIDER_ENV[provider]
  // A local provider (ollama and friends) needs no key.
  if (!envVar) return true
  return Boolean(process.env[envVar])
}

export interface BuildAgentOptions {
  databaseUrl: string
  embeddingModel: string
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

  // `new ModelRouterEmbeddingModel(...)` throws immediately when the provider
  // key is absent, so the embedder and vector store are only constructed once we
  // know a key exists. A fresh install with no keys still starts and chats —
  // it just falls back to plain message history.
  const semanticRecall = loadout.semanticRecall && canEmbed(opts.embeddingModel)
  const recallParts = semanticRecall
    ? {
        vector: new LibSQLVector({ id: `mochi-vector-${loadout.id}`, url: opts.databaseUrl }),
        embedder: new ModelRouterEmbeddingModel(opts.embeddingModel)
      }
    : {}

  return new Agent({
    id: loadout.id,
    name: loadout.name,
    instructions: `${loadout.instructions}\n\n${behaviour}`,
    model: loadout.model,
    tools,
    memory: new Memory({
      storage: new LibSQLStore({ id: `mochi-store-${loadout.id}`, url: opts.databaseUrl }),
      ...recallParts,
      options: {
        lastMessages: 20,
        workingMemory: { enabled: loadout.workingMemory },
        semanticRecall
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
}

export function createMastra({
  databaseUrl,
  loadouts = DEFAULT_AGENTS,
  embeddingModel = 'openai/text-embedding-3-small'
}: CreateMastraOptions): Mastra {
  const agents = Object.fromEntries(
    loadouts.map((l) => [l.id, agentFromLoadout(l, { databaseUrl, embeddingModel })])
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
