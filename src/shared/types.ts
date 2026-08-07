/**
 * Types shared across main, preload and renderer.
 *
 * Keep this file dependency-free — it is imported from all three processes and
 * anything it pulls in gets pulled into the preload sandbox too.
 */

import type { PermissionMode } from './permission-modes'

/** Mascot lifecycle states. Each maps to a sprite, a motion and a sound. */
export type MascotState =
  | 'idle'
  | 'thinking'
  | 'tool-running'
  /** Blocked on the user: a tool is parked waiting for approval, or a question
   *  has been asked and nothing can continue until it is answered. */
  | 'asking'
  | 'error'
  | 'done'
  | 'sleeping'

/** Sprite file names are derived from these — dropping `work.png` fills `tool-running`. */
export const MASCOT_STATES: MascotState[] = [
  'idle',
  'thinking',
  'tool-running',
  'asking',
  'error',
  'done',
  'sleeping'
]

/**
 * How the mascot is being handled right now.
 *
 * Deliberately *not* part of `MascotState`. Lifecycle states are set by the
 * agent through `setMascotState`, and widening that enum would let it announce
 * that it was hovering over itself. These come from the overlay's own pointer
 * events instead, and only ever affect which sprite is drawn.
 */
export type MascotPose =
  | 'hover'
  | 'click'
  /** Held down — lifted, but not being moved. */
  | 'picked'
  | 'walk-left'
  | 'walk-right'
  | 'walk-up'
  | 'walk-down'

export const MASCOT_POSES: MascotPose[] = [
  'hover',
  'click',
  'picked',
  'walk-left',
  'walk-right',
  'walk-up',
  'walk-down'
]

/** Anything a sprite can be assigned to: a lifecycle state or a pose. */
export type SpriteSlot = MascotState | MascotPose

export const SPRITE_SLOTS: SpriteSlot[] = [...MASCOT_STATES, ...MASCOT_POSES]

/**
 * Short label used on studio tiles, per the handoff (idle/think/work/oops/done/sleep).
 *
 * These double as file names: dropping `work.png` into a mascot folder fills
 * `tool-running`, so every label has to stay a legal, lowercase file stem.
 */
export const MASCOT_STATE_LABELS: Record<SpriteSlot, string> = {
  idle: 'idle',
  thinking: 'think',
  'tool-running': 'work',
  asking: 'ask',
  error: 'oops',
  done: 'done',
  sleeping: 'sleep',
  hover: 'hover',
  click: 'click',
  picked: 'held',
  'walk-left': 'walk-left',
  'walk-right': 'walk-right',
  'walk-up': 'walk-up',
  'walk-down': 'walk-down'
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
  state: SpriteSlot
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
  | 'tests-green'
  | 'task-finished'
  | 'thanked'
  | 'tool-error'
  | 'idle-20min'
  /** A tool is parked waiting for the user to allow or deny it. Fires only when
   *  the app is not focused — an approval card you cannot see is a stalled turn. */
  | 'needs-approval'
  | 'manual'

/**
 * A tool parked waiting for the user, in a form the overlay can render.
 *
 * The chat stream carries approvals to the app window only, so the mascot never
 * knew one was pending — the one surface most likely to be visible when the app
 * is buried. This travels the mascot-state path instead: main to every window.
 */
export interface ApprovalRequest {
  id: string
  sessionId: string
  /** Which conversation is blocked. With several sessions open, "allow this?" is
   *  not answerable without knowing what asked. */
  sessionTitle: string
  /** Who is asking. The mascot wears one agent's face but any session can
   *  block, so the card has to say whose request this is. */
  agentName: string
  toolName: string
  /** The command or path, already shortened for a small surface. */
  target: string
  /** True when `target` had to be cut. Approving a command you can only half
   *  read is worse than being sent to the window that shows all of it. */
  truncated: boolean
}

/**
 * An approval that has been answered, wherever it was answered.
 *
 * Each card tracked its own decision locally, so answering on the desktop left
 * the in-app card still offering Allow and Deny for a command that had already
 * run. The id travels with the clear so every surface showing that request can
 * settle, not just the one that was clicked.
 */
export interface ApprovalSettled {
  id: string
  settled: true
}

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

  /* --- desktop overlay ---------------------------------------------------
   * Everything below was a constant in the code until the Overlay screen. All
   * optional so an existing settings.json keeps working; the defaults below
   * reproduce the old hard-coded behaviour exactly.
   */

  /** Corner the mascot starts in. Was always bottom-right. */
  anchor?: MascotAnchor
  /** Gap from that corner, px. Was 34 across and 30 down. */
  offsetX?: number
  offsetY?: number
  /** Which monitor the overlay covers. Null follows the primary display. */
  displayId?: number | null
  /** How hard it fights to stay on top. Was always `screen-saver`. */
  onTopLevel?: MascotOnTop
  /** What a click on the sprite does. Was always to fire a sticker. */
  clickAction?: 'sticker' | 'none'
  /** How long a sticker burst stays on screen, ms. Was 2600 (1500 for the
   *  full-screen card). */
  burstMs?: number

  /**
   * The desktop toast that replaced the OS notification.
   *
   * A native `Notification` could not show the mascot, obeyed the system's
   * notification settings rather than Mochi's, and on Windows landed in the
   * Action Centre where nobody saw it. This is drawn in the overlay instead, so
   * it looks like the mascot and is configurable here.
   */
  toastEnabled?: boolean
  toastAnchor?: MascotAnchor
  toastSize?: ToastSize

  /** The `idle · waiting on you` line under the sprite. Only ever drawn by the
   *  `card` and `terrarium` shells, and never optional until now. */
  showStatus?: boolean
  /** The soft ellipse under the sprite. Grounds it on a desktop, but reads as
   *  a smudge when the mascot sits over pale windows. */
  showShadow?: boolean
  /**
   * Minutes of no interaction before the mascot dozes off. 0 never sleeps.
   *
   * Independent of the idle sticker rule, which used to gate it — whether she
   * rests is a mascot behaviour, and tying it to whether you happened to
   * configure a sticker meant she never slept at all on a fresh install.
   */
  sleepAfterMin?: number
  /**
   * Whether the idle sticker rule wakes her when it fires.
   *
   * On by default: the sticker is the mascot speaking up, and speaking in your
   * sleep is a strange look. Turn it off to let her talk without stirring.
   */
  idleRuleWakes?: boolean

  /** The dimmed, blurred backdrop behind the full-screen sticker card. It is
   *  the most intrusive thing the app does to your desktop. */
  overlayScrim?: boolean
  /** How big that card is. Was a fixed 280px with 176px of art. */
  overlayCardSize?: ToastSize
}

