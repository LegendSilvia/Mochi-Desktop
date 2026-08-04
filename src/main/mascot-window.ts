import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { load } from './store'

/**
 * The desktop overlay the mascot lives in.
 *
 * Inside the app window the mascot could only ever float over Mochi itself,
 * which defeats the point of a companion — it should sit on the desktop next to
 * whatever you're actually working in. This is a frameless, transparent,
 * always-on-top window covering the work area.
 *
 * Mouse events are ignored by default so the transparent expanse doesn't
 * swallow clicks meant for the windows underneath; the renderer turns that off
 * while the pointer is genuinely over the sprite (see setMascotInteractive).
 */

let win: BrowserWindow | null = null

export function getMascotWindow(): BrowserWindow | null {
  return win
}

export function createMascotWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win

  const { workArea } = screen.getPrimaryDisplay()

  win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    // Keeps it out of the alt-tab order and above normal windows without
    // stealing focus from whatever the user is typing in.
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  // 'screen-saver' outranks ordinary always-on-top windows, which is what keeps
  // the mascot visible over a maximised editor.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })

  // Respect the persisted setting: a window that always shows itself on ready
  // cannot be started hidden, which is the default on a fresh install.
  win.on('ready-to-show', () => {
    if (load().settings.mascot.visible) win?.showInactive()
  })
  win.on('closed', () => {
    win = null
  })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/mascot.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/mascot.html'))
  }

  return win
}

export function destroyMascotWindow(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

/**
 * Let clicks through, or don't.
 *
 * `forward: true` matters — without it the renderer stops receiving the
 * mousemove events it needs to notice the pointer arriving over the sprite, and
 * the mascot becomes permanently un-grabbable.
 */
export function setMascotInteractive(interactive: boolean): void {
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(!interactive, { forward: true })
}

/**
 * Show or hide the overlay.
 *
 * `MascotLayer` returning null is not enough on its own — the transparent,
 * always-on-top window still covers the whole work area. Hiding the window is
 * what makes "off" actually mean off.
 */
export function setMascotVisible(visible: boolean): void {
  if (!win || win.isDestroyed()) return
  if (visible) win.showInactive()
  else win.hide()
}
