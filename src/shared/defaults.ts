import type { AgentLoadout, AppSettings, Session, StickerRule } from './types'

/**
 * First-run state.
 *
 * Deliberately empty: a fresh install has no agents, no sessions and no sticker
 * rules, so nothing on screen is invented history. The Agents screen builds the
 * first loadout from scratch (see `create()` there) and promotes it to default,
 * and the Start screen shows an empty state until one exists.
 *
 * Model strings are Mastra model-router format (`provider/model`). Verify names
 * against the live registry before changing them — see M12-04.
 */
export const DEFAULT_AGENTS: AgentLoadout[] = []

/**
 * Matches semantic recall pulls in per turn.
 *
 * Also the fallback for loadouts saved before the setting existed, which is why
 * it lives here rather than as a literal at each use site.
 */
export const DEFAULT_RECALL_TOP_K = 5

/** The loadout the Agents screen builds when there is nothing to clone from. */
export const BLANK_AGENT: Omit<AgentLoadout, 'id' | 'name'> = {
  description: 'a fresh loadout — tell it who it is',
  instructions: '',
  expectedOutput: '',
  model: 'anthropic/claude-sonnet-4-6',
  toolIds: ['sendSticker', 'setMascotState'],
  isDefault: false,
  chattiness: 5,
  stickerFrequency: 4,
  workingMemory: true,
  semanticRecall: false,
  recallTopK: DEFAULT_RECALL_TOP_K,
  recallScope: 'thread',
  voiceReplies: false,
  canPushWithoutAsking: false,
  spritePreset: 'sprout'
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  contrast: 'calm',
  accent: '#9dc98a',
  sound: true,
  quietHours: { enabled: false, from: '22:00', to: '08:00' },
  mascot: {
    shell: 'card',
    idleMotion: 'breathe',
    size: 112,
    opacity: 1,
    // Off on a fresh install: with no artwork yet the mascot renders an `art?`
    // placeholder, and a placeholder floating over the desktop is not a welcome.
    visible: false,
    stickerModes: ['chat', 'bubble', 'overlay'],
    stickerRate: 'often',
    bounceOnDrop: true,
    dragAnywhere: true,
    walkWindowEdges: false,
    rememberPosition: true,
    talksUnprompted: 4,
    bubbleStyle: 'soft'
  },
  // Empty until the first loadout is created — the Agents screen promotes it.
  defaultAgentId: '',
  defaultSessionType: 'normal',
  spendCap: 50,
  warnAt80Percent: true,
  modelRoles: {
    conversation: 'anthropic/claude-sonnet-4-6',
    quickJobs: 'anthropic/claude-haiku-4-5',
    embeddings: 'openai/text-embedding-3-small',
    evalGrader: 'openai/gpt-5-mini'
  },
  preferSubscription: true,
  // Capped by default: real isolation, but a fan-out of three subagents costs
  // roughly four turns against the same 5-hour window, and failing closed on
  // quota is worse than being a little slower.
  delegationMode: 'capped',
  delegationLimit: 2,
  // Enough for a genuine round trip and a follow-up. Longer than that is a
  // loop rather than a conversation — see `tagChainLimit`.
  tagChainLimit: 4,
  fallbackToOllamaOffline: false,
  storageProvider: 'libsql',
  agentMayPickStickers: true,
  mcpServers: [],
  // Off by default: skills are read off the filesystem, and turning that on
  // without asking would quietly widen what the agent can reach.
  skills: { enabled: false, allow: 'all' },
  userName: '',
  toursSeen: []
}

/**
 * No rules on a fresh install. The table is built in Stickers & sound; nothing
 * fires until the user arms something.
 */
export const DEFAULT_RULES: StickerRule[] = []

/** No invented history — the rail starts empty until a real session is started. */
export const DEFAULT_SESSIONS: Session[] = []

/** Alternative accents offered as a tweak in the handoff. */
export const ACCENT_OPTIONS = ['#9dc98a', '#a9b8e2', '#e0b487', '#9ec9c4', '#c9a8d4']
