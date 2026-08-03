/**
 * Types shared across main, preload and renderer.
 *
 * Keep this file dependency-free — it is imported from all three processes and
 * anything it pulls in gets pulled into the preload sandbox too.
 */

/** Mascot lifecycle states. Each maps to a sprite, a motion and a sound. */
export type MascotState = 'idle' | 'thinking' | 'tool-running' | 'error' | 'done' | 'sleeping'

/** Sprite file names are derived from these — dropping `work.png` fills `tool-running`. */
export const MASCOT_STATES: MascotState[] = [
  'idle',
  'thinking',
  'tool-running',
  'error',
  'done',
  'sleeping'
]

/** Short label used on studio tiles, per the handoff (idle/think/work/oops/done/sleep). */
export const MASCOT_STATE_LABELS: Record<MascotState, string> = {
  idle: 'idle',
  thinking: 'think',
  'tool-running': 'work',
  error: 'oops',
  done: 'done',
  sleeping: 'sleep'
}

export type IdleMotion = 'breathe' | 'float' | 'sway' | 'still'
export type MascotShell = 'bare' | 'card' | 'orb' | 'terrarium'
/** Any combination may be active at once; default is all three. */
export type StickerMode = 'chat' | 'bubble' | 'overlay'
export type StickerRate = 'rare' | 'often' | 'constant'
export type Theme = 'dark' | 'light'
export type Contrast = 'whisper' | 'calm' | 'crisp'
export type SessionKind = 'chat' | 'code'
export type SessionType = 'normal' | 'supervised' | 'standing' | 'scratch'

export interface Sticker {
  id: string
  name: string
  tag: string
  /** `mochi-asset://` URL, or null when the tile is still a placeholder. */
  src: string | null
}

export interface SoundAsset {
  id: string
  name: string
  /** Seconds. 0 when not yet probed. */
  duration: number
  src: string | null
}

export interface Sprite {
  state: MascotState
  src: string | null
}

/** A rule arms a sticker + sound against an agent event. */
export interface StickerRule {
  id: string
  /** Human-readable trigger, e.g. "tests go green". */
  when: string
  /** Event name the runtime matches on. */
  event: StickerEvent
  stickerId: string | null
  soundId: string | null
  showAs: StickerMode
  howOften: 'always' | 'once-per-hour' | 'once'
  enabled: boolean
}

export type StickerEvent =
  'tests-green' | 'task-finished' | 'thanked' | 'tool-error' | 'idle-20min' | 'manual'

export interface MascotConfig {
  shell: MascotShell
  idleMotion: IdleMotion
  /** px, clamped 72–200. */
  size: number
  /** 0–1. */
  opacity: number
  visible: boolean
  stickerModes: StickerMode[]
  stickerRate: StickerRate
  bounceOnDrop: boolean
  dragAnywhere: boolean
  walkWindowEdges: boolean
  rememberPosition: boolean
  /** Unprompted-talk likelihood, 0–10. */
  talksUnprompted: number
  /**
   * Sound played when the mascot enters each state. Absent or null means silent
   * for that state — only `done`/`error` are worth a noise by default.
   */
  stateSounds?: Partial<Record<MascotState, string | null>>
  bubbleStyle: 'soft' | 'square' | 'none'
}

export interface AgentLoadout {
  id: string
  name: string
  /** One-line role, shown under the name on cards. */
  description: string
  instructions: string
  expectedOutput: string
  /** Mastra model-router string, always `provider/model`. */
  model: string
  toolIds: string[]
  isDefault: boolean
  /** 0–10. */
  chattiness: number
  stickerFrequency: number
  workingMemory: boolean
  semanticRecall: boolean
  voiceReplies: boolean
  /** Deliberately defaults to false — pushing without asking is a big deal. */
  canPushWithoutAsking: boolean
  /** Folder under the sprites root, e.g. `sprout`. */
  spritePreset: string
  /**
   * Stickers this agent may send. Empty or absent means "any" — a fresh loadout
   * shouldn't be mute until you curate a list.
   */
  allowedStickerIds?: string[]
  accent?: string
}

export interface Session {
  id: string
  title: string
  kind: SessionKind
  type: SessionType
  agentId: string
  /** Extra agents pulled in with `@name`. The original agent stays supervisor. */
  subagentIds: string[]
  pinned: boolean
  /** Archived sessions drop out of Recents into their own collapsed group. */
  archived?: boolean
  busy: boolean
  /** Epoch ms. Drives the Today / Yesterday / Last week grouping. */
  updatedAt: number
  /** Mastra memory thread id. Absent for `scratch` sessions, which save nothing. */
  threadId?: string
  workspacePath?: string
  branch?: string
}

export interface QuietHours {
  enabled: boolean
  /** "22:00" */
  from: string
  to: string
}

export interface AppSettings {
  theme: Theme
  contrast: Contrast
  accent: string
  sound: boolean
  quietHours: QuietHours
  mascot: MascotConfig
  defaultAgentId: string
  defaultSessionType: SessionType
  /** Cap in USD; 0 disables the check. */
  spendCap: number
  warnAt80Percent: boolean
  /** Which model handles which job. Values are model-router strings. */
  modelRoles: {
    conversation: string
    quickJobs: string
    embeddings: string
    evalGrader: string
  }
  preferSubscription: boolean
  fallbackToOllamaOffline: boolean
  storageProvider: 'libsql' | 'postgres' | 'upstash'
  /** Agent may call sendSticker() on its own, beyond the armed rules. */
  agentMayPickStickers: boolean
}

export interface AssetLibrary {
  sprites: Sprite[]
  stickers: Sticker[]
  sounds: SoundAsset[]
  /** Native-form folder paths, shown to the user as-is. */
  roots: { sprites: string; stickers: string; sounds: string }
}

export interface ServerInfo {
  /** Port the embedded Mastra server bound to. Chosen at runtime, never hard-coded. */
  port: number
  baseUrl: string
  /** Resolved @mastra/core version — the title bar shows this, not a literal. */
  mastraVersion: string
  appVersion: string
}

export interface ProviderAccount {
  id: string
  name: string
  billedVia: 'subscription' | 'api key' | 'local'
  /** Masked, e.g. `sk-••••••4f2a`. Real keys live in the OS credential store. */
  account: string | null
  connected: boolean
  /** Env var Mastra reads for this provider. */
  envVar?: string
}

/** Payload the main process pushes when an agent event should fire a sticker. */
export interface StickerFireEvent {
  ruleId: string | null
  stickerId: string | null
  soundId: string | null
  modes: StickerMode[]
  caption?: string
}
