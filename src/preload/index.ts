import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AgentLoadout,
  AppSettings,
  AssetLibrary,
  MascotState,
  ProviderAccount,
  ServerInfo,
  Session,
  StickerEvent,
  StickerRule,
  Theme
} from '../shared/types'

const IPC = {
  getBootstrap: 'mochi:bootstrap',
  getLibrary: 'mochi:library',
  listPresets: 'mochi:list-presets',
  saveState: 'mochi:save-state',
  setTitleBarTheme: 'mochi:titlebar-theme',
  openFolder: 'mochi:open-folder',
  notify: 'mochi:notify',
  flashFrame: 'mochi:flash-frame',
  providersList: 'mochi:providers',
  providerSetKey: 'mochi:provider-set-key',
  providerDeleteKey: 'mochi:provider-delete-key',
  libraryChanged: 'mochi:library-changed',
  stickerFired: 'mochi:sticker-fired',
  mascotState: 'mochi:mascot-state'
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
  saveState: (patch: StatePatch) => Promise<void>
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
  saveState: (patch) => ipcRenderer.invoke(IPC.saveState, patch),
  setTitleBarTheme: (theme, bg, symbol) =>
    ipcRenderer.invoke(IPC.setTitleBarTheme, theme, bg, symbol),
  openFolder: (which) => ipcRenderer.invoke(IPC.openFolder, which),
  notify: (title, body, icon) => ipcRenderer.invoke(IPC.notify, title, body, icon),
  flashFrame: () => ipcRenderer.invoke(IPC.flashFrame),
  providers: () => ipcRenderer.invoke(IPC.providersList),
  setProviderKey: (id, key) => ipcRenderer.invoke(IPC.providerSetKey, id, key),
  deleteProviderKey: (id) => ipcRenderer.invoke(IPC.providerDeleteKey, id),
  onLibraryChanged: (cb) => on<void>(IPC.libraryChanged, () => cb()),
  onStickerFired: (cb) => on<StickerFiredPayload>(IPC.stickerFired, cb),
  onMascotState: (cb) => on<MascotStatePayload>(IPC.mascotState, cb)
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
