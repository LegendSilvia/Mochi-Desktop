import type { Hono } from 'hono'
import type { HonoBindings, HonoVariables } from '@mastra/hono'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type {
  McpServerConfig,
  PermissionResult,
  Query,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getPaths } from './paths'
import { notifyIfAway } from './attention'
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
 * Harness tools that are worth showing, despite not being ours.
 *
 * Everything outside `TOOL_PREFIX` is suppressed by default because the Claude
 * Code harness runs its own plumbing (ToolSearch and friends) that no Mochi user
 * asked for. `TodoWrite` is the exception: it is the agent's own task list, it
 * carries the same `{content, status, activeForm}` shape as Mastra's task tools,
 * and hiding it was the reason task tracking looked unimplemented on this route
 * when in fact it was running all along.
 */
/**
 * Harness tools that are plumbing, and nothing else.
 *
 * This was an allow-list — everything not named was dropped — which meant each
 * tool the harness gained went invisible until someone noticed. It cost us the
 * file tools once (an approved write left no trace) and the task tools again (an
 * agent built a four-step plan and the user saw an empty reply). A deny-list
 * fails the other way: something new shows up as a plain row, which is untidy but
 * honest.
 */
const HIDDEN_BUILTINS = new Set(['ToolSearch'])

/**
 * Harness tools the model must never be offered.
 *
 * `AskUserQuestion` is the Claude Code harness's own question tool. Mochi has no
 * renderer for it, so approving one did nothing and the agent then reported that
 * "no answer came back" — it had asked into a void. Mochi's `askUser` does the
 * same job and lands in the ask dock, so the harness copy is removed from the
 * model's context outright rather than left to be chosen and then fail.
 *
 * Aliasing it onto `askUser` was the other option and is wrong: the two take
 * different inputs (`questions[]` of option objects vs one question and a list
 * of strings), so the redirect would hand `askUser` a body it cannot read.
 */
const DISALLOWED_BUILTINS = [
  'AskUserQuestion',
  /*
   * The harness's own task system, which is a second, richer plan format
   * (dependencies, background runs) that Mochi has no card for. An agent asked
   * for a step list reached for these, built four chained tasks, and the user
   * got a paragraph describing a plan they could not see.
   *
   * `TodoWrite` does the same job and already renders as the plan checklist, so
   * the choice is removed rather than left to chance. Revisit if the background
   * task panel ever grows to drive these properly — they carry more than a todo
   * list can express.
   */
  'TaskCreate',
  'TaskUpdate'
]

/** Removing `AskUserQuestion` is only half the fix: without being told where the
 *  questions went, a model that wants to offer choices falls back to asking in
 *  prose, which is the flat text box we were trying to get away from. */
const ASK_USER_NOTE =
  'To put a question to the user with clickable answers, use the askUser tool. It is ' +
  'the only one that renders in this app. To lay work out as ordered steps and tick ' +
  'them off as you go, use TodoWrite — it renders as a plan the user can watch.'

/**
 * Tools that run without stopping to ask.
 *
 * `canUseTool` fires for everything not named here, so this list is the
 * difference between a coding assistant and a machine that asks permission to
 * look at a file. The split is by consequence, not by who wrote the tool:
 * reading, searching and the agent's own bookkeeping are reversible and happen
 * constantly, so they run; anything that writes, executes or reaches the network
 * still stops at a card.
 *
 * `ToolSearch` is harness plumbing for loading our own deferred tools — asking
 * the user to approve that is asking them to approve Mochi's own wiring.
 */
const AUTO_APPROVED = [
  `${TOOL_PREFIX}sendSticker`,
  `${TOOL_PREFIX}setMascotState`,
  `${TOOL_PREFIX}askUser`,
  `${TOOL_PREFIX}delegate`,
  `${TOOL_PREFIX}searchDocs`,
  'TodoWrite',
  'ToolSearch',
  'Read',
  'Glob',
  'Grep',
  'BashOutput'
]

