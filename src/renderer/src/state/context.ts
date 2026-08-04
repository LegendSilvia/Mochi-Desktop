import { createContext, useContext } from 'react'
import type {
  AgentLoadout,
  AppSettings,
  AssetLibrary,
  MascotState,
  SpriteSlot,
  PersistedState,
  ServerInfo,
  Session,
  StickerMode,
  StickerRule
} from '@shared/types'
import type { Screen } from './screens'

/**
 * Store shape, context and hook.
 *
 * These live apart from `store.tsx` so that file exports only the provider
 * component — Fast Refresh gives up on a module that mixes components with
 * other exports.
 */

export interface StickerBurst {
  id: number
  stickerSrc: string | null
  soundSrc: string | null
  modes: StickerMode[]
  caption: string
}

export interface State {
  ready: boolean
  screen: Screen
  settings: AppSettings
  agents: AgentLoadout[]
  sessions: Session[]
  rules: StickerRule[]
  library: AssetLibrary | null
  server: ServerInfo | null
  activeSessionId: string
  mascotState: MascotState
  mascotNote: string
  pinOpen: boolean
  recOpen: boolean
  archOpen: boolean
  menuOpen: boolean
  mentionOpen: boolean
  searchOpen: boolean
  stickerPickerOpen: boolean
  newAgentId: string
  newSessionType: Session['type']
  /** Latest sticker event; the mascot layer watches this. */
  burst: StickerBurst | null
  /**
   * First message typed on the Start-a-session screen, handed to the chat once
   * it mounts. Without this the text was only ever used for the session title
   * and then dropped on the floor.
   */
  pendingSend: string | null
  /** The running tour, or null. Steps are indexes into its definition. */
  tour: { id: string; step: number } | null
}

export type Action =
  | { type: 'ready'; payload: Partial<State> }
  | { type: 'screen'; screen: Screen }
  | { type: 'settings'; patch: Partial<AppSettings> }
  | { type: 'mascot-config'; patch: Partial<AppSettings['mascot']> }
  | { type: 'agents'; agents: AgentLoadout[] }
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'rules'; rules: StickerRule[] }
  | { type: 'library'; library: AssetLibrary }
  | { type: 'active'; id: string }
  | { type: 'mascot-state'; state: MascotState; note?: string }
  | {
      type: 'toggle'
      key:
        | 'pinOpen'
        | 'recOpen'
        | 'archOpen'
        | 'menuOpen'
        | 'mentionOpen'
        | 'searchOpen'
        | 'stickerPickerOpen'
      value?: boolean
    }
  | { type: 'new-agent'; id: string }
  | { type: 'new-type'; value: Session['type'] }
  | { type: 'burst'; burst: StickerBurst | null }
  | { type: 'pending-send'; text: string | null }
  | { type: 'sync'; payload: PersistedState }
  | { type: 'tour-start'; id: string }
  | { type: 'tour-step'; step: number }
  | { type: 'tour-end' }

export interface FireStickerOptions {
  stickerId?: string | null
  caption?: string
  modes?: StickerMode[]
  /** Which set of generated lines to speak from. `finish` reports on work,
   *  `poke` reacts to being prodded. Defaults to `finish`. */
  voice?: 'finish' | 'poke'
}

export interface Store extends State {
  dispatch: React.Dispatch<Action>
  inSettings: boolean
  activeSession: Session | undefined
  agentById: (id: string) => AgentLoadout | undefined
  stickerSrc: (id: string | null) => string | null
  soundSrc: (id: string | null) => string | null
  spriteSrc: (state: SpriteSlot) => string | null
  /** Fire a sticker + sound as one event. The single entry point — M1-10. */
  fireSticker: (opts?: FireStickerOptions) => void
  reloadLibrary: () => void
}

export const StoreCtx = createContext<Store | null>(null)

export function useStore(): Store {
  const ctx = useContext(StoreCtx)
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>')
  return ctx
}
