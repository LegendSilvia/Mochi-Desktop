import { EventEmitter } from 'node:events'
import type { ApprovalRequest, MascotState, StickerEvent } from '../shared/types'

/**
 * In-process bus between Mastra tools and the Electron main process.
 *
 * Tools run inside the embedded Mastra server, which lives in the same process as
 * the window, so a plain emitter is enough — no IPC hop needed on this side. Main
 * subscribes and forwards to the renderer.
 */
export interface MochiEvents {
  sticker: { event: StickerEvent; stickerId?: string; caption?: string }
  'mascot-state': { state: MascotState; note?: string }
  /** Null clears it — the decision came in, or the run ended. */
  approval: ApprovalRequest | null
}

class MochiBus extends EventEmitter {
  emitSticker(payload: MochiEvents['sticker']): void {
    this.emit('sticker', payload)
  }

  emitMascotState(payload: MochiEvents['mascot-state']): void {
    this.emit('mascot-state', payload)
  }

  emitApproval(payload: MochiEvents['approval']): void {
    this.emit('approval', payload)
  }
}

export const bus = new MochiBus()
