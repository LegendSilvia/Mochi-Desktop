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
 */
export const askUserTool = createTool({
  id: 'askUser',
  description:
    'Ask the user a question and offer specific answers they can click. Use this ' +
    'when you need a decision before continuing — which approach to take, whether ' +
    'to push, which file to touch. Prefer it over a plain question in your reply, ' +
    'because the answers become one tap instead of typing. Keep options short.',
  inputSchema: z.object({
    question: z.string().describe('The question, one short sentence'),
    options: z
      .array(z.string())
      .min(2)
      .max(5)
      .describe('Between 2 and 5 answers the user can pick from'),
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
