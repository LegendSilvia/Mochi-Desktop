import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus, X, PanelRight, PictureInPicture2 } from 'lucide-react'
import type { UIMessage } from 'ai'
import type {
  AgentLoadout,
  DockSide,
  Session,
  StickerRule,
  WidgetInstance,
  WidgetKind
} from '@shared/types'
import {
  MIN_DOCK,
  MIN_DOCK_H,
  PANEL_KINDS,
  SNAP_EDGE,
  TOOL_KINDS,
  WIDGETS,
  clampGeom,
  defaultGeom
} from './registry'
import { useWidgets } from './useWidgets'
import { WidgetFrame } from './WidgetFrame'
import { NavigatorPane } from './panes/NavigatorPane'
import { EditorPane } from './panes/EditorPane'
import { TerminalPane } from './panes/TerminalPane'
import { SearchPane } from './panes/SearchPane'
import {
  ActivityPane,
  AgentsPane,
  FilesPane,
  PermissionsPane,
  RulesPane,
  SkillsPane,
  TasksPane
} from './panes/PanelPanes'
import { foldedActivity, latestTasks } from './panes/panelData'
import { touchedFiles } from '@renderer/lib/diffStat'

export interface WidgetContext {
  session: Session
  patch: (next: Partial<Session>) => void
  messages: UIMessage[]
  agent: AgentLoadout
  subagents: AgentLoadout[]
  subArt: Record<string, string | null>
  rules: StickerRule[]
  stickerSrc: (id: string | null) => string | null
  onAddAgent: () => void
  /** The chat itself. Passed as children because a docked widget takes real
   *  layout space beside it — the chat has to be a sibling of the docks, not
   *  something they float over. */
  children: React.ReactNode
}

/** A drag in progress, from either a rail bubble or a floating widget's header. */
interface Dragging {
  /** Existing widget being moved, or null when dragging a bubble that has no
   *  widget yet — the bubble creates one on drop. */
  id: string | null
  kind: WidgetKind
  side: DockSide | null
}

/**
 * Every floating panel over the chat, the columns they snap into, and the rail
 * of bubbles they collapse to.
 *
 * A widget is in one of three states: a bubble in the rail, a panel floating
 * over the chat, or docked to an edge. Docking is the one that changes the
 * layout — a docked widget is a real sibling of the chat and the chat gives up
 * the space, rather than having a panel sit on top of it.
 */