export type ToastSize = 'small' | 'medium' | 'large'

export type MascotAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
/** Mirrors Electron's `setAlwaysOnTop` levels, narrowed to the useful three. */
export type MascotOnTop = 'normal' | 'floating' | 'screen-saver'

/** A monitor the overlay can be pinned to. */
export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  primary: boolean
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
  /**
   * Matches semantic recall pulls in per turn, 1–20.
   *
   * Optional because loadouts saved before this existed have no value for it
   * and the store's merge does not backfill agents — read it through
   * `DEFAULT_RECALL_TOP_K` rather than assuming it is set.
   */
  recallTopK?: number
  /**
   * How far recall may reach.
   *
   * `thread` searches this session only — it recovers what fell out of the
   * recent-message window, and nothing else. `resource` searches every past
   * session with this agent, which is what "do you remember last time?"
   * actually asks for.
   *
   * Optional for the same reason as `recallTopK`: loadouts predate it.
   * Defaults to `thread`, because reaching into other conversations should be
   * something you turned on rather than something that happened to you.
   */
  recallScope?: 'thread' | 'resource'
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
  /**
   * What the mascot says, in this agent's voice.
   *
   * Generated from the persona when the loadout is saved, rather than the fixed
   * `BUBBLE_LINES` every install shared — those were written for one imagined
   * assistant and sounded wrong coming from anyone else. Only the *default*
   * agent's lines are ever used: there is one mascot, so it has one voice.
   * Absent until a save generates them, and the built-in list is the fallback.
   */
  bubbleLines?: string[]
  /**
   * What it says when you poke it, as opposed to when it finishes something.
   *
   * Separate from `bubbleLines` because the two moments are not the same: one
   * is a report on work, the other is a reaction to being prodded, and a single
   * list made the mascot answer "that's done" to a poke that had interrupted
   * nothing. Same fallback rules — generated on save, editable by hand.
   */
  pokeLines?: string[]
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
  /** Hand-chosen position within Pinned, ascending. Only meaningful there:
   *  Recents is ordered by recency by definition, so a manual order would just
   *  fight `updatedAt` every time the session was used. Absent until the user
   *  actually drags something, and re-assigned across the whole pinned group on
   *  each reorder so the numbers never drift apart. */
  order?: number
  /** Archived sessions drop out of Recents into their own collapsed group. */
  archived?: boolean
  /** Set once the agent has named this session, so it is only titled once and a
   *  manual rename is never overwritten. */
  autoTitled?: boolean
  busy: boolean
  /**
   * What this session is allowed to do without asking.
   *
   * Per session rather than global: one session planning while another executes
   * is the normal case, not the exotic one. Absent on sessions saved before
   * this existed — the store merges shallowly and does not backfill — so every
   * reader goes through `coerceMode`.
   */
  mode?: PermissionMode
  /** Only meaningful when `mode` is `'auto'`. Absent means the native
   *  classifier; a model id means Mochi's own (Phase 2). */
  autoClassifierModel?: string
  /** Epoch ms. Drives the Today / Yesterday / Last week grouping. */
  updatedAt: number
  /** Mastra memory thread id. Absent for `scratch` sessions, which save nothing. */
  threadId?: string
  workspacePath?: string
  branch?: string
  /** Size of each docked edge in px — width for the sides, height for the
   *  bottom. Shared by every widget docked there, since they stack: the size
   *  belongs to the column, not to the widget. */
  dockSizes?: Partial<Record<DockSide, number>>
  /** Floating panels open over this chat, with their geometry. Per-session
   *  because a terminal and an open file belong to the folder you are working
   *  in, not to the app. Live PTY ids are deliberately not persisted — the shell
   *  dies with the process, so a restored terminal widget opens a fresh shell. */
  widgets?: WidgetInstance[]
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
  /**
   * How `@agent` delegation behaves.
   *
   * `capped`/`uncapped` open a genuinely separate agent session per subagent —
   * real memory isolation, but each one draws on the same subscription window.
   * `simulated` keeps everything in one session and is free, at the cost of the
   * isolation being nominal; the UI says so rather than implying otherwise.
   */
  delegationMode: 'capped' | 'uncapped' | 'simulated'
  /** Concurrent subagents allowed under `capped`. */
  delegationLimit: number
  /**
   * How many times one message may be passed between agents by tagging.
   *
   * The safety property of peer tagging. Two agents that each end a reply by
   * tagging the other will otherwise talk until the subscription window is
   * gone, in a chat nobody is reading, at a full turn per pass. Adjustable
   * because the right number depends on what you use them for — a pair that
   * genuinely trades work needs more room than a pair that answers once each —
   * and because setting it to 1 is how you can watch the guard work.
   */
  tagChainLimit: number
  fallbackToOllamaOffline: boolean
  storageProvider: 'libsql' | 'postgres' | 'upstash'
  /** Agent may call sendSticker() on its own, beyond the armed rules. */
  agentMayPickStickers: boolean
  /** MCP servers offered to agents on the subscription backend. */
  mcpServers: McpServerSpec[]
  /**
   * Agent Skills. `all` hands over every skill the Claude Code install can see;
   * a list restricts it to those names.
   */
  skills: { enabled: boolean; allow: string[] | 'all' }
  /** What a newly created session starts in. */
  defaultMode: PermissionMode
  /** What agents call the user. Empty means no name is set. */
  userName: string
  /** Ids of tours already completed or skipped. */
  toursSeen: string[]
  /** Developer mode. Turns on the in-app debug log. Off by default and never
   *  implied by anything else — capture costs a ring buffer of allocations per
   *  turn, and the log carries prompts and tool arguments verbatim, so it stays
   *  something the user opts into. */
  devMode?: boolean
}

