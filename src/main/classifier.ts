import { query } from '@anthropic-ai/claude-agent-sdk'
import { assess } from '../shared/consequences'
import { subscriptionEnv } from './agent-sdk-route'

/**
 * The chosen-model classifier for Auto.
 *
 * Native Auto runs Anthropic's own classifier and never reaches this file. This
 * is the other arm: the user named a model in the Auto submenu, so that model
 * gets a say on each call the consequence table did not already stop.
 *
 * It can only ever narrow. `assess()` runs first and returns before the model
 * is even asked, so a `card` verdict is not something the model can appeal —
 * the worst a confused or hostile model can do is ask for a permission card
 * that would have been shown anyway.
 */

export interface ClassifyOptions {
  /** Router id of the model the user chose in the Auto submenu. */
  model: string
  toolName: string
  input: unknown
  workspaceRoot?: string
  /** Cancels with the turn, so a stopped run leaves no model call behind. */
  signal?: AbortSignal
  appVersion: string
}

export type ClassifierVerdict = {
  decision: 'allow' | 'deny' | 'ask'
  reason: string
}

/**
 * Long enough for a small model to answer, short enough that a permission
 * prompt does not feel hung. The user is watching a blocked turn while this
 * runs, so the timeout is a UI budget, not a network one.
 */
const CLASSIFIER_TIMEOUT_MS = 15_000

/** What of the arguments goes into the prompt. A whole-file Write would
 *  otherwise put the file in the context of a yes/no question. */
const ARGS_MAX = 3000

const SYSTEM_PROMPT =
  'You decide whether a tool call may run without interrupting the user. ' +
  'You answer with one JSON object and nothing else. You never use tools, ' +
  'and you never explain yourself outside the JSON.'

export async function classify(opts: ClassifyOptions): Promise<ClassifierVerdict> {
  // The table first, and it is final. This ordering is the whole safety
  // property: a call it stops never reaches the model at all, so no model
  // output can widen what runs.
  const table = assess(opts.toolName, opts.input, { workspaceRoot: opts.workspaceRoot })
  if (table.verdict === 'card') {
    return { decision: 'ask', reason: table.reason ?? 'a safety rule stopped it' }
  }

  let args: string
  try {
    args = JSON.stringify(opts.input) ?? ''
  } catch {
    return { decision: 'ask', reason: 'its arguments could not be read' }
  }

  const prompt = [
    `Tool: ${opts.toolName}`,
    opts.workspaceRoot ? `Open folder: ${opts.workspaceRoot}` : 'No folder is open.',
    `Arguments: ${args.slice(0, ARGS_MAX)}`,
    '',
    'Answer with exactly this JSON and nothing else:',
    '{"decision":"allow"|"deny"|"ask","reason":"<one short sentence>"}',
    '',
    'allow — routine and reversible, the user would not want to be asked.',
    'deny  — clearly destructive or outside what was asked for.',
    'ask   — anything else.',
    '',
    'Answer "ask" whenever you are unsure. A needless question costs the user ' +
      'one click; a wrong "allow" can cost them work they cannot get back.'
  ].join('\n')

  try {
    const text = await withTimeout(runModel(prompt, opts), CLASSIFIER_TIMEOUT_MS, opts.signal)
    return parseVerdict(text)
  } catch {
    // Timeout, abort, a model that is not reachable, anything at all. A
    // classifier that is down must never become a classifier that says yes.
    return { decision: 'ask', reason: 'the classifier could not be reached' }
  }
}

async function runModel(prompt: string, opts: ClassifyOptions): Promise<string> {
  let out = ''
  for await (const raw of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: opts.model,
      // It answers a question; it does not act. An empty allow-list plus no
      // canUseTool would stall any tool it tried, but maxTurns 1 means it
      // never gets a second turn to try one.
      allowedTools: [],
      maxTurns: 1,
      // No settings, no skills. Those exist for the conversation, not for a
      // yes/no judgement, and loading them here would widen what a permission
      // check can read.
      settingSources: [],
      skills: [],
      env: subscriptionEnv(opts.appVersion)
    }
  })) {
    const message = raw as {
      type?: string
      message?: { content?: Array<{ type?: string; text?: string }> }
    }
    if (message.type !== 'assistant') continue
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text' && block.text) out += block.text
    }
  }
  return out
}

/** Rejects on timeout or abort so the caller's single catch handles both. */
function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('classifier timed out')), ms)
    const onAbort = (): void => reject(new Error('classifier aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    })
  })
}

/**
 * The model's answer, or `ask`.
 *
 * Models wrap JSON in prose and code fences however firmly you ask them not
 * to, so the first balanced object in the text is taken rather than the whole
 * string being parsed. Anything that is not exactly one of the three decisions
 * is `ask` — including a model that invents a fourth.
 */
function parseVerdict(text: string): ClassifierVerdict {
  const match = text.match(/\{[\s\S]*?\}/)
  if (!match) return { decision: 'ask', reason: 'the classifier did not answer in a usable form' }
  try {
    const parsed = JSON.parse(match[0]) as { decision?: unknown; reason?: unknown }
    const decision = parsed.decision
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') {
      return { decision: 'ask', reason: 'the classifier gave no clear answer' }
    }
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : 'the classifier gave no reason'
    return { decision, reason }
  } catch {
    return { decision: 'ask', reason: 'the classifier did not answer in a usable form' }
  }
}