/**
 * Tool calls waiting on the user.
 *
 * `canUseTool` runs here in the main process, but the answer comes from the
 * renderer, and the message stream only goes one way. So the promise is parked
 * in this map, its id is written into the stream, and `POST /agent-sdk/permission`
 * resolves it from the other side.
 *
 * Module-level rather than per-request because the answering request is a
 * *different* request from the one that is blocked.
 */
export interface ApprovalDecision {
  behavior: 'allow' | 'deny'
  /** Apply the SDK's own rule suggestions so this tool stops asking. Only the
   *  parked handler can honour it, because `suggestions` is scoped to the call. */
  alwaysAllow?: boolean
}

const pendingApprovals = new Map<
  string,
  { resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout }
>()

/** A parked promise nobody answers is a hung turn — the exact bug this whole
 *  path exists to fix. Give up rather than block forever. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Runs currently in flight, keyed by Mochi session.
 *
 * Stop used to be `useChat`'s `stop()` alone, which aborts the *fetch*. That
 * detaches the reader; it does not reach into the main process and tell the
 * Claude Code subprocess to stop thinking. The run carried on to completion —
 * still spending the subscription window, still firing tool side effects, so a
 * stopped turn could go on writing files and setting the mascot afterwards.
 *
 * Holding the query object lets `/agent-sdk/stop` call the SDK's own
 * `interrupt()`, which is the only thing that actually halts the turn.
 */
const liveRuns = new Map<string, Query>()

/**
 * A prompt you can keep talking into.
 *
 * Passing `prompt` as a string closes the conversation the moment the turn
 * starts: the agent gets one instruction and nothing can reach it until the run
 * ends. That is why redirecting mid-run was impossible and why a message typed
 * while the agent worked had to sit in the renderer until `onFinish`.
 *
 * An async iterable prompt stays open instead, and the SDK's own `priority`
 * decides what happens to each message: `now` interrupts and redirects the
 * current turn, `next` waits and runs after it. So steer and the follow-up queue
 * are the same mechanism with one field changed, and the queue moves off the
 * renderer — where a reload silently dropped it — into the run itself.
 */
interface InputChannel {
  stream: AsyncIterable<SDKUserMessage>
  push: (text: string, priority: 'now' | 'next') => void
  /** End the conversation, but only once nothing is still waiting to be said. */
  closeWhenDrained: () => void
}

function inputChannel(first: string): InputChannel {
  const say = (text: string, priority?: 'now' | 'next'): SDKUserMessage => ({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {})
  })

  const waiting: SDKUserMessage[] = [say(first)]
  let wake: (() => void) | null = null
  let closing = false

  const nudge = (): void => {
    wake?.()
    wake = null
  }

  async function* pump(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (waiting.length > 0) yield waiting.shift() as SDKUserMessage
      // Closing is checked *after* draining: a message pushed in the same tick
      // as the close must still be delivered, or a follow-up queued just as the
      // turn ended would vanish.
      if (closing) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  return {
    stream: pump(),
    push: (text, priority) => {
      if (closing) return
      waiting.push(say(text, priority))
      nudge()
    },
    closeWhenDrained: () => {
      closing = true
      nudge()
    }
  }
}

/** Open input channels, so `/agent-sdk/steer` can talk into a running turn. */
const liveInputs = new Map<string, InputChannel>()

function settleApproval(id: string, decision: ApprovalDecision): boolean {
  const pending = pendingApprovals.get(id)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingApprovals.delete(id)
  // Clear it wherever it is showing. Answering in the app must take the card off
  // the mascot too, or the overlay keeps offering a decision already made.
  bus.emitApproval(null)
  pending.resolve(decision)
  return true
}

/** Roughly a line and a half on the overlay. Past this the command is offered as
 *  "open Mochi" instead — a half-read command is not something to approve. */
const APPROVAL_TARGET_MAX = 120

/**
 * What the tool is about to do, as one line.
 *
 * The command leads and the blocked path only fills in behind it: preferring
 * `blockedPath` is what made a PowerShell delete show as a bare file name, so
 * the user read a path and approved a command they never saw.
 */
