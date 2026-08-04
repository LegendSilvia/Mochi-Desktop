import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AgentLoadout,
  AppSettings,
  ApprovalRequest,
  ApprovalSettled,
  AssetLibrary,
  MascotState,
  PersistedState,
  ProviderAccount,
  ServerInfo,
  Session,
  StickerEvent,
  StickerRule,
  Theme,
  RagDoc,
  RagHit,
  EmbedderInfo,
  SpriteFile,
  SpriteSlot,
  DisplayInfo
} from '../shared/types'

/** Main answers with this instead of rejecting, so a bad folder name surfaces as
 *  a message in the studio rather than an unhandled rejection. */
export type MochiResult<T> = { ok: true; value: T } | { ok: false; error: string }

const IPC = {
  getBootstrap: 'mochi:bootstrap',
  getLibrary: 'mochi:library',
  listPresets: 'mochi:list-presets',
  mascotInteractive: 'mochi:mascot-interactive',
  pickPaths: 'mochi:pick-paths',
  ragAdd: 'mochi:rag-add',
  ragList: 'mochi:rag-list',
  ragRemove: 'mochi:rag-remove',
  ragSearch: 'mochi:rag-search',
  ragEmbedder: 'mochi:rag-embedder',
  readText: 'mochi:read-text',
  setMascotState: 'mochi:set-mascot-state',
  focusSession: 'mochi:focus-session',
  saveState: 'mochi:save-state',
  setTitleBarTheme: 'mochi:titlebar-theme',
  openFolder: 'mochi:open-folder',
  notify: 'mochi:notify',
  flashFrame: 'mochi:flash-frame',
  providersList: 'mochi:providers',
  providerSetKey: 'mochi:provider-set-key',
  providerDeleteKey: 'mochi:provider-delete-key',
  presetCreate: 'mochi:preset-create',
  presetRename: 'mochi:preset-rename',
  presetDelete: 'mochi:preset-delete',
  presetImport: 'mochi:preset-import',
  presetOpen: 'mochi:preset-open',
  spriteImport: 'mochi:sprite-import',
  spriteAssign: 'mochi:sprite-assign',
  spriteRemove: 'mochi:sprite-remove',
  listDisplays: 'mochi:list-displays',
  agentFinished: 'mochi:agent-finished',
  agentExport: 'mochi:agent-export',
  agentImport: 'mochi:agent-import',
  libraryChanged: 'mochi:library-changed',
  stickerFired: 'mochi:sticker-fired',
  mascotState: 'mochi:mascot-state',
  approval: 'mochi:approval',
  stateChanged: 'mochi:state-changed'
} as const

export interface Bootstrap {
  settings: AppSettings
  agents: AgentLoadout[]
  sessions: Session[]
  rules: StickerRule[]
  server: ServerInfo | null
  platform: string
  paths: { sprites: string; stickers: string; sounds: string; userData: string }
}

export interface StatePatch {
  settings?: AppSettings
  agents?: AgentLoadout[]
  sessions?: Session[]
  rules?: StickerRule[]
}

export interface StickerFiredPayload {
  event: StickerEvent
  stickerId?: string
  caption?: string
}

export interface MascotStatePayload {
  state: MascotState
  note?: string
}

export interface MochiApi {
  bootstrap: () => Promise<Bootstrap>
  library: (spritePreset?: string) => Promise<AssetLibrary>
  /** Mascot folders available under `mascots/` — the sprite sets to swap between. */
  listPresets: () => Promise<string[]>
  /** Create / rename / delete / import a mascot folder. Each answers with a
   *  result rather than rejecting, so the studio can show why something failed. */
  presetCreate: (name: string) => Promise<MochiResult<string>>
  presetRename: (from: string, to: string) => Promise<MochiResult<string>>
  presetDelete: (name: string) => Promise<MochiResult<void>>
  /** Native folder dialog, then copy the art in as a new mascot folder. */
  presetImport: () => Promise<MochiResult<string>>
  presetOpen: (preset: string) => Promise<string>
  /** Copy dropped images in. Bytes, not paths — the renderer reads the File
   *  itself, so main never takes an arbitrary path from it. */
  spriteImport: (
    preset: string,
    files: Array<{ name: string; bytes: Uint8Array }>
  ) => Promise<MochiResult<SpriteFile[]>>
  spriteAssign: (
    preset: string,
    state: SpriteSlot,
    file: string | null
  ) => Promise<MochiResult<void>>
  spriteRemove: (preset: string, file: string) => Promise<MochiResult<void>>
  /** Monitors the overlay can be pinned to. */
  listDisplays: () => Promise<DisplayInfo[]>
  /** A turn finished. Main decides whether the user is actually looking, and
   *  answers `true` when it surfaced the notification. */
  agentFinished: (caption?: string) => Promise<boolean>
  /** Write a loadout plus its mascot art out as one shareable file. */
  agentExport: (
    agent: AgentLoadout,
    preset: string,
    suggestedName: string
  ) => Promise<MochiResult<string>>
  /** Read one back. The art is unpacked into a new mascot folder; the returned
   *  loadout still needs a unique id, which the renderer assigns. */
  agentImport: () => Promise<MochiResult<{ agent: AgentLoadout; preset: string }>>
  /** Overlay window only: let clicks through, or capture them over the sprite. */
  mascotInteractive: (interactive: boolean) => Promise<void>
  /** Native open dialog for the composer's attach and workspace buttons. */
  pickPaths: (kind: 'file' | 'folder') => Promise<string[]>
  /** Document library backing the searchDocs tool. */
  ragAdd: (paths: string[]) => Promise<{ added: number; skipped: string[] }>
  ragList: () => Promise<RagDoc[]>
  ragRemove: (id: string) => Promise<void>
  ragSearch: (q: string) => Promise<RagHit[]>
  ragEmbedder: () => Promise<EmbedderInfo>
  /** File contents, so a diff can number its lines. Null when unreadable. */
  readText: (path: string) => Promise<string | null>
  /** Set the mascot state for every window at once. Sleep is decided in the
   *  renderer but must not differ between the app and the overlay. */
  setMascotState: (state: MascotState, note?: string) => Promise<void>
  /** Bring the app forward on a given session. The overlay's escape hatch for a
   *  command too long to read there. */
  focusSession: (sessionId: string) => Promise<void>
  saveState: (patch: StatePatch) => Promise<PersistedState>
  setTitleBarTheme: (theme: Theme, bg: string, symbol: string) => Promise<void>
  openFolder: (which: 'sprites' | 'stickers' | 'sounds') => Promise<string>
  notify: (title: string, body: string, icon?: string) => Promise<void>
  flashFrame: () => Promise<void>
  providers: () => Promise<ProviderAccount[]>
  setProviderKey: (id: string, key: string) => Promise<{ ok: boolean; reason?: string }>
  deleteProviderKey: (id: string) => Promise<void>
  onLibraryChanged: (cb: () => void) => () => void
  onStickerFired: (cb: (p: StickerFiredPayload) => void) => () => void
  onMascotState: (cb: (p: MascotStatePayload) => void) => () => void
  /** A tool parked waiting on the user, or the id of one just answered. */
  onApproval: (cb: (p: ApprovalRequest | ApprovalSettled) => void) => () => void
  /** The app was asked to show a particular session. */
  onFocusSession: (cb: (sessionId: string) => void) => () => void
  /** Another window persisted state; merge it so the two never drift. */
  onStateChanged: (cb: (s: PersistedState) => void) => () => void
}

