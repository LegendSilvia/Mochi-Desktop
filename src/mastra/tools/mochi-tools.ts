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

export const mochiTools = {
  sendSticker: sendStickerTool,
  setMascotState: setMascotStateTool
}

export type MochiToolId = keyof typeof mochiTools
