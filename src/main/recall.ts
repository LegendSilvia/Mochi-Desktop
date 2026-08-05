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
function build(loadout: AgentLoadout, embeddingModel: string | null): Memory | null {
  // Only recall needs to embed. Working memory is a block of text keyed by
  // resource, so it works on a machine that cannot embed at all — treating one
  // as a prerequisite for the other would switch off the half that still works.
  const embedder = loadout.semanticRecall && embeddingModel ? embedderFor(embeddingModel) : null
  if (!embedder && !loadout.workingMemory) return null

  return new Memory({
    storage: new LibSQLStore({ id: `mochi-store-${loadout.id}`, url: databaseUrl() }),
    ...(embedder
      ? {
          vector: new LibSQLVector({ id: `mochi-vector-${loadout.id}`, url: databaseUrl() }),
          embedder
        }
      : {}),
    options: {
      // History is the Agent SDK's job here — it resumes its own transcript, so
      // asking Memory for recent messages too would feed the model a second
      // copy of what it already has.
      lastMessages: false,
      /**
       * Resource scope, which is what "remembers me" means: facts follow the
       * agent across every conversation rather than being forgotten with the
       * thread they were learned in. The resource is per agent, so what Fraux
       * knows about you is not what Helper knows.
       */
      workingMemory: { enabled: loadout.workingMemory, scope: 'resource' as const },
      semanticRecall: embedder
        ? {
            topK: Math.min(20, Math.max(1, Math.round(loadout.recallTopK ?? DEFAULT_RECALL_TOP_K))),
            messageRange: 2,
            scope: loadout.recallScope === 'resource' ? ('resource' as const) : ('thread' as const)
          }
        : false
    }
  })
}

/** The agent's memory, or null when it has been given no job to do. */
async function memoryFor(loadout: AgentLoadout): Promise<Memory | null> {
  if (!loadout.semanticRecall && !loadout.workingMemory) return null
  const hit = cache.get(loadout.id)
  if (hit !== undefined) return hit

  // The same reachability check the Mastra side uses: an embedder that is
  // configured but not running would throw mid-turn, failing the user's message
  // rather than the feature. Only consulted when recall actually wants one.
  const info = loadout.semanticRecall ? await embedderInfo() : null
  const memory = build(loadout, info?.ready ? `${info.kind}/${info.model}` : null)
  cache.set(loadout.id, memory)
  return memory
}

/**
 * What the agent has written down about the user.
 *
 * On the Mastra route this is injected into the system message automatically.
 * The Agent SDK has never heard of Mastra, so it goes in front of the prompt
 * here — the same door recall uses.
 */
export async function workingMemoryBlock(
  loadout: AgentLoadout,
  opts: { threadId: string; resourceId: string }
): Promise<string | null> {
  if (!loadout.workingMemory) return null
  const memory = await memoryFor(loadout)
  if (!memory) return null

  try {
    const text = await memory.getWorkingMemory({
      threadId: opts.threadId,
      resourceId: opts.resourceId
    })
    if (!text?.trim()) return null
    return [
      'What you have previously noted about this user. Treat it as true unless',
      'they correct you, and use updateMemory to revise it when you learn',
      'something lasting. Do not mention this block itself.',
      '',
      text.trim()
    ].join('\n')
  } catch (err) {
    console.error('[mochi] could not read working memory:', err)
    return null
  }
}

/** Replace what the agent knows. Used by its own tool and by the Memory pane,
 *  which is the same store seen from two ends. */
export async function writeWorkingMemory(
  loadout: AgentLoadout,
  opts: { threadId: string; resourceId: string; text: string }
): Promise<boolean> {
  const memory = await memoryFor(loadout)
  if (!memory) return false
  try {
    await memory.updateWorkingMemory({
      threadId: opts.threadId,
      resourceId: opts.resourceId,
      workingMemory: opts.text
    })
    return true
  } catch (err) {
    console.error('[mochi] could not write working memory:', err)
    return false
  }
}

/** Read it back raw, for the editor rather than for a prompt. */
export async function readWorkingMemory(
  loadout: AgentLoadout,
  opts: { threadId: string; resourceId: string }
): Promise<string> {
  const memory = await memoryFor(loadout)
  if (!memory) return ''
  try {
    return (await memory.getWorkingMemory(opts)) ?? ''
  } catch {
    return ''
  }
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
  // `memoryFor` now also answers for working-memory-only loadouts, so recall
  // has to say for itself whether it was asked for.
  if (!loadout.semanticRecall) return null
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
