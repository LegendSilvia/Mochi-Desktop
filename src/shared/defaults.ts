import type { AgentLoadout, AppSettings, Session, StickerRule } from './types'

/**
 * Seed data matching the design handoff. Sprout is the default agent; the Start
 * screen relies on a default being present so its button is never dead on arrival.
 *
 * Model strings are Mastra model-router format (`provider/model`). Verify names
 * against the live registry before changing them — see M12-04.
 */
export const DEFAULT_AGENTS: AgentLoadout[] = [
  {
    id: 'sprout',
    name: 'Sprout',
    description: 'build buddy — reads the repo, writes the patch',
    instructions:
      'You are Sprout, a warm and plain-spoken build buddy for a solo developer.\n' +
      'Read before you write. Explain what you changed in one or two sentences.\n' +
      'When tests pass, say so plainly. When you are unsure, say that instead of guessing.',
    expectedOutput: 'A short answer, then the diff or the command that does the work.',
    model: 'anthropic/claude-sonnet-4-6',
    toolIds: ['sendSticker', 'setMascotState'],
    isDefault: true,
    chattiness: 7,
    stickerFrequency: 6,
    workingMemory: true,
    semanticRecall: true,
    voiceReplies: false,
    canPushWithoutAsking: false,
    spritePreset: 'sprout'
  },
  {
    id: 'kettle',
    name: 'Kettle',
    description: 'digs through docs and sources, answers with citations',
    instructions:
      'You are Kettle. You search the indexed sources before answering and you cite what you used.\n' +
      'If the sources do not cover the question, say so rather than filling the gap from memory.',
    expectedOutput: 'An answer with the sources it came from.',
    model: 'openai/gpt-5-mini',
    toolIds: ['sendSticker'],
    isDefault: false,
    chattiness: 4,
    stickerFrequency: 3,
    workingMemory: true,
    semanticRecall: true,
    voiceReplies: false,
    canPushWithoutAsking: false,
    spritePreset: 'kettle'
  },
  {
    id: 'moss',
    name: 'Moss',
    description: 'quiet — short answers, no chatter',
    instructions:
      'You are Moss. Answer in as few words as the question allows. No preamble, no summary.',
    expectedOutput: 'The shortest correct answer.',
    model: 'anthropic/claude-haiku-4-5',
    toolIds: [],
    isDefault: false,
    chattiness: 1,
    stickerFrequency: 1,
    workingMemory: false,
    semanticRecall: false,
    voiceReplies: false,
    canPushWithoutAsking: false,
    spritePreset: 'moss'
  }
]

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
    visible: true,
    stickerModes: ['chat', 'bubble', 'overlay'],
    stickerRate: 'often',
    bounceOnDrop: true,
    dragAnywhere: true,
    walkWindowEdges: false,
    rememberPosition: true,
    talksUnprompted: 4,
    bubbleStyle: 'soft'
  },
  defaultAgentId: 'sprout',
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
  fallbackToOllamaOffline: false,
  storageProvider: 'libsql',
  agentMayPickStickers: true
}

/** The rules table from the handoff, armed on first launch. */
export const DEFAULT_RULES: StickerRule[] = [
  {
    id: 'r-tests-green',
    when: 'tests go green',
    event: 'tests-green',
    stickerId: 'nice-work',
    soundId: 'ta-daa',
    showAs: 'overlay',
    howOften: 'always',
    enabled: true
  },
  {
    id: 'r-task-done',
    when: 'long task finishes',
    event: 'task-finished',
    stickerId: 'party',
    soundId: 'chime-soft',
    showAs: 'bubble',
    howOften: 'always',
    enabled: true
  },
  {
    id: 'r-thanks',
    when: 'i say thank you',
    event: 'thanked',
    stickerId: 'blush',
    soundId: null,
    showAs: 'chat',
    howOften: 'always',
    enabled: true
  },
  {
    id: 'r-tool-error',
    when: 'a tool errors',
    event: 'tool-error',
    stickerId: 'oh-no',
    soundId: 'uh-oh',
    showAs: 'bubble',
    howOften: 'once-per-hour',
    enabled: true
  },
  {
    id: 'r-idle',
    when: 'no input for 20 min',
    event: 'idle-20min',
    stickerId: 'nap',
    soundId: null,
    showAs: 'bubble',
    howOften: 'once',
    enabled: false
  }
]

const HOUR = 60 * 60 * 1000
const now = Date.now()

export const DEFAULT_SESSIONS: Session[] = [
  {
    id: 's-recall',
    title: 'fix recall timeout',
    kind: 'code',
    type: 'normal',
    agentId: 'sprout',
    subagentIds: ['kettle'],
    pinned: true,
    busy: false,
    updatedAt: now - HOUR,
    branch: 'fix/recall-timeout',
    workspacePath: 'hub'
  },
  {
    id: 's-notes',
    title: 'weekend notes',
    kind: 'chat',
    type: 'normal',
    agentId: 'moss',
    subagentIds: [],
    pinned: true,
    busy: false,
    updatedAt: now - 3 * HOUR
  },
  {
    id: 's-migrate',
    title: 'migrate storage to libsql',
    kind: 'code',
    type: 'normal',
    agentId: 'sprout',
    subagentIds: [],
    pinned: false,
    busy: true,
    updatedAt: now - 5 * HOUR,
    branch: 'chore/libsql'
  },
  {
    id: 's-rag',
    title: 'what did the rag docs say',
    kind: 'chat',
    type: 'normal',
    agentId: 'kettle',
    subagentIds: [],
    pinned: false,
    busy: false,
    updatedAt: now - 26 * HOUR
  },
  {
    id: 's-sticker',
    title: 'sticker rules brainstorm',
    kind: 'chat',
    type: 'scratch',
    agentId: 'sprout',
    subagentIds: [],
    pinned: false,
    busy: false,
    updatedAt: now - 5 * 24 * HOUR
  }
]

/** Alternative accents offered as a tweak in the handoff. */
export const ACCENT_OPTIONS = ['#9dc98a', '#a9b8e2', '#e0b487', '#9ec9c4', '#c9a8d4']