/** Subscribe helper that hands back its own unsubscribe, so effects can clean up. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: MochiApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.getBootstrap),
  library: (spritePreset) => ipcRenderer.invoke(IPC.getLibrary, spritePreset),
  listPresets: () => ipcRenderer.invoke(IPC.listPresets),
  mascotInteractive: (interactive) => ipcRenderer.invoke(IPC.mascotInteractive, interactive),
  pickPaths: (kind) => ipcRenderer.invoke(IPC.pickPaths, kind),
  ragAdd: (paths) => ipcRenderer.invoke(IPC.ragAdd, paths),
  ragList: () => ipcRenderer.invoke(IPC.ragList),
  ragRemove: (id) => ipcRenderer.invoke(IPC.ragRemove, id),
  ragSearch: (q) => ipcRenderer.invoke(IPC.ragSearch, q),
  ragEmbedder: () => ipcRenderer.invoke(IPC.ragEmbedder),
  readText: (path) => ipcRenderer.invoke(IPC.readText, path),
  setMascotState: (state, note) => ipcRenderer.invoke(IPC.setMascotState, state, note),
  focusSession: (sessionId) => ipcRenderer.invoke(IPC.focusSession, sessionId),
  saveState: (patch) => ipcRenderer.invoke(IPC.saveState, patch),
  setTitleBarTheme: (theme, bg, symbol) =>
    ipcRenderer.invoke(IPC.setTitleBarTheme, theme, bg, symbol),
  openFolder: (which) => ipcRenderer.invoke(IPC.openFolder, which),
  notify: (title, body, icon) => ipcRenderer.invoke(IPC.notify, title, body, icon),
  flashFrame: () => ipcRenderer.invoke(IPC.flashFrame),
  providers: () => ipcRenderer.invoke(IPC.providersList),
  setProviderKey: (id, key) => ipcRenderer.invoke(IPC.providerSetKey, id, key),
  deleteProviderKey: (id) => ipcRenderer.invoke(IPC.providerDeleteKey, id),
  presetCreate: (name) => ipcRenderer.invoke(IPC.presetCreate, name),
  presetRename: (from, to) => ipcRenderer.invoke(IPC.presetRename, from, to),
  presetDelete: (name) => ipcRenderer.invoke(IPC.presetDelete, name),
  presetImport: () => ipcRenderer.invoke(IPC.presetImport),
  presetOpen: (preset) => ipcRenderer.invoke(IPC.presetOpen, preset),
  spriteImport: (preset, files) => ipcRenderer.invoke(IPC.spriteImport, preset, files),
  spriteAssign: (preset, state, file) => ipcRenderer.invoke(IPC.spriteAssign, preset, state, file),
  spriteRemove: (preset, file) => ipcRenderer.invoke(IPC.spriteRemove, preset, file),
  listDisplays: () => ipcRenderer.invoke(IPC.listDisplays),
  agentFinished: (caption) => ipcRenderer.invoke(IPC.agentFinished, caption),
  agentExport: (agent, preset, suggestedName) =>
    ipcRenderer.invoke(IPC.agentExport, agent, preset, suggestedName),
  agentImport: () => ipcRenderer.invoke(IPC.agentImport),
  onLibraryChanged: (cb) => on<void>(IPC.libraryChanged, () => cb()),
  onStickerFired: (cb) => on<StickerFiredPayload>(IPC.stickerFired, cb),
  onMascotState: (cb) => on<MascotStatePayload>(IPC.mascotState, cb),
  onApproval: (cb) => on<ApprovalRequest | ApprovalSettled>(IPC.approval, cb),
  onFocusSession: (cb) => on<string>(IPC.focusSession, cb),
  onStateChanged: (cb) => on<PersistedState>(IPC.stateChanged, cb)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('mochi', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore contextIsolation disabled
  window.electron = electronAPI
  // @ts-ignore contextIsolation disabled
  window.mochi = api
}
