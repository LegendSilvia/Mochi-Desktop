import { useCallback, useMemo } from 'react'
import type { DockSide, Session, WidgetGeom, WidgetInstance, WidgetKind } from '@shared/types'
import {
  DEFAULT_DOCK,
  DEFAULT_DOCK_H,
  MIN_DOCK,
  MIN_DOCK_H,
  WIDGETS,
  clampGeom,
  defaultGeom
} from './registry'

/**
 * The widgets belonging to one session.
 *
 * State lives on the session rather than in component state because a terminal
 * and an open file belong to the folder you are working in — switching sessions
 * and coming back should find them where you left them, and so should a restart.
 *
 * Panel widgets (agents, activity, …) are deliberately *not* written to the
 * session until you touch one. They have a single instance and a known kind, so
 * an absent record already means "closed, default size" — persisting six of
 * those for every session would be six records saying nothing.
 */
export interface WidgetApi {
  widgets: WidgetInstance[]
  /** The instance for a single-instance kind, if the user has touched it. */
  find: (kind: WidgetKind) => WidgetInstance | undefined
  /** Creates the widget. `show` opens it straight away; without it the widget
   *  is born as a bubble, which is what the add menu wants. */
  open: (kind: WidgetKind, opts?: { path?: string; title?: string; show?: boolean }) => void
  close: (id: string) => void
  /** Collapse back to a bubble, keeping geometry and contents. */
  collapse: (id: string) => void
  expand: (id: string) => void
  move: (id: string, geom: WidgetGeom) => void
  /** Snap to an edge. The widget stops being an overlay and becomes a column
   *  the chat makes room for; its floating geometry is kept for the way back. */
  dock: (id: string, side: DockSide) => void
  /** Create a widget already snapped to an edge. What dragging a rail bubble
   *  onto a side does — the widget does not exist until it lands. */
  openDocked: (kind: WidgetKind, side: DockSide) => void
  undock: (id: string) => void
  /** Live size of each edge, in px. */
  dockSizes: Record<DockSide, number>
  setDockSize: (side: DockSide, px: number) => void
  /** Point an existing editor at a different file, or open one if none is up.
   *  This is what the navigator calls, and the reason the editor never ends up
   *  with one widget per file you glanced at. */
  openFile: (path: string) => void
}