export function WidgetHost(ctx: WidgetContext): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  /** The whole session row, docks included. Dock sizes must be measured against
   *  this and never against `hostRef` — the float layer is inset *by* the docks,
   *  so using it as the basis makes a seam drag chase its own tail. */
  const rootRef = useRef<HTMLDivElement>(null)
  const [adding, setAdding] = useState(false)
  /** Stacking order, most recently touched last. Not persisted — which panel is
   *  on top is a property of the last few seconds, not of the session. */
  const [order, setOrder] = useState<string[]>([])
  /** Live PTY per terminal widget. Kept here rather than in TerminalPane so a
   *  collapsed terminal keeps its shell: the pane unmounts, this does not. */
  const [ptys, setPtys] = useState<Record<string, string | null>>({})
  const [drag, setDrag] = useState<Dragging | null>(null)
  /** Which tab is showing in each dock slot, keyed by `side:slot`. */
  const [activeTab, setActiveTab] = useState<Record<string, string>>({})

  /** The chat area's box, tracked rather than read during render — a ref read
   *  while rendering is the stale value that would place a widget against the
   *  previous window size. ResizeObserver fires on observe, so no seed needed. */
  const [host, setHost] = useState<DOMRect | null>(null)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHost(el.getBoundingClientRect()))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** Read inside `zoneAt`, which must not be rebuilt mid-drag — the drag closure
   *  captured it at pointerdown. */
  const docksRef = useRef<Record<DockSide, boolean>>({ left: false, right: false, bottom: false })
  const dockSizeRef = useRef<Record<DockSide, number>>({ left: 0, right: 0, bottom: 0 })

  const rect = useCallback(() => hostRef.current?.getBoundingClientRect() ?? null, [])
  const rootRect = useCallback(() => rootRef.current?.getBoundingClientRect() ?? null, [])
  const api = useWidgets(ctx.session, ctx.patch, rect, rootRect)
  const folder = ctx.session.workspacePath

  const raise = useCallback((id: string) => {
    setOrder((cur) => (cur[cur.length - 1] === id ? cur : [...cur.filter((x) => x !== id), id]))
  }, [])

  useEffect(() => {
    if (!adding) return
    const close = (): void => setAdding(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [adding])

  /**
   * Which edge a pointer is offering to snap to.
   *
   * Nearest edge within the threshold, rather than checking each in turn — in a
   * corner both are in range, and a fixed order would make one of them
   * unreachable.
   */
  const zoneAt = useCallback((clientX: number, clientY: number): DockSide | null => {
    // Against the session row, not the float layer. The float layer is inset by
    // whatever is already docked, so dragging to the *actual* right edge — over
    // an existing right dock, which is exactly where you aim to join it — landed
    // hundreds of pixels outside it and registered no zone at all.
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return null
    const d: Array<[DockSide, number]> = [
      ['left', clientX - r.left],
      ['right', r.right - clientX],
      ['bottom', r.bottom - clientY]
    ]
    const [side, dist] = d.reduce((a, b) => (b[1] < a[1] ? b : a))
    // A dock already occupying that edge is a valid target — you are dropping
    // *into* it — so the band extends inward across its whole width rather than
    // stopping at the chat's edge.
    const band = docksRef.current[side] ? Math.max(SNAP_EDGE, dockSizeRef.current[side]) : SNAP_EDGE
    return dist <= band && dist >= -8 ? side : null
  }, [])

  const hasData = useMemo((): Record<WidgetKind, boolean> => {
    return {
      agents: ctx.subagents.length > 0,
      activity: foldedActivity(ctx.messages).length > 0,
      files: touchedFiles(ctx.messages).length > 0,
      rules: ctx.rules.some((r) => r.enabled),
      // Always worth reaching: it answers "what is it allowed to do here", which
      // matters most before anything has happened.
      permissions: true,
      tasks: latestTasks(ctx.messages).length > 0,
      navigator: Boolean(folder),
      editor: Boolean(folder),
      terminal: true,
      search: Boolean(folder),
      skills: Boolean(folder)
    }
  }, [ctx.messages, ctx.subagents, ctx.rules, folder])

  /**
   * The rail.
   *
   * A bubble appears when the widget has something to show *or* is ready to be
   * used — a folder being set is what makes the navigator and search worth
   * offering, and hiding that behind a plus sign would make them undiscoverable.
   *
   * The editor is the exception: it is only ever opened by something handing it
   * a file, so it earns a bubble by having one rather than by a folder existing.
   */
  const bubbles = useMemo(() => {
    const out: Array<{ key: string; kind: WidgetKind; instance?: WidgetInstance }> = []
    for (const kind of [...TOOL_KINDS, ...PANEL_KINDS]) {
      const mine = api.widgets.filter((w) => w.kind === kind)
      for (const w of mine) if (!w.open) out.push({ key: w.id, kind, instance: w })
      if (mine.length === 0 && hasData[kind] && kind !== 'editor') out.push({ key: kind, kind })
    }
    return out
  }, [api.widgets, hasData])

  const docked = useMemo(
    () => ({
      left: api.widgets.filter((w) => w.open && w.dock === 'left'),
      right: api.widgets.filter((w) => w.open && w.dock === 'right'),
      bottom: api.widgets.filter((w) => w.open && w.dock === 'bottom')
    }),
    [api.widgets]
  )
  const floating = api.widgets.filter((w) => w.open && !w.dock)

  useEffect(() => {
    docksRef.current = {
      left: docked.left.length > 0,
      right: docked.right.length > 0,
      bottom: docked.bottom.length > 0
    }
    dockSizeRef.current = api.dockSizes
  }, [docked, api.dockSizes])

  const paneFor = (w: WidgetInstance): React.ReactNode => {
    switch (w.kind) {
      case 'navigator':
        return folder ? (
          <NavigatorPane key={folder} folder={folder} onOpenFile={api.openFile} />
        ) : (
          <NoFolder />
        )
      case 'editor':
        return folder ? (
          <EditorPane key={`${folder}:${w.path ?? ''}`} folder={folder} path={w.path} />
        ) : (
          <NoFolder />
        )
      case 'terminal':
        return (
          <TerminalPane
            cwd={folder ?? ''}
            ptyId={ptys[w.id] ?? null}
            onPty={(id) => setPtys((p) => ({ ...p, [w.id]: id }))}
          />
        )
      case 'search':
        return folder ? <SearchPane folder={folder} /> : <NoFolder />
      case 'skills':
        return folder ? <SkillsPane folder={folder} /> : <NoFolder />
      case 'tasks':
        return <TasksPane messages={ctx.messages} />
      case 'activity':
        return <ActivityPane messages={ctx.messages} />
      case 'files':
        return <FilesPane messages={ctx.messages} onOpenFile={folder ? api.openFile : undefined} />
      case 'agents':
        return (
          <AgentsPane
            subagents={ctx.subagents}
            subArt={ctx.subArt}
            agentName={ctx.agent.name}
            onAdd={ctx.onAddAgent}
          />
        )
      case 'rules':
        return <RulesPane rules={ctx.rules} stickerSrc={ctx.stickerSrc} />
      case 'permissions':
        return <PermissionsPane canPush={Boolean(ctx.agent.canPushWithoutAsking)} folder={folder} />
      default:
        return null
    }
  }

  /** Close a widget, taking its shell with it — a terminal's process is real and
   *  would otherwise outlive the panel for the life of the app. */
  const closeWidget = (id: string): void => {
    const pty = ptys[id]
    if (pty) void window.mochi?.ptyKill(pty)
    setPtys((p) => {
      const next = { ...p }
      delete next[id]
      return next
    })
    api.close(id)
  }

  const dockActions = (w: WidgetInstance): React.ReactNode => (
    <>
      <button
        className="wg-btn"
        title={w.dock ? 'Pop out' : 'Snap to the right'}
        aria-label={w.dock ? 'Pop out' : 'Snap to the right'}
        onClick={() => (w.dock ? api.undock(w.id) : api.dock(w.id, 'right'))}
      >
        {w.dock ? (
          <PictureInPicture2 size={13} strokeWidth={1.9} />
        ) : (
          <PanelRight size={13} strokeWidth={1.9} />
        )}
      </button>
    </>
  )

  /**
   * One docked edge.
   *
   * An edge holds two slots, not one. Snapping a second widget beside the first
   * is the point of docking — a navigator over an editor, or a terminal beside
   * a task list — so the second widget splits the space rather than replacing
   * the first or being buried.
   *
   * Past two, extra widgets become tabs in the second slot. Splitting a column
   * three ways leaves three unusable slivers, and a tab is the honest way to
   * say "this is here, but not right now".
   */
  const renderDock = (side: DockSide): React.JSX.Element | null => {
    const list = docked[side]
    if (list.length === 0) return null
    const size = api.dockSizes[side]
    const groups: WidgetInstance[][] =
      list.length <= 2 ? list.map((w) => [w]) : [[list[0]], list.slice(1)]

    return (
      <aside
        className="wg-dock"
        data-side={side}
        style={side === 'bottom' ? { height: size } : { width: size }}
      >
        <DockGrip side={side} onSize={(px) => api.setDockSize(side, px)} rootRef={rootRef} />
        {groups.map((group, gi) => {
          const key = `${side}:${gi}`
          // Falls back to the first rather than storing a default, so closing the
          // active tab cannot leave the slot pointing at a widget that is gone.
          const active = group.find((w) => w.id === activeTab[key]) ?? group[0]
          const meta = WIDGETS[active.kind]
          const Icon = meta.icon
          return (
            <section className="wg wg-docked" key={key}>
              {/* A tab already names the widget, so a tabbed slot gets one row:
                  tabs, then the actions. Keeping the separate header underneath
                  meant reading "Search" twice, one line apart. */}
              {group.length > 1 ? (
                <div className="wg-tabs" role="tablist">
                  {group.map((w) => {
                    const tabMeta = WIDGETS[w.kind]
                    const TabIcon = tabMeta.icon
                    return (
                      <button
                        key={w.id}
                        role="tab"
                        className="wg-tab"
                        aria-selected={w.id === active.id}
                        onClick={() => setActiveTab((t) => ({ ...t, [key]: w.id }))}
                        title={w.path ?? tabMeta.label}
                      >
                        <TabIcon size={12} strokeWidth={1.9} />
                        <span className="wg-tab-label">
                          {w.kind === 'editor' && w.path ? baseName(w.path) : tabMeta.label}
                        </span>
                        <span
                          className="wg-tab-x"
                          role="button"
                          aria-label={`Close ${tabMeta.label}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            closeWidget(w.id)
                          }}
                        >
                          <X size={11} strokeWidth={2.2} />
                        </span>
                      </button>
                    )
                  })}
                  <span className="wg-spacer" />
                  <div className="wg-actions">
                    {dockActions(active)}
                    <button
                      className="wg-btn"
                      onClick={() => api.collapse(active.id)}
                      aria-label={`Collapse ${meta.label}`}
                      title="Collapse to a bubble"
                    >
                      <Minus size={13} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="wg-head">
                  <Icon size={13} strokeWidth={1.9} className="wg-head-icon" />
                  <span className="wg-title">{active.title ?? meta.label}</span>
                  {active.kind === 'editor' && active.path && (
                    <span className="wg-sub mono" title={active.path}>
                      {active.path}
                    </span>
                  )}
                  <span className="wg-spacer" />
                  <div className="wg-actions">
                    {dockActions(active)}
                    <button
                      className="wg-btn"
                      onClick={() => api.collapse(active.id)}
                      aria-label={`Collapse ${meta.label}`}
                      title="Collapse to a bubble"
                    >
                      <Minus size={13} strokeWidth={2} />
                    </button>
                    <button
                      className="wg-btn"
                      onClick={() => closeWidget(active.id)}
                      aria-label={`Close ${meta.label}`}
                      title="Close"
                    >
                      <X size={13} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              )}

              {/* Every widget in the group stays mounted; only the active one is
                  shown. Unmounting an inactive tab would kill a terminal's view
                  and lose an editor's unsaved buffer just by looking elsewhere. */}
              {group.map((w) => (
                <div className="wg-body" key={w.id} hidden={w.id !== active.id}>
                  {paneFor(w)}
                </div>
              ))}
            </section>
          )
        })}
      </aside>
    )
  }

  /** The exact box a drop on this edge would occupy. */
  const snapStyle = (side: DockSide): React.CSSProperties => {
    const l = docked.left.length ? api.dockSizes.left : 0
    const r = docked.right.length ? api.dockSizes.right : 0
    const b = docked.bottom.length ? api.dockSizes.bottom : 0
    if (side === 'left') return { left: 0, top: 0, bottom: 0, width: api.dockSizes.left }
    if (side === 'right') return { right: 0, top: 0, bottom: 0, width: api.dockSizes.right }
    return { left: l, right: r, bottom: 0, height: docked.bottom.length ? b : api.dockSizes.bottom }
  }

  /** What dropping here will do — joining a busy edge is not the same as
   *  claiming an empty one, and the difference is worth one word. */
  const snapLabel = (side: DockSide): string => {
    const n = docked[side].length
    if (n === 0) return 'Snap'
    if (n === 1) return 'Split'
    return 'Add as tab'
  }

  /** Drag a bubble, or a floating header, onto an edge. */
  const beginDrag = (kind: WidgetKind, id: string | null) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    let armed = false

    const onMove = (ev: PointerEvent): void => {
      // A few pixels of slop so a click on a bubble stays a click.
      if (!armed && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return
      armed = true
      setDrag({ id, kind, side: zoneAt(ev.clientX, ev.clientY) })
    }
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!armed) {
        setDrag(null)
        return
      }
      const side = zoneAt(ev.clientX, ev.clientY)
      setDrag(null)
      if (!side) return
      if (id) api.dock(id, side)
      else api.openDocked(kind, side)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="session" ref={rootRef}>
      {renderDock('left')}
      <div className="session-center">
        {ctx.children}
        {renderDock('bottom')}
      </div>
      {renderDock('right')}

      {/* Where it would actually land.
          Positioned against the session, not the float layer: the float layer is
          inset by whatever is already docked, so a preview drawn inside it
          pointed at empty chat instead of the column the widget was about to
          join. The rectangle is the real target geometry, and the corner says
          what dropping there will do. */}
      {drag?.side && (
        <div className="wg-snap" data-side={drag.side} style={snapStyle(drag.side)}>
          <span className="wg-snap-tag">{snapLabel(drag.side)}</span>
        </div>
      )}

      {/* Covers the chat column only. The docks are real siblings that took
          their space out of the row, so an `inset: 0` layer would float widgets
          and the rail over them. */}
      <div
        className="wg-host"
        ref={hostRef}
        // While something is being dragged the layer stops clipping and rises
        // above the docks — otherwise a panel dragged toward a docked edge is
        // sliced off at the boundary of its own container, which is precisely
        // the direction you drag when you mean to snap it there.
        data-dragging={drag ? 'true' : undefined}
        style={{
          left: docked.left.length ? api.dockSizes.left : 0,
          right: docked.right.length ? api.dockSizes.right : 0,
          bottom: docked.bottom.length ? api.dockSizes.bottom : 0
        }}
      >
        {floating.map((w) => {
          const meta = WIDGETS[w.kind]
          const geom = w.geom
            ? host
              ? clampGeom(w.geom, host)
              : w.geom
            : host
              ? defaultGeom(w.kind, 0, host)
              : { x: 40, y: 60, w: meta.size.w, h: meta.size.h }
          return (
            <WidgetFrame
              key={w.id}
              title={w.title ?? meta.label}
              subtitle={w.kind === 'editor' ? w.path : undefined}
              icon={meta.icon}
              geom={geom}
              /* A widget being dragged clears everything — the other panels,
                 the bubble rail, the snap preview it is being dropped onto.
                 Sliding under the rail mid-drag is disorienting when the rail
                 is exactly what you are dragging away from.
                 
                 Otherwise: most recently touched on top. This was
                 `Math.max(0, indexOf)`, which floored an unfocused widget and
                 the *first* focused one to the same 10 — so clicking the panel
                 underneath did not actually bring it forward. */
              z={
                drag?.id === w.id
                  ? 60
                  : order.indexOf(w.id) === -1
                    ? 10
                    : 11 + order.indexOf(w.id)
              }
              onGeom={(next) => api.move(w.id, next)}
              onCollapse={() => api.collapse(w.id)}
              onClose={() => closeWidget(w.id)}
              onFocus={() => raise(w.id)}
              onDragMove={(x, y) => setDrag({ id: w.id, kind: w.kind, side: zoneAt(x, y) })}
              onDragEnd={(x, y) => {
                const side = zoneAt(x, y)
                setDrag(null)
                // Answered here rather than in onGeom: a drag that ends on an
                // edge is a dock, and committing the floating position first
                // would leave the widget briefly in the wrong place.
                if (side) api.dock(w.id, side)
                return Boolean(side)
              }}
              actions={dockActions(w)}
            >
              {paneFor(w)}
            </WidgetFrame>
          )
        })}

        <div className="wg-rail">
          {bubbles.map(({ key, kind, instance }) => {
            const meta = WIDGETS[kind]
            const Icon = meta.icon
            return (
              <button
                key={key}
                className="wg-bubble"
                data-dragging={drag?.id === (instance?.id ?? null) && drag?.kind === kind}
                title={`${instance?.title ?? instance?.path ?? meta.label} — drag to an edge to snap`}
                aria-label={`Open ${meta.label}`}
                onPointerDown={beginDrag(kind, instance?.id ?? null)}
                onClick={() => {
                  if (instance) api.expand(instance.id)
                  else api.open(kind, { show: true })
                }}
              >
                <Icon size={15} strokeWidth={1.9} />
              </button>
            )
          })}

          <div className="wg-add-wrap">
            <button
              className="wg-bubble wg-bubble-add"
              aria-label="Add a widget"
              title="Add a widget"
              aria-expanded={adding}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setAdding((v) => !v)}
            >
              <Plus size={15} strokeWidth={2.2} />
            </button>
            {adding && (
              <div className="wg-add-menu" onPointerDown={(e) => e.stopPropagation()}>
                {TOOL_KINDS.map((kind) => {
                  const meta = WIDGETS[kind]
                  const Icon = meta.icon
                  const blocked = meta.needsFolder && !folder
                  return (
                    <button
                      key={kind}
                      className="wg-add-item"
                      disabled={blocked}
                      title={blocked ? 'Set a folder first' : undefined}
                      onClick={() => {
                        api.open(kind)
                        setAdding(false)
                      }}
                    >
                      <Icon size={13} strokeWidth={1.9} />
                      {meta.label}
                      {blocked && <span className="meta">needs a folder</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The draggable seam between a docked edge and the chat. */
function DockGrip({
  side,
  onSize,
  rootRef
}: {
  side: DockSide
  onSize: (px: number) => void
  /** The full session row. Measuring against the float layer instead would use
   *  a basis that shrinks as the dock grows — the seam then runs away from the
   *  cursor and oscillates. */
  rootRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const start = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    document.body.classList.add('wg-dragging')
    document.body.style.setProperty(
      '--wg-drag-cursor',
      side === 'bottom' ? 'ns-resize' : 'ew-resize'
    )
    const onMove = (ev: PointerEvent): void => {
      const r = rootRef.current?.getBoundingClientRect()
      if (!r) return
      // Measured from the session's own edge rather than by delta, so the column
      // tracks the pointer exactly even if it hits its minimum and stops.
      const px =
        side === 'left'
          ? ev.clientX - r.left
          : side === 'right'
            ? r.right - ev.clientX
            : r.bottom - ev.clientY
      onSize(Math.max(side === 'bottom' ? MIN_DOCK_H : MIN_DOCK, px))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('wg-dragging')
      document.body.style.removeProperty('--wg-drag-cursor')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  return <div className="wg-dock-grip" data-side={side} onPointerDown={start} />
}

/** Just the file name, for a tab too narrow to hold a path. */
function baseName(path: string): string {
  return path.split('/').pop() || path
}

function NoFolder(): React.JSX.Element {
  return (
    <div className="wg-empty meta">
      No folder set for this session. Use the folder button in the composer.
    </div>
  )
}