function describeApprovalTarget(input: unknown, blockedPath?: string | null): string {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return blockedPath ?? ''
}

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
            systemPrompt: buildSystemPrompt(target, settings.userName),
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
function buildSystemPrompt(agent: AgentLoadout, userName: string): string {
  const parts = [agent.instructions, `Expected output: ${agent.expectedOutput}`]

  // Only when set — a sentence about an absent name is worse than no sentence.
  const name = userName.trim()
  if (name) parts.push(`The user's name is ${name}. Address them as ${name}.`)

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
 * The folder this session works in, and what the agent may do there.
 *
 * The composer's "Change" button has always set `workspacePath`, but nothing
 * passed it on, so the agent ran against whatever directory Electron happened to
 * start in — it would cheerfully write a file into the app's own source tree
 * while the header said it was working somewhere else.
 *
 * The capability sentence matters as much as the path. The file tools are on the
 * subscription backend by default, but nothing in the persona says so, so a
 * loadout written as a chat assistant would routinely answer "I can't edit files"
 * while holding the tools to do it.
 */
function describeWorkspace(sessionId: string): { cwd?: string; note: string } {
  const session = load().sessions.find((s) => s.id === sessionId)
  const cwd = session?.workspacePath
  const note = cwd
    ? `You are working in ${cwd}. Read, write and edit files there directly with your ` +
      `file tools rather than printing code for the user to copy. Anything that changes ` +
      `a file or runs a command asks the user first, so act — do not ask permission in ` +
      `prose for something the approval prompt already covers.`
    : `You can read, write and edit files and run commands on this machine. Anything ` +
      `that changes a file or runs a command asks the user first. No folder is set for ` +
      `this session, so ask which one to work in before touching anything.`
  return { cwd, note }
}

/**
 * Claude Code owns the conversation history, so we keep its session id per Mochi
 * session and resume rather than replaying the transcript on every turn.
 *
 * This used to be a bare `Map`, which is why reopening the app lost the
 * conversation: the renderer restored the transcript from disk and showed it, but
 * the map was empty, so no `resume` was passed and the agent started a brand-new
 * session that had never heard any of it. The user saw their history and the
 * model did not.
 *
 * Kept in its own file rather than on the `Session` record because the renderer
 * writes that record constantly (busy flags, `updatedAt`) from its own copy —
 * a field written here would be clobbered by the next save from over there.
 */
const SESSIONS_FILE = (): string => join(getPaths().userData, 'sdk-sessions.json')

let sdkSessions: Map<string, string> | null = null

function sessionIds(): Map<string, string> {
  if (sdkSessions) return sdkSessions
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE(), 'utf8')) as Record<string, string>
    sdkSessions = new Map(Object.entries(raw))
  } catch {
    // Absent on first run, and unreadable is the same as absent here: the cost
    // is one conversation losing its thread, not a broken app.
    sdkSessions = new Map()
  }
  return sdkSessions
}

function persistSessionIds(): void {
  const map = sessionIds()
  // Drop ids for sessions that no longer exist, so deleting a chat eventually
  // takes its resume pointer with it instead of growing the file forever.
  const live = new Set(load().sessions.map((s) => s.id))
  for (const key of map.keys()) if (!live.has(key)) map.delete(key)
  try {
    writeFileSync(SESSIONS_FILE(), JSON.stringify(Object.fromEntries(map), null, 2), 'utf8')
  } catch {
    // Non-fatal: the id stays in memory and this run still resumes correctly.
  }
}

function rememberSessionId(chatId: string, id: string): void {
  const map = sessionIds()
  if (map.get(chatId) === id) return
  map.set(chatId, id)
  persistSessionIds()
}

