import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { bus } from '../events'
import { MASCOT_STATES } from '../../shared/types'

/**
 * Mochi-native tools. These are what make the mascot layer reachable from an
 * agent rather than only from armed rules — the "agent may also pick freely"
 * toggle in Stickers & sound is what exposes `sendSticker` to the model.
 *
 * Tools MUST be defined via createTool() with id/description/inputSchema/execute;
 * plain object definitions silently fail to execute.
 */

export const sendStickerTool = createTool({
  id: 'sendSticker',
  description:
    'Send a sticker to the user. Use this to celebrate a finished task, acknowledge ' +
    'thanks, or flag that something went wrong. The sticker and its sound fire ' +
    'together as one event. Use it sparingly — it is a punctuation mark, not a habit.',
  inputSchema: z.object({
    sticker: z
      .string()
      .describe('Sticker name, e.g. "nice-work", "party", "blush", "oh-no", "nap"'),
    caption: z.string().optional().describe('Short line to show with the sticker')
  }),
  outputSchema: z.object({
    sent: z.boolean()
  }),
  execute: async ({ sticker, caption }) => {
    bus.emitSticker({ event: 'manual', stickerId: sticker, caption })
    return { sent: true }
  }
})

export const setMascotStateTool = createTool({
  id: 'setMascotState',
  description:
    'Set the mascot to a lifecycle state so the user can see what you are doing at a ' +
    'glance. Set "thinking" before a long reasoning step, "tool-running" while a tool ' +
    'is working, "done" when the task finishes, "error" when something failed.',
  inputSchema: z.object({
    state: z.enum(MASCOT_STATES as [string, ...string[]]).describe('Mascot lifecycle state'),
    note: z.string().optional().describe('Short status line, e.g. "running tests"')
  }),
  outputSchema: z.object({
    state: z.string()
  }),
  execute: async ({ state, note }) => {
    bus.emitMascotState({ state: state as (typeof MASCOT_STATES)[number], note })
    return { state }
  }
})

/**
 * Ask the user a question with pickable answers.
 *
 * The tool returns as soon as the question is posed rather than blocking on an
 * answer: the renderer draws the options from the tool *input*, and a click
 * sends the chosen text back as an ordinary user turn. That keeps the agent
 * loop free of a suspend/resume dance and behaves identically on both the
 * Mastra and Agent SDK backends, which have very different pause semantics.
 *
 * Mastra ships a first-class `askUserTool` that genuinely suspends the run
 * (`@mastra/core/tools`, resumed with `agent.resumeStream`). It is not used here
 * for exactly the reason above — it exists only on the Mastra route, and the
 * default route is the Agent SDK. See `docs/mastra-docs-inventory.md` §4 for the
 * decision that would let us adopt it.
 *
 * Calling this more than once in a turn is supported: the composer docks every
 * unanswered question together and sends the answers as one reply.
 */
export const askUserTool = createTool({
  id: 'askUser',
  description:
    'Ask the user a question and offer specific answers they can click. Use this ' +
    'when you need a decision before continuing — which approach to take, whether ' +
    'to push, which file to touch. Prefer it over a plain question in your reply, ' +
    'because the answers become one tap instead of typing. Keep options short. ' +
    'Call it once per question if you need to ask several things at once.',
  inputSchema: z.object({
    question: z.string().describe('The question, one short sentence'),
    options: z
      .array(z.string())
      .min(2)
      .max(5)
      .describe('Between 2 and 5 answers the user can pick from'),
    multiple: z
      .boolean()
      .optional()
      .describe(
        'Let the user pick more than one option. Defaults to false — use it only ' +
          'when the answers genuinely combine, not to hedge an either/or.'
      ),
    allowOther: z
      .boolean()
      .optional()
      .describe('Also let the user type a free-form answer. Defaults to true.')
  }),
  outputSchema: z.object({
    asked: z.boolean()
  }),
  execute: async () => ({ asked: true })
})

export const mochiTools = {
  sendSticker: sendStickerTool,
  setMascotState: setMascotStateTool,
  askUser: askUserTool
}

export type MochiToolId = keyof typeof mochiTools

/**
 * The document library, handed in by main.
 *
 * The tools below need `src/main/rag.ts`, and importing it here would pull the
 * Electron-dependent store into a module that is deliberately free of
 * main-process imports (see the note on `workspaceFor` in ../index.ts). Both
 * run in the same process; the dependency only points one way.
 *
 * Null until main provides it, and the tools say so rather than throwing —
 * a Mastra instance built in a test has no library and should not crash for it.
 */
export interface DocsService {
  search: (query: string, limit?: number) => Promise<Array<{ title: string; text: string; how: string }>>
  addNote: (title: string, text: string) => Promise<{ ok: boolean; chunks: number; reason?: string }>
}

let docs: DocsService | null = null

export function provideDocs(impl: DocsService): void {
  docs = impl
}

export const searchDocsTool = createTool({
  id: 'searchDocs',
  description:
    'Search the documents the user has added to Mochi. Use this before answering ' +
    'anything that depends on their own notes, specs or code rather than general ' +
    'knowledge. Returns the most relevant passages with the file they came from — ' +
    'quote and cite them rather than paraphrasing from memory.',
  inputSchema: z.object({
    query: z.string().describe('What to look for, in natural language'),
    limit: z.number().optional().describe('How many passages to return. Defaults to 6.')
  }),
  outputSchema: z.object({ passages: z.string() }),
  execute: async ({ query, limit }) => {
    if (!docs) return { passages: 'The document library is not available.' }
    const hits = await docs.search(query, limit ?? 6)
    if (hits.length === 0) {
      return { passages: 'No matching passages. The library may be empty.' }
    }
    return {
      passages: hits
        .map((h, i) => `[${i + 1}] ${h.title} (${h.how})\n${h.text}`)
        .join('\n\n---\n\n')
    }
  }
})

export const saveDocTool = createTool({
  id: 'saveDoc',
  description:
    "Save a note into the user's document library so it can be found later with " +
    'searchDocs. Use it when something worth keeping was worked out in this ' +
    'conversation — a decision and its reasoning, a summary, a spec. Write the ' +
    'note to stand on its own: someone reading it in six months must understand ' +
    'it without this conversation. Saving the same title again revises that note.',
  inputSchema: z.object({
    title: z.string().describe('A short, specific title. Reused titles overwrite.'),
    text: z.string().describe('The note itself, in markdown. Self-contained.')
  }),
  outputSchema: z.object({ saved: z.boolean(), detail: z.string() }),
  execute: async ({ title, text }) => {
    if (!docs) return { saved: false, detail: 'The document library is not available.' }
    const res = await docs.addNote(title, text)
    return {
      saved: res.ok,
      detail: res.ok
        ? `Saved "${title}" in ${res.chunks} passage${res.chunks === 1 ? '' : 's'}.`
        : `Not saved: ${res.reason}.`
    }
  }
})

/**
 * Tools every Mastra agent gets, regardless of its loadout.
 *
 * Not part of `mochiTools`, which is filtered by `loadout.toolIds` — and
 * `toolIds` is not editable anywhere in the UI, so anything added there would
 * be unreachable for every agent that already exists. The Agent SDK route
 * offers these unconditionally too, and an agent that loses its library merely
 * by switching backend is the asymmetry this closes.
 */
export const docTools = {
  searchDocs: searchDocsTool,
  saveDoc: saveDocTool
}
