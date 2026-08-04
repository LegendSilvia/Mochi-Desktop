import type { Hono } from 'hono'
import type { HonoBindings, HonoVariables } from '@mastra/hono'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { bus } from '../mastra/events'
import { load } from './store'
import { readLibrary } from './assets'
import { search } from './rag'
import { MASCOT_STATES } from '../shared/types'
import type { AgentLoadout, MascotState } from '../shared/types'

/**
 * The subscription backend.
 *
 * Mastra's model router talks to api.anthropic.com and therefore always needs an
 * API key — a Claude Pro/Max subscription cannot drive it. The Claude Agent SDK
 * can: it shells out to the Claude Code binary and reuses that CLI's OAuth
 * credential, which is the only sanctioned way for a third-party app to run on a
 * subscription. (Lifting the OAuth token out and pointing it at the API instead
 * would violate the Consumer ToS.)
 *
 * This mounts on the same embedded Hono server as Mastra and speaks the same AI
 * SDK UI-message-stream protocol, so the renderer swaps one URL and keeps its
 * existing text and tool-card rendering.
 *
 * Anthropic paused the June 2026 change that would have moved this usage off
 * subscription limits onto a separate credit. It is live today, but treat it as
 * a moving target rather than a stable foundation.
 */

/**
 * Vars that silently shadow the subscription.
 *
 * `store.ts` pushes saved provider keys into `process.env` so Mastra's router
 * finds them, and a spawned child inherits the parent env. If ANTHROPIC_API_KEY
 * survives into the Claude Code subprocess it wins over the OAuth credential and
 * the user gets billed per-token while believing they are on their subscription.
 * The SDK's `env` option REPLACES the subprocess environment rather than merging,
 * so we hand it an explicitly scrubbed copy.
 */
const SHADOWING_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']

function subscriptionEnv(appVersion: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of SHADOWING_VARS) delete env[key]
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `mochi/${appVersion}`
  return env
}

/** Tools are declared under an in-process MCP server, so they run here and can
 *  reach the bus directly — same wiring as the Mastra tools, different transport. */
const TOOL_PREFIX = 'mcp__mochi__'

/**
 * Subagents in flight, for the `capped` mode.
 *
 * Each delegation opens its own agent session against the same subscription
 * window, so an unbounded fan-out can burn the whole five hours on one task.
 * The cap is a semaphore rather than a queue: over the limit we decline and say
 * so, because a subagent silently waiting looks identical to one that hung.
 */
let inFlight = 0