export function forgetAgentSdkSession(sessionId: string): void {
  sessionIds().delete(sessionId)
  persistSessionIds()
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

/** Roughly a few thousand words of history — enough to recover the thread of a
 *  conversation without spending the whole context window re-reading it. */
const REPLAY_BUDGET = 12_000

/**
 * Rebuild the conversation from what the renderer still has.
 *
 * The fallback for when `resume` isn't available: a first run after this fix, a
 * Claude Code transcript that has since been pruned, or a session id that no
 * longer resolves. The renderer keeps its own copy of every turn, so the history
 * is not actually lost — it just has to be handed over as text instead of picked
 * up by reference.
 *
 * Oldest turns are dropped first when it doesn't fit, because the recent ones are
 * what the next reply has to be coherent with.
 */
function replayPrompt(messages: IncomingMessage[] | undefined, prompt: string): string {
  if (!Array.isArray(messages) || messages.length < 2) return prompt

  const turns: string[] = []
  // Skip the last message: that is the prompt itself, passed in separately.
  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i]
    const text = (message?.parts ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
      .trim()
    if (!text) continue
    const line = `${message.role === 'user' ? 'User' : 'You'}: ${text}`
    if (turns.join('\n\n').length + line.length > REPLAY_BUDGET) break
    turns.unshift(line)
  }

  if (turns.length === 0) return prompt
  return (
    'Here is the conversation so far, for your reference. Do not greet the user ' +
    'again or restate it — simply carry on from where it left off.\n\n' +
    `<conversation>\n${turns.join('\n\n')}\n</conversation>\n\n` +
    `The user now says:\n${prompt}`
  )
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

/** The partial-message payload, narrowed to the parts we render. The SDK types
 *  it as Anthropic's full `BetaRawMessageStreamEvent`, which carries far more
 *  than a chat transcript needs. */
interface StreamEvent {
  type?: string
  index?: number
  content_block?: { type?: string }
  delta?: { type?: string; text?: string; thinking?: string }
}

interface SdkMessage {
  type?: string
  subtype?: string
  session_id?: string
  message?: { content?: ContentBlock[] }
  /** Only on `stream_event` messages, which `includePartialMessages` turns on. */
  event?: StreamEvent
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
  /**
   * The other half of `canUseTool`. The stream that is blocked cannot receive
   * anything, so the decision arrives as its own request and resolves the parked
   * promise by id.
   */
  app.post('/agent-sdk/permission', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      id?: string
      behavior?: 'allow' | 'deny'
      alwaysAllow?: boolean
    } | null

    if (!body?.id || (body.behavior !== 'allow' && body.behavior !== 'deny')) {
      return c.json({ ok: false, error: 'id and behavior are required' }, 400)
    }

    // Passed through as a plain decision: turning it into a `PermissionResult`
    // needs the `suggestions` the SDK handed to that specific call, which only
    // the parked handler still has.
    const settled = settleApproval(body.id, {
      behavior: body.behavior,
      alwaysAllow: body.alwaysAllow === true
    })

    // Not an error worth shouting about: a reload or a stopped run can leave the
    // renderer holding a card whose promise is already gone.
    return c.json({ ok: settled })
  })

  /**
   * Say something to a turn that is already running.
   *
   * `now` redirects it — the agent takes the new instruction into the work in
   * progress instead of finishing what it was told first. `next` queues behind
   * it and runs when the current turn lands.
   *
   * Both used to be impossible. A string prompt is sealed once the run starts,
   * so the renderer held typed-ahead messages in memory until `onFinish` and
   * lost them on reload, and redirecting meant stopping and starting over.
   */
  app.post('/agent-sdk/steer', async (c) => {
    const { id, text, priority } = (await c.req.json().catch(() => ({}))) as {
      id?: string
      text?: string
      priority?: 'now' | 'next'
    }
    if (!id || !text?.trim()) return c.json({ ok: false, reason: 'id and text are required' }, 400)

    const input = liveInputs.get(id)
    // Not an error: the turn may have finished between typing and sending, in
    // which case the caller should send it as an ordinary message instead.
    if (!input) return c.json({ ok: false, reason: 'no run in flight' })

    input.push(text, priority === 'now' ? 'now' : 'next')
    return c.json({ ok: true })
  })

  /**
   * Stop, and mean it.
   *
   * `useChat`'s own `stop()` aborts the fetch, which only detaches the reader —
   * the Claude Code subprocess kept going, kept spending the subscription
   * window, and kept firing tool side effects, so a "stopped" turn could still
   * write files afterwards. `interrupt()` is what actually halts the turn.
   *
   * Note that `interrupt()` takes no arguments in this SDK version: the wire
   * protocol has a `cancel_queued` flag, but it is not exposed. Anything already
   * queued behind this turn therefore survives the stop and runs next. Mochi's
   * queue lives in the renderer today, so it is the renderer's job to clear it —
   * see the stop handler in Session.tsx.
   */
  app.post('/agent-sdk/stop', async (c) => {
    const { id } = (await c.req.json().catch(() => ({}))) as { id?: string }
    const run = id ? liveRuns.get(id) : undefined
    if (!run) return c.json({ ok: false, reason: 'no run in flight' })

    try {
      await run.interrupt()
      return c.json({ ok: true })
    } catch (err) {
      // An older CLI without the interrupt capability, or a run that finished
      // between the click and this request. Neither is worth an error in the UI.
      return c.json({ ok: false, reason: err instanceof Error ? err.message : String(err) })
    }
  })

  /**
   * Lines for the mascot to say, written in the agent's own voice.
   *
   * Called when a loadout is saved, so the cost is one short generation per edit
   * rather than one per sticker — the mascot fires these constantly and a live
   * call each time would be both slow and expensive.
   */
  app.post('/agent-sdk/mascot-lines', async (c) => {
    const { persona, kind } = (await c.req.json().catch(() => ({}))) as {
      persona?: string
      /** `finish` reports on work just completed; `poke` reacts to being
       *  prodded while idle. Two different moments, so two different briefs. */
      kind?: 'finish' | 'poke'
    }

    const brief =
      kind === 'poke'
        ? 'Write 6 very short lines this agent might say when the user pokes or ' +
          'clicks on it while it is idle. It has NOT been working on anything and ' +
          'has NOTHING to report. It is simply reacting to being touched — ' +
          'greeting, teasing, being pleased at the attention, asking what you want. ' +
          'Never mention finishing, tasks, work, or being done: nothing happened.'
        : 'Write 6 very short lines this agent might say to its user in a ' +
          'desktop mascot speech bubble — the kind of thing said just after ' +
          'finishing a small task.'

    try {
      let out = ''
      for await (const raw of query({
        prompt:
          'Here is an AI agent\'s persona:\n\n' +
          (persona?.trim() || 'A friendly, plain-spoken assistant.').slice(0, 2000) +
          '\n\n' +
          brief +
          ' Each under 40 characters, lowercase, no ' +
          'emoji, no quotes. One per line, nothing else.',
        options: {
          systemPrompt:
            'You write short, warm, concrete one-liners in a given character voice. ' +
            'You never explain yourself and never number your output.',
          allowedTools: [],
          env: subscriptionEnv(appVersion),
          maxTurns: 1
        }
      })) {
        const message = raw as SdkMessage
        if (message.type !== 'assistant') continue
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text' && block.text) out += block.text
        }
      }

      const lines = out
        .split('\n')
        .map((l) => l.replace(/^\s*[-*\d.)\s]+/, '').replace(/^["'\s]+|["'\s]+$/g, '').trim())
        .filter((l) => l.length > 0 && l.length <= 60)
        .slice(0, 6)

      // Fewer than two is not a voice, it is a fluke — let the caller keep
      // whatever it had rather than replacing a good set with one line.
      return c.json({ lines: lines.length >= 2 ? lines : null })
    } catch {
      // Generation is a nicety. A failure must never block saving a loadout.
      return c.json({ lines: null })
    }
  })

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

        const workspace = describeWorkspace(chatId)
        const resume = sessionIds().get(chatId)
        // No id to resume means the agent has never heard any of this — either a
        // brand-new chat (where there is nothing to replay anyway) or one being
        // picked up after a restart. `replayPrompt` is a no-op in the first case.
        const opening = resume ? prompt : replayPrompt(body.messages, prompt)
        let textIndex = 0
        /** SDK content-block index → the stream part we opened for it. */
        const openBlocks = new Map<number, { id: string; kind: 'text' | 'thinking' }>()
        // The Claude Code harness runs its own internal tools (ToolSearch, and
        // whatever else it adds later) to load our deferred MCP tools. Those are
        // plumbing, not something a Mochi user asked for, so they never reach a
        // tool card — and we track their ids to drop the matching results too.
        const suppressed = new Set<string>()

        // Set as soon as anything reaches the user. A retry is only safe before
        // that point — replaying after half a reply has landed would show it twice.
        let streamed = false

        const runTurn = async (promptText: string, resumeId?: string): Promise<void> => {
          const input = inputChannel(promptText)
          const run = query({
            prompt: input.stream,
            options: {
              systemPrompt: agent
                ? [
                    buildSystemPrompt(agent, settings.userName),
                    workspace.note,
                    ASK_USER_NOTE,
                    describeSubagents(chatId)
                  ]
                    .filter(Boolean)
                    .join('\n\n')
                : undefined,
              model: modelName || undefined,
              ...(workspace.cwd ? { cwd: workspace.cwd } : {}),
              mcpServers: { mochi: mochiServer, ...userMcpServers() },
              // Skills live on the filesystem, so they stay off until asked for —
              // enabling them silently would widen what the agent can reach.
              ...(settings.skills?.enabled
                ? { skills: settings.skills.allow, settingSources: ['project' as const] }
                : {}),
              // Note: this is the SDK's *auto-approve* list, not a restriction
              // list — see docs/debug-permission-prompt.md.
              allowedTools: AUTO_APPROVED,
              disallowedTools: DISALLOWED_BUILTINS,
              env: subscriptionEnv(appVersion),
              /*
               * The permission prompt. Before this existed the SDK had nobody to
               * ask, so a Write simply stalled and the agent told the user to
               * look for a prompt that could never appear — see
               * docs/debug-permission-prompt.md.
               *
               * Returning `null` would mean "no opinion, use the default rules",
               * which is what we already do for the auto-approved list. Anything
               * else parks until the renderer answers.
               */
              canUseTool: async (toolName, toolInput, { signal, suggestions, blockedPath }) => {
                const id = randomUUID()
                writer.write({
                  type: 'data-permission',
                  id,
                  data: {
                    id,
                    toolName: toolName.replace(TOOL_PREFIX, ''),
                    input: toolInput,
                    blockedPath: blockedPath ?? null,
                    // Only offer "always allow" when the SDK gave us rules to
                    // apply — inventing our own would drift from its policy.
                    canAlwaysAllow: Boolean(suggestions?.length)
                  }
                })

                const shortName = toolName.replace(TOOL_PREFIX, '')

                // The card is in the thread, but the thread may be behind three
                // other windows — and this one *blocks*. A finished turn the user
                // misses is a missed update; a missed approval is a run that
                // never continues, so it deserves the mascot at least as much.
                bus.emitMascotState({ state: 'asking', note: `needs your OK: ${shortName}` })
                notifyIfAway('needs-approval', `${shortName} is waiting on your go-ahead`)

                // And on the mascot itself, which may be the only part of Mochi
                // on screen. Sent with the session's name because with more than
                // one conversation open, "allow this?" is not answerable without
                // knowing which one asked.
                const full = describeApprovalTarget(toolInput, blockedPath)
                bus.emitApproval({
                  id,
                  sessionId: chatId,
                  sessionTitle: load().sessions.find((s) => s.id === chatId)?.title ?? 'a session',
                  toolName: shortName,
                  target: full.slice(0, APPROVAL_TARGET_MAX),
                  truncated: full.length > APPROVAL_TARGET_MAX
                })

                return new Promise<PermissionResult>((resolve) => {
                  const timer = setTimeout(() => {
                    pendingApprovals.delete(id)
                    bus.emitApproval(null)
                    resolve({ behavior: 'deny', message: 'Timed out waiting for approval.' })
                  }, APPROVAL_TIMEOUT_MS)

                  pendingApprovals.set(id, {
                    resolve: (decision) => {
                      if (decision.behavior === 'deny') {
                        resolve({ behavior: 'deny', message: 'You declined this.' })
                        return
                      }
                      // "Always allow" hands the SDK back its own suggested
                      // rules, which is how it stops asking — building our own
                      // rule store here would drift from its policy engine.
                      resolve(
                        decision.alwaysAllow && suggestions?.length
                          ? { behavior: 'allow', updatedPermissions: suggestions }
                          : { behavior: 'allow' }
                      )
                    },
                    timer
                  })

                  // An aborted run must not leave the promise parked forever.
                  signal.addEventListener('abort', () => {
                    if (pendingApprovals.has(id)) {
                      clearTimeout(timer)
                      pendingApprovals.delete(id)
                      bus.emitApproval(null)
                      resolve({ behavior: 'deny', message: 'Run was stopped.' })
                    }
                  })
                })
              },
              // Real deltas instead of whole content blocks. Without this the
              // route only saw a block once it was complete, so a long reply
              // arrived in paragraph-sized jumps and looked frozen in between.
              includePartialMessages: true,
              ...(resumeId ? { resume: resumeId } : {}),
              maxTurns: 24
            }
          })

          // Registered before the first await so a stop or a steer arriving
          // immediately still finds something to act on.
          liveRuns.set(chatId, run)
          liveInputs.set(chatId, input)

          /*
           * The mascot follows the run, not just the tool.
           *
           * `setMascotState` only fires when the agent chooses to call it, so a
           * turn where it never bothered left the mascot sitting on idle while
           * the chat clearly said "thinking" — the sprite states existed and
           * nothing routine drove them. The lifecycle is known here for free, so
           * it is emitted here, and an explicit `setMascotState` still overrides
           * it whenever the agent wants something more specific.
           */
          bus.emitMascotState({ state: 'thinking', note: 'thinking' })

          try {
            for await (const raw of run) {
              const message = raw as SdkMessage

            if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
              rememberSessionId(chatId, message.session_id)
              continue
            }

            /*
             * The turn is done — but the conversation may not be. A streaming
             * prompt keeps the run alive until the input ends, which is what
             * lets a queued follow-up become the next turn on the same
             * connection. `closeWhenDrained` ends it only once nothing is still
             * waiting, so the run stops here when the user has said nothing more
             * and continues when they have.
             */
            if (message.type === 'result') {
              // Back to resting. `done` rather than `idle` so a folder with a
              // finished-work sprite gets to use it; the fallback chain lands on
              // idle for one that has not.
              bus.emitMascotState({ state: 'done', note: 'finished' })
              input.closeWhenDrained()
              continue
            }

            /*
             * Live token deltas.
             *
             * `content_block_start` opens a part, each `content_block_delta`
             * appends to it, `content_block_stop` closes it. The SDK indexes
             * blocks per message, so `openBlocks` maps that index onto the id
             * we gave the part — the two numbering schemes are not the same and
             * reusing the SDK's index as our id would collide across messages.
             */
            if (message.type === 'stream_event') {
              const event = message.event
              const index = event?.index ?? 0

              if (event?.type === 'content_block_start') {
                const kind = event.content_block?.type
                if (kind !== 'text' && kind !== 'thinking') continue
                const id = `${kind === 'text' ? 't' : 'r'}${textIndex++}`
                openBlocks.set(index, { id, kind })
                writer.write({ type: kind === 'text' ? 'text-start' : 'reasoning-start', id })
              } else if (event?.type === 'content_block_delta') {
                const open = openBlocks.get(index)
                const delta = event.delta
                const text =
                  delta?.type === 'text_delta'
                    ? delta.text
                    : delta?.type === 'thinking_delta'
                      ? delta.thinking
                      : undefined
                if (!open || !text) continue
                // Only real prose counts as "the user has seen something" —
                // reasoning alone should not block the resume retry.
                if (open.kind === 'text') streamed = true
                writer.write({
                  type: open.kind === 'text' ? 'text-delta' : 'reasoning-delta',
                  id: open.id,
                  delta: text
                })
              } else if (event?.type === 'content_block_stop') {
                const open = openBlocks.get(index)
                if (!open) continue
                openBlocks.delete(index)
                writer.write({ type: open.kind === 'text' ? 'text-end' : 'reasoning-end', id: open.id })
              }
              continue
            }

            if (message.type !== 'assistant' && message.type !== 'user') continue

            for (const block of message.message?.content ?? []) {
              // Text and thinking already went out delta by delta above. The
              // completed message repeats them in full, so emitting from here
              // too would print every reply twice.
              if (block.type === 'text' || block.type === 'thinking') {
                continue
              } else if (block.type === 'tool_use' && block.id) {
                const rawName = block.name ?? ''
                if (!rawName.startsWith(TOOL_PREFIX) && HIDDEN_BUILTINS.has(rawName)) {
                  suppressed.add(block.id)
                  continue
                }
                // Mochi's own tools set the mascot themselves where it matters;
                // this covers the file and shell tools, which are most of the
                // time a turn actually spends working.
                if (!rawName.startsWith(TOOL_PREFIX)) {
                  bus.emitMascotState({ state: 'tool-running', note: rawName })
                }
                writer.write({
                  type: 'tool-input-available',
                  toolCallId: block.id,
                  // Strip the MCP namespace so the tool card reads `sendSticker`
                  // rather than `mcp__mochi__sendSticker`.
                  toolName: rawName.replace(TOOL_PREFIX, ''),
                  input: block.input ?? {}
                })
              } else if (block.type === 'tool_result' && block.tool_use_id) {
                // Back to thinking. `tool-running` was only ever entered, never
                // left, so one file read early in a turn left the mascot looking
                // busy for the rest of it — including long stretches of pure
                // reasoning with no tool in flight. The next tool sets it again.
                bus.emitMascotState({ state: 'thinking', note: 'thinking' })
                if (suppressed.has(block.tool_use_id)) continue
                writer.write({
                  type: 'tool-output-available',
                  toolCallId: block.tool_use_id,
                  output: block.content ?? null
                })
              }
            }
            }
          } finally {
            // Only clear our own registration: a retry after a failed `resume`
            // registers a second run under the same key, and the first one
            // unwinding must not delete the live one.
            if (liveRuns.get(chatId) === run) liveRuns.delete(chatId)
            if (liveInputs.get(chatId) === input) liveInputs.delete(chatId)
            // An error path can leave the generator parked on its wake promise.
            input.closeWhenDrained()
          }
        }

        try {
          await runTurn(opening, resume)
        } catch (err) {
          /*
           * A `resume` the CLI can no longer honour — its transcript pruned, the
           * store cleared, the id written by a different install. Left alone this
           * surfaces as a hard error on a conversation that looks perfectly fine
           * in the UI, so the pointer is dropped and the turn is retried by
           * handing over the transcript as text instead.
           */
          if (resume && !streamed) {
            forgetAgentSdkSession(chatId)
            try {
              await runTurn(replayPrompt(body.messages, prompt))
            } catch (retryErr) {
              writer.write({
                type: 'error',
                errorText: retryErr instanceof Error ? retryErr.message : String(retryErr)
              })
            }
          } else {
            writer.write({
              type: 'error',
              errorText: err instanceof Error ? err.message : String(err)
            })
          }
        }

        writer.write({ type: 'finish-step' })
        writer.write({ type: 'finish' })
      },
      onError: (err) => (err instanceof Error ? err.message : String(err))
    })

    return createUIMessageStreamResponse({ stream })
  })
}