export function useWidgets(
  session: Session | undefined,
  patch: (next: Partial<Session>) => void,
  /** The floating area — what widget geometry is relative to. */
  hostRect: () => DOMRect | null,
  /** The whole session row, docks included. Dock sizes are capped against this:
   *  the floating area is inset *by* the docks, so using it would shrink the
   *  ceiling as the dock grew and stop it half way. */
  rootRect: () => DOMRect | null
): WidgetApi {
  const widgets = useMemo(() => session?.widgets ?? [], [session?.widgets])

  const write = useCallback(
    (next: WidgetInstance[]) => patch({ widgets: next }),
    [patch]
  )

  const find = useCallback(
    (kind: WidgetKind) => widgets.find((w) => w.kind === kind),
    [widgets]
  )

  const open = useCallback(
    (kind: WidgetKind, opts?: { path?: string; title?: string; show?: boolean }) => {
      const rect = hostRect()
      if (!rect) return
      const meta = WIDGETS[kind]

      // A single-instance widget that already exists is expanded, not duplicated.
      if (!meta.multi) {
        const existing = widgets.find((w) => w.kind === kind)
        if (existing) {
          write(widgets.map((w) => (w.id === existing.id ? { ...w, open: true } : w)))
          return
        }
      }

      const openCount = widgets.filter((w) => w.open).length
      write([
        ...widgets,
        {
          id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind,
          // A widget is born as a bubble unless whoever created it is showing
          // it to you right now. Clicking a rail bubble or opening a file are
          // "show me this"; the add menu is "have one of these", and stacking a
          // panel over the chat for that is the app deciding what you meant.
          open: opts?.show === true,
          geom: defaultGeom(kind, openCount, rect),
          path: opts?.path,
          title: opts?.title
        }
      ])
    },
    [widgets, write, hostRect]
  )

  const close = useCallback(
    (id: string) => write(widgets.filter((w) => w.id !== id)),
    [widgets, write]
  )

  const setOpen = useCallback(
    (id: string, isOpen: boolean) =>
      write(widgets.map((w) => (w.id === id ? { ...w, open: isOpen } : w))),
    [widgets, write]
  )

  const collapse = useCallback((id: string) => setOpen(id, false), [setOpen])
  const expand = useCallback((id: string) => setOpen(id, true), [setOpen])

  const move = useCallback(
    (id: string, geom: WidgetGeom) => {
      const rect = hostRect()
      write(
        widgets.map((w) => (w.id === id ? { ...w, geom: rect ? clampGeom(geom, rect) : geom } : w))
      )
    },
    [widgets, write, hostRect]
  )

  /**
   * Show a file.
   *
   * Reuses the editor that is already up. Opening a fresh widget per click would
   * turn "look through this folder" into a screen full of overlapping panels,
   * and the navigator is exactly the tool that invites clicking around.
   */
  const openFile = useCallback(
    (path: string) => {
      const editor = widgets.find((w) => w.kind === 'editor')
      if (editor) {
        write(widgets.map((w) => (w.id === editor.id ? { ...w, path, open: true } : w)))
        return
      }
      open('editor', { path, show: true })
    },
    [widgets, write, open]
  )

  /**
   * Snap to an edge.
   *
   * The floating geometry is stashed rather than overwritten, because undocking
   * should put the widget back exactly where it was — a docked panel has no
   * position of its own to return to, so without this it would reappear in a
   * default slot every time.
   */
  const dock = useCallback(
    (id: string, side: DockSide) => {
      write(
        widgets.map((w) =>
          w.id === id ? { ...w, dock: side, open: true, floatGeom: w.floatGeom ?? w.geom } : w
        )
      )
    },
    [widgets, write]
  )

  const openDocked = useCallback(
    (kind: WidgetKind, side: DockSide) => {
      const existing = widgets.find((w) => w.kind === kind)
      if (existing && !WIDGETS[kind].multi) {
        write(widgets.map((w) => (w.id === existing.id ? { ...w, dock: side, open: true } : w)))
        return
      }
      const rect = hostRect()
      write([
        ...widgets,
        {
          id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind,
          open: true,
          dock: side,
          // Kept so popping it out later has somewhere to go, even though it has
          // never floated.
          floatGeom: rect ? defaultGeom(kind, widgets.filter((w) => w.open).length, rect) : undefined
        }
      ])
    },
    [widgets, write, hostRect]
  )

  const undock = useCallback(
    (id: string) => {
      write(
        widgets.map((w) =>
          w.id === id
            ? { ...w, dock: undefined, geom: w.floatGeom ?? w.geom, floatGeom: undefined }
            : w
        )
      )
    },
    [widgets, write]
  )

  const dockSizes = useMemo(
    () => ({
      left: session?.dockSizes?.left ?? DEFAULT_DOCK,
      right: session?.dockSizes?.right ?? DEFAULT_DOCK,
      bottom: session?.dockSizes?.bottom ?? DEFAULT_DOCK_H
    }),
    [session?.dockSizes]
  )

  const setDockSize = useCallback(
    (side: DockSide, px: number) => {
      const rect = rootRect()
      // Never let a dock eat the whole window: the chat has to stay usable, and
      // an edge dragged past the far side would be unrecoverable by pointer.
      const room = side === 'bottom' ? (rect?.height ?? 900) - 260 : (rect?.width ?? 1200) - 320
      const min = side === 'bottom' ? MIN_DOCK_H : MIN_DOCK
      patch({
        dockSizes: { ...session?.dockSizes, [side]: Math.min(Math.max(min, px), Math.max(min, room)) }
      })
    },
    [patch, session?.dockSizes, rootRect]
  )

  return {
    widgets,
    find,
    open,
    close,
    collapse,
    expand,
    move,
    openFile,
    dock,
    openDocked,
    undock,
    dockSizes,
    setDockSize
  }
}
