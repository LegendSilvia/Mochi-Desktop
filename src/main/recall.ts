import { Memory } from '@mastra/memory'
import { LibSQLStore, LibSQLVector } from '@mastra/libsql'
import { randomUUID } from 'node:crypto'
import { embedderFor } from '../mastra/index'
import { databaseUrl } from './paths'
import { embedderInfo } from './rag'
import { DEFAULT_RECALL_TOP_K } from '../shared/defaults'
import type { AgentLoadout } from '../shared/types'

/**
 * Semantic recall for the subscription backend.
 *
 * Recall lives in Mastra's `Memory`, and only the Mastra chat route ever
 * consulted it — so on the Claude subscription, which runs through the Agent
 * SDK, every memory switch in the loadout was wired to a backend the user was
 * not on. Turning it on did nothing at all.
 *
 * Pointing Mastra's router at the subscription is not the answer and never will
 * be: it talks to api.anthropic.com and always needs an API key, and lifting the
 * Claude Code OAuth credential out to use there would violate the Consumer ToS
 * (see the header of agent-sdk-route.ts).
 *
 * What works instead is splitting the two jobs, because `Memory` exposes
 * `recall` and `saveMessages` publicly and does not depend on the model router
 * at all:
 *
 *   - the conversation stays on the Agent SDK, driving the Claude Code binary
 *     on the user's subscription, exactly as sanctioned;
 *   - embedding and retrieval go through `Memory` on whatever embedding key the
 *     user has, which has nothing to do with Anthropic.
 *
 * Nothing here points an OAuth token anywhere.
 */

/** One per agent, because building a Memory opens a database handle and an
 *  embedder. Keyed by loadout id, which is also what scopes the stored rows. */
const cache = new Map<string, Memory | null>()

/**
 * The store ids match `agentFromLoadout` deliberately.
 *
 * Both backends then read and write the same rows, so turning off "run on my
 * subscription" carries the agent's memory across rather than starting it a
 * second, separate history that the other half cannot see.
 */
function build(loadout: AgentLoadout, embeddingModel: string): Memory | null {
  const embedder = embedderFor(embeddingModel)
  if (!embedder) return null

  return new Memory({
    storage: new LibSQLStore({ id: `mochi-store-${loadout.id}`, url: databaseUrl() }),
    vector: new LibSQLVector({ id: `mochi-vector-${loadout.id}`, url: databaseUrl() }),
    embedder,
    options: {
      // History is the Agent SDK's job here — it resumes its own transcript, so
      // asking Memory for recent messages too would feed the model a second
      // copy of what it already has.
      lastMessages: false,
      workingMemory: { enabled: false },
      semanticRecall: {
        topK: Math.min(20, Math.max(1, Math.round(loadout.recallTopK ?? DEFAULT_RECALL_TOP_K))),
        messageRange: 2,
        scope: loadout.recallScope === 'resource' ? 'resource' : 'thread'
      }
    }
  })
}

/** The agent's memory, or null when recall is off or nothing can embed. */
async function memoryFor(loadout: AgentLoadout): Promise<Memory | null> {
  if (!loadout.semanticRecall) return null
  const hit = cache.get(loadout.id)
  if (hit !== undefined) return hit

  // The same reachability check the Mastra side uses: an embedder that is
  // configured but not running would throw mid-turn, failing the user's message
  // rather than the feature.
  const info = await embedderInfo()
  const memory = info.ready ? build(loadout, `${info.kind}/${info.model}`) : null
  cache.set(loadout.id, memory)
  return memory
}

/** Settings changed under us — rebuild on the next turn rather than serving a
 *  memory built against an embedder or a topK the user has since changed. */
export function resetRecall(): void {
  cache.clear()
}

function textOf(message: { content?: { parts?: unknown[] } }): string {
  const parts = message.content?.parts ?? []
  return parts
    .filter((p): p is { type: 'text'; text: string } => {
      const part = p as { type?: string; text?: unknown }
      return part.type === 'text' && typeof part.text === 'string'
    })
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/**
 * What the agent should be reminded of before answering this turn.
 *
 * Returns a block to put in front of the prompt, or null when there is nothing
 * worth saying — an empty "here is what you remember" heading is worse than
 * silence, because the model will try to use it.
 */
export async function recallContext(
  loadout: AgentLoadout,
  opts: { threadId: string; resourceId: string; prompt: string }
): Promise<string | null> {
  const memory = await memoryFor(loadout)
  if (!memory || !opts.prompt.trim()) return null

  try {
    const { messages } = await memory.recall({
      threadId: opts.threadId,
      resourceId: opts.resourceId,
      vectorSearchString: opts.prompt,
      // `perPage: 0` because semantic hits are the entire point here — without
      // it recall also returns a page of recent messages, which the Agent SDK
      // already has and would only duplicate.
      perPage: 0
    })
    if (!messages?.length) return null

    const lines = messages
      .map((m) => ({ role: m.role, text: textOf(m) }))
      .filter((m) => m.text)
      // Long matches are trimmed rather than dropped: a truncated reminder is
      // still a reminder, and the whole block rides in front of every prompt.
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text.slice(0, 600)}`)
    if (!lines.length) return null

    return [
      'Relevant excerpts from earlier conversations, recalled by meaning rather',
      'than recency. Use them if they help; say nothing about this block itself.',
      '',
      ...lines
    ].join('\n')
  } catch (err) {
    // Recall is an enhancement. A vector store that will not answer must not
    // take the turn down with it.
    console.error('[mochi] semantic recall failed:', err)
    return null
  }
}

/**
 * Record a finished exchange so later turns can find it.
 *
 * Saving is what embeds — nothing can be recalled that was never written — so
 * this runs after every turn on the subscription path, where the Agent SDK
 * keeps its own transcript and Mastra would otherwise never see a word of it.
 */
export async function rememberTurn(
  loadout: AgentLoadout,
  opts: { threadId: string; resourceId: string; prompt: string; reply: string }
): Promise<void> {
  const memory = await memoryFor(loadout)
  if (!memory) return
  if (!opts.prompt.trim() && !opts.reply.trim()) return

  try {
    // The thread has to exist before messages can hang off it, and this is the
    // first time Mastra hears about a conversation the Agent SDK has been
    // running on its own.
    const existing = await memory.getThreadById({ threadId: opts.threadId })
    if (!existing) {
      await memory.saveThread({
        thread: {
          id: opts.threadId,
          resourceId: opts.resourceId,
          title: opts.prompt.slice(0, 80) || 'Conversation',
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })
    }

    const now = Date.now()
    const rows = [
      { role: 'user' as const, text: opts.prompt, at: new Date(now) },
      { role: 'assistant' as const, text: opts.reply, at: new Date(now + 1) }
    ]
      .filter((r) => r.text.trim())
      .map((r) => ({
        id: randomUUID(),
        role: r.role,
        threadId: opts.threadId,
        resourceId: opts.resourceId,
        createdAt: r.at,
        type: 'text',
        content: { format: 2 as const, parts: [{ type: 'text' as const, text: r.text }] }
      }))

    await memory.saveMessages({ messages: rows })
  } catch (err) {
    // A turn the user already has on screen must not fail because we could not
    // file it away for later.
    console.error('[mochi] could not record the turn for recall:', err)
  }
}
