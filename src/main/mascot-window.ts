import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { load } from './store'
import type { DisplayInfo } from '../shared/types'

/** Monitors the overlay can be pinned to, for the Overlay screen's picker. */
export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    width: d.workArea.width,
    height: d.workArea.height,
    primary: d.id === primaryId
  }))
}

/** The chosen monitor, falling back to primary when it has been unplugged. */
function targetDisplay(displayId: number | null | undefined): Electron.Display {
  if (displayId == null) return screen.getPrimaryDisplay()
  return screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
}

/**
 * The desktop overlay the mascot lives in.
 *
 * Inside the app window the mascot could only ever float over Mochi itself,
 * which defeats the point of a companion — it should sit on the desktop next to
 * whatever you're actually working in. This is a frameless, transparent,
 * always-on-top window covering the work area.
 *
 * Mouse events are ignored by default so the transparent expanse doesn't
 * swallow clicks meant for the windows underneath; main turns that off while the
 * pointer is genuinely over the sprite (see setMascotHitRects).
 */

let win: BrowserWindow | null = null

export function getMascotWindow(): BrowserWindow | null {
  return win
}

export function createMascotWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win

  const { workArea } = targetDisplay(load().settings.mascot.displayId)

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
  // the mascot visible over a maximised editor. Configurable now: that level
  // also sits above some full-screen apps and games, which not everyone wants.
  win.setAlwaysOnTop(true, load().settings.mascot.onTopLevel ?? 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // No `forward: true`. See setMascotHitRects for why: forwarding is what made
  // the cursor flicker across the whole desktop.
  win.setIgnoreMouseEvents(true)

  // Respect the persisted setting: a window that always shows itself on ready
  // cannot be started hidden, which is the default on a fresh install.
  win.on('ready-to-show', () => {
    if (load().settings.mascot.visible) win?.showInactive()
  })
  win.on('closed', () => {
    stopPolling()
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
  stopMascotHitTest()
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

/**
 * Click-through, decided here rather than in the renderer.
 *
 * This used to be `setIgnoreMouseEvents(true, { forward: true })`, with the
 * renderer watching `mousemove` to notice the pointer arriving over the sprite.
 * Forwarding is what made that possible and is also what made the cursor
 * flicker: on Windows every mouse event passed through a transparent,
 * always-on-top window makes the system re-evaluate the cursor, and this window
 * covers the entire work area — so it happened for every movement anywhere on
 * screen, over any application. Confirmed by hiding the mascot, which stopped it.
 *
 * So the overlay now ignores the mouse outright, with no forwarding, and main
 * polls the cursor position instead. `screen.getCursorScreenPoint()` is a cheap
 * syscall and needs no events to pass through anything.
 */
interface HitRect {
  x: number
  y: number
  w: number
  h: number
}

let hitRects: HitRect[] = []
/** Held on while the mascot is being dragged or its menu is open — the pointer
 *  is allowed to leave the sprite without the window going click-through
 *  underneath it mid-gesture. */
let hitLocked = false
let interactiveNow = false
let poll: NodeJS.Timeout | null = null

/** Fast enough that reaching for the mascot feels immediate, slow enough to cost
 *  nothing. A miss only delays grabbing it by a frame or two. */
const POLL_MS = 40

function stopPolling(): void {
  if (poll) clearInterval(poll)
  poll = null
}

function applyInteractive(next: boolean): void {
  if (next === interactiveNow) return
  interactiveNow = next
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!next)
}

function tick(): void {
  if (!win || win.isDestroyed() || !win.isVisible()) {
    applyInteractive(false)
    return
  }
  if (hitLocked) {
    applyInteractive(true)
    return
  }
  if (hitRects.length === 0) {
    applyInteractive(false)
    return
  }
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  const x = p.x - b.x
  const y = p.y - b.y
  applyInteractive(
    hitRects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
  )
}

/**
 * The parts of the overlay that should catch the mouse, in window coordinates.
 *
 * Sent by the renderer, which is the only side that knows where the sprite, its
 * bubbles, its menu and any approval card currently are.
 */
export function setMascotHitRects(rects: HitRect[], locked: boolean): void {
  hitRects = rects
  hitLocked = locked
  if (!win || win.isDestroyed()) return
  // Answer this movement now rather than waiting up to a frame for the poll —
  // it matters when the lock is what just changed.
  tick()
  if (!poll) poll = setInterval(tick, POLL_MS)
}

export function stopMascotHitTest(): void {
  stopPolling()
  hitRects = []
  hitLocked = false
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

/**
 * Re-apply the overlay settings that live on the window rather than in the DOM.
 *
 * Monitor and always-on-top level cannot be changed from the renderer — they are
 * properties of the BrowserWindow — so the Overlay screen writes them to
 * settings and this runs on the next save. Cheap and idempotent, which is what
 * lets it hang off every `saveState` rather than needing change detection.
 */
export function applyMascotWindowConfig(): void {
  if (!win || win.isDestroyed()) return
  const { mascot } = load().settings

  win.setAlwaysOnTop(true, mascot.onTopLevel ?? 'screen-saver')

  const { workArea } = targetDisplay(mascot.displayId)
  const b = win.getBounds()
  if (
    b.x !== workArea.x ||
    b.y !== workArea.y ||
    b.width !== workArea.width ||
    b.height !== workArea.height
  ) {
    win.setBounds(workArea)
  }
}

/**
 * Let the overlay take the keyboard, or hand it back.
 *
 * The window is created `focusable: false` so clicking the mascot never steals
 * focus from whatever you were typing in. That also means it cannot receive key
 * events at all, which is fine for a sprite and useless for a menu you can type
 * into — so focus is granted only while that menu is open, and revoked the
 * moment it closes.
 */
export function setMascotFocusable(focusable: boolean): void {
  if (!win || win.isDestroyed()) return
  win.setFocusable(focusable)
  if (focusable) win.focus()
  // Giving focus back is not enough on Windows: the overlay stays the active
  // window until something else is raised, so the app the user was in keeps its
  // caret but not its title bar. Blurring hands it back properly.
  else win.blur()
}