/**
 * The slice of state written to settings.json — and the payload broadcast to
 * every window when it changes, so the overlay never drifts from the app window.
 */
export interface PersistedState {
  settings: AppSettings
  agents: AgentLoadout[]
  sessions: Session[]
  rules: StickerRule[]
}

/**
 * One MCP server.
 *
 * `http` points at a URL; `stdio` launches a local command. Kept deliberately
 * close to the Agent SDK's own shape so wiring it through is a rename, not a
 * translation layer that can drift.
 *
 * `headers` and `env` carry only the *names*. Nearly every real MCP server
 * wants a bearer token or an API key in one of them, and this file is plain
 * JSON in `%APPDATA%\Mochi` — so the values go to the same safeStorage-backed
 * store the provider keys use, keyed by `mcpSecretKey()`.
 */
export interface McpServerSpec {
  id: string
  name: string
  type: 'http' | 'stdio'
  /** http only. */
  url?: string
  /** http only. Header names; values live in the encrypted secret store. */
  headers?: string[]
  /** stdio only. */
  command?: string
  args?: string[]
  /** stdio only. Environment variable names; values in the secret store. */
  env?: string[]
  enabled: boolean
}

/**
 * One image sitting in a mascot folder, assigned to a state or not.
 *
 * Assignment is recorded in the folder's `mascot.json` rather than by renaming
 * the file, so importing art never destroys the names you gave it and a state
 * can be re-pointed without touching the disk. Folders that predate the
 * manifest still work: a file whose stem is a state name is matched by name.
 */
