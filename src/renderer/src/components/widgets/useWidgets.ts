import { useCallback, useMemo } from 'react'
import type { Session, WidgetGeom, WidgetInstance, WidgetKind } from '@shared/types'
import { WIDGETS, clampGeom, defaultGeom } from './registry'

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
  /** Point an existing editor at a different file, or open one if none is up.
   *  This is what the navigator calls, and the reason the editor never ends up
   *  with one widget per file you glanced at. */
  openFile: (path: string) => void
}

export function useWidgets(
  session: Session | undefined,
  patch: (next: Partial<Session>) => void,
  hostRect: () => DOMRect | null
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

  return { widgets, find, open, close, collapse, expand, move, openFile }
}
