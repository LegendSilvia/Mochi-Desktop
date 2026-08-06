import { app, shell, BrowserWindow, protocol, net, globalShortcut } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getPaths } from './paths'
import { applyProviderKeysToEnv, load } from './store'
import { startMastraServer, stopMastraServer } from './mastra-server'
import { IPC, registerIpc } from './ipc'
import { createMascotWindow, destroyMascotWindow } from './mascot-window'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => mainWindow

/** Title-bar overlay colours, from --bg2 / --tx2 in the token set. */
const OVERLAY = {
  dark: { color: '#191c20', symbolColor: '#9c9a95' },
  light: { color: '#f3f0ea', symbolColor: '#6b6660' }
}

/**
 * Serve user-dropped sprites, stickers and sounds over a custom protocol.
 *
 * The alternative — `file://` with webSecurity off — would open the whole disk to
 * the renderer. This keeps reads inside the three asset folders, with an explicit
 * containment check so a `..` in the URL cannot climb out.
 */
function registerAssetProtocol(): void {
  const paths = getPaths()
  const roots: Record<string, string> = {
    sprites: paths.sprites,
    stickers: paths.stickers,
    sounds: paths.sounds
  }

  protocol.handle('mochi-asset', async (request) => {
    const url = new URL(request.url)
    const kind = url.hostname
    const root = roots[kind]
    if (!root) return new Response('Unknown asset kind', { status: 404 })

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const resolved = normalize(join(root, relative))
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(resolved).toString())
  })
}

function createWindow(): void {
  const theme = load().settings.theme
  const overlay = OVERLAY[theme]

  mainWindow = new BrowserWindow({
    // 1440×888 is the design size; below 1180×760 the three-column screens break.
    width: 1440,
    height: 888,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: theme === 'dark' ? '#15171a' : '#faf8f4',
    // Windows draws its own caption buttons in the overlay; we reserve room for
    // them at the right end of our 46px title bar. macOS keeps traffic lights.
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...overlay, height: 46 } }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 15 } }
        : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Push-to-talk. `Alt+Space` opens the system menu on a normal Windows window, so
 * it has to be a global shortcut rather than a renderer key handler (M10-02).
 */
function registerShortcuts(): void {
  const ok = globalShortcut.register('Alt+Space', () => {
    mainWindow?.webContents.send(IPC.mascotState, { state: 'thinking', note: 'listening' })
  })
  if (!ok) {
    console.warn('[mochi] Alt+Space is taken by another app; push-to-talk needs rebinding')
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'mochi-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

/**
 * One Mochi at a time.
 *
 * Every instance writes the same `settings.json`, `sdk-sessions.json` and mascot
 * folders under `%APPDATA%\Mochi`, and nothing coordinates between them: each
 * holds the whole state in memory and writes it wholesale, so the last one to
 * save silently erases the other's agents, sessions and sprite assignments.
 *
 * This has now destroyed loadouts twice during development. The fix is a lock
 * rather than file-level merging, because merging two divergent copies of "all
 * the state" has no correct answer — you cannot tell a deleted agent from one
 * the other instance never saw.
 *
 * Must be requested before `whenReady`. The instance that loses quits, and the
 * guard inside the ready handler stops it building windows on the way out.
 */
const isPrimary = app.requestSingleInstanceLock()

if (!isPrimary) {
  app.quit()
} else {
  // Launching Mochi again should feel like clicking its taskbar icon.
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

app.whenReady().then(async () => {
  // `app.quit()` above does not stop this callback from running.
  if (!isPrimary) return

  // Toasts are attributed to Mochi rather than "electron.app.…" (M1-17).
  electronApp.setAppUserModelId('com.legendsilvia.mochi')

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  registerAssetProtocol()
  applyProviderKeysToEnv()

  try {
    const info = await startMastraServer(app.getVersion())
    console.log(`[mochi] Mastra ${info.mastraVersion} listening on ${info.baseUrl}`)
  } catch (err) {
    // A dead Mastra server is not a dead app — the mascot, studio and sticker
    // screens all still work. Surface it in the UI rather than failing to launch.
    console.error('[mochi] Mastra server failed to start:', err)
  }

  registerIpc(getWindow)
  createWindow()
  createMascotWindow()
  registerShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // The overlay is frameless and skips the taskbar, so nothing else would ever
  // close it — without this the app can't actually exit.
  destroyMascotWindow()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopMastraServer()
})