export interface SpriteFile {
  /** File name inside the mascot folder — the manifest's key into the folder. */
  file: string
  src: string
  /** Null when the image is in the folder but not yet mapped to anything. */
  state: SpriteSlot | null
  /** True when the mapping came from the file name rather than the manifest. */
  byName?: boolean
}

export interface AssetLibrary {
  sprites: Sprite[]
  /** Everything in the current mascot folder, so unassigned art is visible. */
  spriteFiles: SpriteFile[]
  /** Which mascot folder `sprites`/`spriteFiles` were read from. */
  preset: string
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

/** A file in the document library that backs retrieval. */
export interface RagDoc {
  id: string
  path: string
  title: string
  bytes: number
  chunks: number
  /** How many chunks have an embedding. Zero means keyword-only for this file. */
  embedded: number
}

/** One retrieved passage. `how` records which half of the hybrid search found it. */
export interface RagHit {
  text: string
  title: string
  path: string
  score: number
  how: 'keyword' | 'vector' | 'both'
}

/** What can currently turn text into vectors, if anything. */
export interface EmbedderInfo {
  kind: 'ollama' | 'openai' | 'openrouter' | 'none'
  model: string
  ready: boolean
  detail: string
}

/** Payload the main process pushes when an agent event should fire a sticker. */
export interface StickerFireEvent {
  ruleId: string | null
  stickerId: string | null
  soundId: string | null
  modes: StickerMode[]
  caption?: string
}

/* ---------------------------------------------------------------- widgets */

/**
 * The floating panels that live over the chat.
 *
 * Two families, deliberately in one type. The first five are the old right-hand
 * panel's sections, which became widgets so that everything overlaying the chat
 * collapses, moves and resizes by the same rules. The rest are the tools —
 * navigator, editor, terminal and friends.
 *
 * The difference that matters is who creates them: panel widgets appear on their
 * own once they have something to say, tools are opened by the user or by
 * another widget (clicking a file in the navigator opens the editor).
 */
/** Edges a widget can snap to. The bottom is a strip under the chat rather than
 *  a column beside it — the natural home for a terminal. */
export type DockSide = 'left' | 'right' | 'bottom'

export type WidgetKind =
  | 'agents'
  | 'activity'
  | 'files'
  | 'rules'
  | 'permissions'
  | 'navigator'
  | 'editor'
  | 'terminal'
  | 'search'
  | 'skills'
  | 'tasks'
  | 'plan'

/** Position and size in chat-relative pixels. Absent until the user drags. */
export interface WidgetGeom {
  x: number
  y: number
  w: number
  h: number
}

export interface WidgetInstance {
  id: string
  kind: WidgetKind
  /** Widgets are born collapsed — a bubble the user clicks to open. */
  open: boolean
  geom?: WidgetGeom
  /** Editor: the workspace-relative file. Terminal: its title. */
  path?: string
  title?: string
  /** Snapped to an edge. A docked widget is a real column or strip beside the
   *  chat rather than an overlay on top of it, so the chat gives up the space. */
  dock?: DockSide
  /** Where it floated before it was docked, so undocking puts it back rather
   *  than dropping it in a default position. */
  floatGeom?: WidgetGeom
}

/** One row in the file navigator. Mirrors Mastra's `FileEntry`. */
export interface WsEntry {
  name: string
  type: 'file' | 'directory'
  size?: number
}

export interface WsHit {
  path: string
  score: number
  excerpt: string
}

export interface WsDiagnostic {
  line: number
  character: number
  /** LSP severity: 1 error, 2 warning, 3 info, 4 hint. */
  severity: number
  message: string
  source?: string
}

export interface WsSkill {
  name: string
  description?: string
  path: string
}

export interface WsFile {
  text: string
  /** Handed back on save so a write can refuse when the agent got there first. */
  mtime: number | null
  truncated: boolean
  /** Readable, but big enough to warn about before you scroll into it. */
  large?: boolean
  size: number
}

/** Why a file could not be opened. None of these are faults — they are files a
 *  text editor has no business showing, so the editor draws a notice. */
export interface WsFileRefusal {
  error: string
  kind?: 'binary' | 'too-large' | 'directory' | 'undecodable'
  size?: number
}
