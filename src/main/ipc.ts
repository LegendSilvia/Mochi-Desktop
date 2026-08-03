import { BrowserWindow, ipcMain, Notification, nativeTheme, shell, app } from 'electron'
import type { FSWatcher } from 'chokidar'
import { readLibrary, watchAssets } from './assets'
import { deleteProviderKey, load, maskKey, readProviderKeys, save, writeProviderKey } from './store'
import { getServerInfo } from './mastra-server'
import { getPaths } from './paths'
import { bus } from '../mastra/events'
import type { ProviderAccount, Theme } from '../shared/types'

export const IPC = {
  getBootstrap: 'mochi:bootstrap',
  getLibrary: 'mochi:library',
  saveState: 'mochi:save-state',
  setTitleBarTheme: 'mochi:titlebar-theme',
  openFolder: 'mochi:open-folder',
  notify: 'mochi:notify',
  flashFrame: 'mochi:flash-frame',
  providersList: 'mochi:providers',
  providerSetKey: 'mochi:provider-set-key',
  providerDeleteKey: 'mochi:provider-delete-key',
  // main → renderer
  libraryChanged: 'mochi:library-changed',
  stickerFired: 'mochi:sticker-fired',
  mascotState: 'mochi:mascot-state'
} as const

/** Providers Mastra's model router knows, with the env var each one reads. */
const PROVIDERS: Array<Omit<ProviderAccount, 'account' | 'connected'>> = [
  // 'api key', not 'subscription': this list is the key store, and a key stored
  // here is billed per token. The subscription path does not use a key at all —
  // it runs through the Agent SDK and is toggled separately in Settings → Models.
  { id: 'anthropic', name: 'Anthropic', billedVia: 'api key', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', billedVia: 'api key', envVar: 'OPENAI_API_KEY' },
  { id: 'google', name: 'Google', billedVia: 'api key', envVar: 'GOOGLE_API_KEY' },
  { id: 'ollama', name: 'Ollama', billedVia: 'local' },
  { id: 'openrouter', name: 'OpenRouter', billedVia: 'api key', envVar: 'OPENROUTER_API_KEY' }
]

let watcher: FSWatcher | null = null

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.getBootstrap, () => ({
    ...load(),
    server: getServerInfo(),
    platform: process.platform,
    paths: getPaths()
  }))

  ipcMain.handle(IPC.getLibrary, (_e, spritePreset?: string) => readLibrary(spritePreset))

  ipcMain.handle(IPC.saveState, (_e, patch) => save(patch))

  ipcMain.handle(IPC.setTitleBarTheme, (_e, theme: Theme, bg: string, symbol: string) => {
    const win = getWindow()
    if (!win) return
    nativeTheme.themeSource = theme
    // Windows draws the real caption buttons; recolour them so they follow the
    // app theme instead of sitting in a mismatched strip (M0-15).
    if (process.platform === 'win32') {
      try {
        win.setTitleBarOverlay({ color: bg, symbolColor: symbol, height: 46 })
      } catch {
        // setTitleBarOverlay throws if the window wasn't created with titleBarOverlay
      }
    }
  })

  ipcMain.handle(IPC.openFolder, (_e, which: 'sprites' | 'stickers' | 'sounds') => {
    return shell.openPath(getPaths()[which])
  })

  ipcMain.handle(IPC.notify, (_e, title: string, body: string, iconPath?: string) => {
    if (!Notification.isSupported()) return
    new Notification({ title, body, icon: iconPath }).show()
  })

  ipcMain.handle(IPC.flashFrame, () => {
    const win = getWindow()
    if (win && !win.isFocused()) win.flashFrame(true)
  })

  ipcMain.handle(IPC.providersList, (): ProviderAccount[] => {
    const keys = readProviderKeys()
    return PROVIDERS.map((p) => {
      const stored = p.envVar ? keys[p.envVar] : undefined
      return {
        ...p,
        account: stored ? maskKey(stored) : null,
        connected: p.billedVia === 'local' ? true : Boolean(stored)
      }
    })
  })

  ipcMain.handle(IPC.providerSetKey, (_e, providerId: string, key: string) => {
    const provider = PROVIDERS.find((p) => p.id === providerId)
    if (!provider?.envVar) return { ok: false, reason: 'Unknown provider' }
    const result = writeProviderKey(provider.envVar, key)
    if (result.ok) process.env[provider.envVar] = key
    return result
  })

  ipcMain.handle(IPC.providerDeleteKey, (_e, providerId: string) => {
    const provider = PROVIDERS.find((p) => p.id === providerId)
    if (!provider?.envVar) return
    deleteProviderKey(provider.envVar)
    delete process.env[provider.envVar]
  })

  // Live asset folders → renderer
  watcher = watchAssets(() => {
    getWindow()?.webContents.send(IPC.libraryChanged)
  })

  // Mastra tools → renderer. This is the wire that makes the mascot react to the
  // agent instead of only to clicks (M1-18).
  bus.on('sticker', (payload) => {
    const win = getWindow()
    win?.webContents.send(IPC.stickerFired, payload)
    if (win && !win.isFocused()) win.flashFrame(true)
  })
  bus.on('mascot-state', (payload) => {
    getWindow()?.webContents.send(IPC.mascotState, payload)
  })

  app.on('before-quit', () => {
    void watcher?.close()
    watcher = null
  })
}