function buildMochiServer(appVersion: string): ReturnType<typeof createSdkMcpServer> {
  /**
   * Hand a subtask to another loadout.
   *
   * The mention popover only ever edited local state — nothing delegated. This
   * runs the named agent as a genuinely separate session, so it sees the task
   * and nothing else of your thread, which is the isolation the UI claims.
   */
  const delegate = tool(
    'delegate',
    'Hand a self-contained subtask to another agent in this session and get its ' +
      'answer back. Use it when another loadout is better suited — a docs reader, ' +
      'a reviewer — or when two independent things can be looked at at once. The ' +
      'subagent sees only the prompt you write, not your conversation, so give it ' +
      'every detail it needs.',
    {
      agentId: z.string().describe('Id of the agent to delegate to, e.g. "kettle"'),
      prompt: z.string().describe('The complete, self-contained task for that agent')
    },
    async ({ agentId, prompt }) => {
      const { agents, settings } = load()
      const target = agents.find((a) => a.id === agentId)
      const say = (text: string): { content: Array<{ type: 'text'; text: string }> } => ({
        content: [{ type: 'text' as const, text }]
      })

      if (!target) return say(`No agent called "${agentId}" exists in this session.`)

      if (settings.delegationMode === 'simulated') {
        return say(
          `Delegation is set to simulated, so ${target.name} was not actually run. ` +
            `Answer as yourself, and say you handled it directly rather than implying ` +
            `${target.name} did.`
        )
      }

      if (settings.delegationMode === 'capped' && inFlight >= settings.delegationLimit) {
        return say(
          `At the delegation limit (${settings.delegationLimit} at once). Do this part ` +
            `yourself, or wait for a running subagent to finish.`
        )
      }

      const [provider, ...rest] = target.model.split('/')
      if (provider !== 'anthropic') {
        return say(
          `${target.name} is set to ${target.model}, which the subscription backend ` +
            `cannot run. Do this part yourself.`
        )
      }

      inFlight++
      try {
        bus.emitMascotState({ state: 'tool-running', note: `asking ${target.name}` })
        let answer = ''
        for await (const raw of query({
          prompt,
          options: {
            systemPrompt: buildSystemPrompt(target),
            model: rest.join('/') || undefined,
            allowedTools: [],
            env: subscriptionEnv(appVersion),
            maxTurns: 8
          }
        })) {
          const message = raw as SdkMessage
          if (message.type !== 'assistant') continue
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text' && block.text) answer += block.text
          }
        }
        return say(answer.trim() || `${target.name} came back with nothing.`)
      } catch (err) {
        return say(`${target.name} failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        inFlight--
      }
    }
  )

  const searchDocs = tool(
    'searchDocs',
    'Search the documents the user has added to Mochi. Use this before answering ' +
      'anything that depends on their own notes, specs or code rather than general ' +
      'knowledge. Returns the most relevant passages with the file they came from — ' +
      'quote and cite them rather than paraphrasing from memory.',
    {
      query: z.string().describe('What to look for, in natural language'),
      limit: z.number().optional().describe('How many passages to return. Defaults to 6.')
    },
    async ({ query: q, limit }) => {
      const hits = await search(q, limit ?? 6)
      if (hits.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No matching passages. The library may be empty.' }
          ]
        }
      }
      const text = hits
        .map((h, i) => `[${i + 1}] ${h.title} (${h.how})\n${h.text}`)
        .join('\n\n---\n\n')
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  const sendSticker = tool(
    'sendSticker',
    'Send a sticker to the user. Use this to celebrate a finished task, acknowledge ' +
      'thanks, or flag that something went wrong. The sticker and its sound fire ' +
      'together as one event. Use it sparingly — it is a punctuation mark, not a habit.',
    {
      sticker: z
        .string()
        .describe('Sticker name, e.g. "nice-work", "party", "blush", "oh-no", "nap"'),
      caption: z.string().optional().describe('Short line to show with the sticker')
    },
    async ({ sticker, caption }) => {
      bus.emitSticker({ event: 'manual', stickerId: sticker, caption })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ sent: true }) }] }
    }
  )

  const setMascotState = tool(
    'setMascotState',
    'Set the mascot to a lifecycle state so the user can see what you are doing at a ' +
      'glance. Set "thinking" before a long reasoning step, "tool-running" while a tool ' +
      'is working, "done" when the task finishes, "error" when something failed.',
    {
      state: z.enum(MASCOT_STATES as [MascotState, ...MascotState[]]),
      note: z.string().optional().describe('Short status line, e.g. "running tests"')
    },
    async ({ state, note }) => {
      bus.emitMascotState({ state, note })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ state }) }] }
    }
  )

  // Mirrors askUserTool in src/mastra/tools — see the note there on why this
  // returns immediately instead of blocking for the answer.
  const askUser = tool(
    'askUser',
    'Ask the user a question and offer specific answers they can click. Use this ' +
      'when you need a decision before continuing — which approach to take, whether ' +
      'to push, which file to touch. Prefer it over a plain question in your reply, ' +
      'because the answers become one tap instead of typing. Keep options short.',
    {
      question: z.string().describe('The question, one short sentence'),
      options: z.array(z.string()).describe('Between 2 and 5 answers the user can pick from'),
      allowOther: z
        .boolean()
        .optional()
        .describe('Also let the user type a free-form answer. Defaults to true.')
    },
    async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ asked: true }) }] })
  )

  return createSdkMcpServer({
    name: 'mochi',
    version: '0.1.0',
    tools: [sendSticker, setMascotState, askUser, delegate, searchDocs],
    // Load both tools into the turn-1 prompt instead of leaving them behind tool
    // search. Deferred loading made the harness spend a round trip on ToolSearch
    // and then emit a stray extra reply when the "new tools available" reminder
    // landed mid-turn — the user saw Mochi answer twice. Two tools are cheap
    // enough to always carry.
    alwaysLoad: true
  })
}

/**
 * The agent's persona, plus the sticker names it is actually allowed to send.
 *
 * The allow-list has to reach the model as text: `sendSticker` takes a free-form
 * name, so the only way to constrain the choice is to tell it what exists. An
 * empty list means "anything in the folder" rather than "nothing", so a fresh
 * loadout isn't mute until someone curates it.
 */
function buildSystemPrompt(agent: AgentLoadout): string {
  const parts = [agent.instructions, `Expected output: ${agent.expectedOutput}`]

  const allowed = agent.allowedStickerIds ?? []
  const names = readLibrary(agent.spritePreset)
    .stickers.filter((s) => allowed.length === 0 || allowed.includes(s.id))
    .map((s) => s.name)

  if (names.length > 0) {
    parts.push(
      allowed.length > 0
        ? `When you use sendSticker, you may only send these: ${names.join(', ')}. Do not invent other names.`
        : `Stickers available to sendSticker: ${names.join(', ')}.`
    )
  }
  return parts.join('\n\n')
}

/**
 * User-configured MCP servers, in the Agent SDK's own shape.
 *
 * Only enabled ones are passed, and a server missing the field its transport
 * needs is skipped rather than handed over half-formed — the SDK's failure for
 * that is a stalled startup, which is far harder to read than an absent tool.
 */
function userMcpServers(): Record<string, McpServerConfig> {
  const { settings } = load()
  const out: Record<string, McpServerConfig> = {}
  for (const server of settings.mcpServers ?? []) {
    if (!server.enabled) continue
    if (server.type === 'http' && server.url) {
      out[server.name] = { type: 'http', url: server.url }
    } else if (server.type === 'stdio' && server.command) {
      out[server.name] = { type: 'stdio', command: server.command, args: server.args ?? [] }
    }
  }
  return out
}

/**
 * Who this session may delegate to.
 *
 * `@agent` adds ids to the session; without telling the supervisor they exist,
 * the delegate tool has no way to be used — which is why the mention popover
 * looked decorative even after the tool landed.
 */
function describeSubagents(sessionId: string): string {
  const { sessions, agents } = load()
  const ids = sessions.find((s) => s.id === sessionId)?.subagentIds ?? []
  const roster = ids
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is AgentLoadout => Boolean(a))
  if (roster.length === 0) return ''
  const lines = roster.map((a) => `- ${a.id} (${a.name}): ${a.description}`).join('\n')
  return (
    `You may delegate to these agents with the delegate tool. You stay the supervisor — ` +
    `decide when to hand off, and always report back in your own voice.\n${lines}`
  )
}

/**
 * Claude Code owns the conversation history, so we keep its session id per Mochi
 * session and resume rather than replaying the transcript on every turn.
 */
const sdkSessions = new Map<string, string>()

export function forgetAgentSdkSession(sessionId: string): void {
  sdkSessions.delete(sessionId)
}

interface IncomingPart {
  type?: string
  text?: string
}

interface IncomingMessage {
  role?: string
  parts?: IncomingPart[]
}

/** The renderer posts UIMessages; we only need the newest user turn because the
 *  Agent SDK holds the rest of the thread itself. */
function latestUserText(messages: IncomingMessage[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    return (message.parts ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
      .trim()
  }
  return ''
}

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface SdkMessage {
  type?: string
  subtype?: string
  session_id?: string
  message?: { content?: ContentBlock[] }
  is_error?: boolean
  result?: string
}

type MochiHono = Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>

export function registerAgentSdkRoute(app: MochiHono, appVersion: string): void {
  const mochiServer = buildMochiServer(appVersion)

  /**
   * Name a session from what it turned out to be about.
   *
   * Titles were the first 48 characters of whatever you typed, so a session
   * opened with "hi" stayed called "hi" forever. This runs a single toolless
   * turn on the opening exchange — cheap, and it draws on the same subscription
   * as everything else rather than needing a key of its own.
   */
  app.post('/agent-sdk/title', async (c) => {
    const { text } = (await c.req.json()) as { text?: string }
    if (!text?.trim()) return c.json({ title: null })

    try {
      let title = ''
      for await (const raw of query({
        prompt:
          'Give this conversation a title of at most six words. Reply with the title ' +
          'alone — no quotes, no punctuation at the end, no preamble.\n\n' +
          text.slice(0, 4000),
        options: {
          systemPrompt: 'You write short, concrete titles. You never explain yourself.',
          allowedTools: [],
          env: subscriptionEnv(appVersion),
          maxTurns: 1
        }
      })) {
        const message = raw as SdkMessage
        if (message.type !== 'assistant') continue
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text' && block.text) title += block.text
        }
      }

      const cleaned = title.trim().replace(/^["'\s]+|["'.\s]+$/g, '').split('\n')[0]
      return c.json({ title: cleaned.slice(0, 60) || null })
    } catch {
      // A failed rename should never surface as a broken session.
      return c.json({ title: null })
    }
  })

  app.post('/agent-sdk/chat/:agentId', async (c) => {
    const agentId = c.req.param('agentId')
    const body = (await c.req.json()) as { id?: string; messages?: IncomingMessage[] }
    const chatId = body.id ?? agentId
    const prompt = latestUserText(body.messages)

    const { agents, settings } = load()
    const agent = agents.find((a) => a.id === agentId)

    // The subscription only covers Anthropic models. An agent pinned to
    // openai/… or google/… cannot run here, and failing loudly beats silently
    // answering as a different model than the card advertises.
    const [provider, ...rest] = (agent?.model ?? 'anthropic/claude-sonnet-4-6').split('/')
    const modelName = rest.join('/')

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: 'start' })
        writer.write({ type: 'start-step' })

        if (provider !== 'anthropic') {
          writer.write({
            type: 'error',
            errorText:
              `${agent?.name ?? agentId} is set to ${agent?.model}. The subscription backend ` +
              `only serves Anthropic models — switch this agent to an anthropic/… model, or ` +
              `turn off "Run on my Claude subscription" in Settings → Models to use an API key.`
          })
          writer.write({ type: 'finish-step' })
          writer.write({ type: 'finish' })
          return
        }

        const resume = sdkSessions.get(chatId)
        let textIndex = 0
        // The Claude Code harness runs its own internal tools (ToolSearch, and
        // whatever else it adds later) to load our deferred MCP tools. Those are
        // plumbing, not something a Mochi user asked for, so they never reach a
        // tool card — and we track their ids to drop the matching results too.
        const suppressed = new Set<string>()

        try {
          for await (const raw of query({
            prompt,
            options: {
              systemPrompt: agent
                ? [buildSystemPrompt(agent), describeSubagents(chatId)]
                    .filter(Boolean)
                    .join('\n\n')
                : undefined,
              model: modelName || undefined,
              mcpServers: { mochi: mochiServer, ...userMcpServers() },
              // Skills live on the filesystem, so they stay off until asked for —
              // enabling them silently would widen what the agent can reach.
              ...(settings.skills?.enabled
                ? { skills: settings.skills.allow, settingSources: ['project' as const] }
                : {}),
              allowedTools: [
                `${TOOL_PREFIX}sendSticker`,
                `${TOOL_PREFIX}setMascotState`,
                `${TOOL_PREFIX}askUser`,
                `${TOOL_PREFIX}delegate`,
                `${TOOL_PREFIX}searchDocs`
              ],
              env: subscriptionEnv(appVersion),
              ...(resume ? { resume } : {}),
              maxTurns: 24
            }
          })) {
            const message = raw as SdkMessage

            if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
              sdkSessions.set(chatId, message.session_id)
              continue
            }

            if (message.type !== 'assistant' && message.type !== 'user') continue

            for (const block of message.message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                const id = `t${textIndex++}`
                writer.write({ type: 'text-start', id })
                writer.write({ type: 'text-delta', id, delta: block.text })
                writer.write({ type: 'text-end', id })
              } else if (block.type === 'thinking' && block.thinking) {
                const id = `r${textIndex++}`
                writer.write({ type: 'reasoning-start', id })
                writer.write({ type: 'reasoning-delta', id, delta: block.thinking })
                writer.write({ type: 'reasoning-end', id })
              } else if (block.type === 'tool_use' && block.id) {
                if (!(block.name ?? '').startsWith(TOOL_PREFIX)) {
                  suppressed.add(block.id)
                  continue
                }
                writer.write({
                  type: 'tool-input-available',
                  toolCallId: block.id,
                  // Strip the MCP namespace so the tool card reads `sendSticker`
                  // rather than `mcp__mochi__sendSticker`.
                  toolName: (block.name ?? 'tool').replace(TOOL_PREFIX, ''),
                  input: block.input ?? {}
                })
              } else if (block.type === 'tool_result' && block.tool_use_id) {
                if (suppressed.has(block.tool_use_id)) continue
                writer.write({
                  type: 'tool-output-available',
                  toolCallId: block.tool_use_id,
                  output: block.content ?? null
                })
              }
            }
          }
        } catch (err) {
          writer.write({
            type: 'error',
            errorText: err instanceof Error ? err.message : String(err)
          })
        }

        writer.write({ type: 'finish-step' })
        writer.write({ type: 'finish' })
      },
      onError: (err) => (err instanceof Error ? err.message : String(err))
    })

    return createUIMessageStreamResponse({ stream })
  })
}
