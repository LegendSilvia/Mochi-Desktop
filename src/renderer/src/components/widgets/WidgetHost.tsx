import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { UIMessage } from 'ai'
import type { AgentLoadout, Session, StickerRule, WidgetInstance, WidgetKind } from '@shared/types'
import { PANEL_KINDS, TOOL_KINDS, WIDGETS, clampGeom, defaultGeom } from './registry'
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
}

/**
 * Every floating panel over the chat, plus the rail of bubbles they collapse to.
 *
 * The rail is the whole navigation model: a widget is either a circle in the
 * top-right corner or an open panel, and the circle only exists when the widget
 * has something to show. That is what keeps a fresh session from opening with
 * eleven icons for things that are all empty.
 */
export function WidgetHost(ctx: WidgetContext): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [adding, setAdding] = useState(false)
  /** Stacking order, most recently touched last. Not persisted — which panel is
   *  on top is a property of the last few seconds, not of the session. */
  const [order, setOrder] = useState<string[]>([])
  /** Live PTY per terminal widget. Kept here rather than in TerminalPane so a
   *  collapsed terminal keeps its shell: the pane unmounts, this does not. */
  const [ptys, setPtys] = useState<Record<string, string | null>>({})

  /** The chat's own box, tracked rather than read during render — a ref read
   *  while rendering is exactly the stale value that would place a widget
   *  against the previous window size. ResizeObserver delivers its first
   *  callback on observe, so this needs no synchronous seed. */
  const [host, setHost] = useState<DOMRect | null>(null)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHost(el.getBoundingClientRect()))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rect = useCallback(() => hostRef.current?.getBoundingClientRect() ?? null, [])
  const api = useWidgets(ctx.session, ctx.patch, rect)
  const folder = ctx.session.workspacePath

  const raise = useCallback((id: string) => {
    setOrder((cur) => (cur[cur.length - 1] === id ? cur : [...cur.filter((x) => x !== id), id]))
  }, [])

  // Close the add menu on any click elsewhere, the same way the rail's own
  // buttons behave.
  useEffect(() => {
    if (!adding) return
    const close = (): void => setAdding(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [adding])

  /**
   * Which panel widgets have anything to say.
   *
   * Computed rather than stored: "has this session touched a file yet" is a
   * property of the transcript, and caching it would only create a second answer
   * that could disagree with the first.
   */
  const hasData = useMemo((): Record<WidgetKind, boolean> => {
    const activity = foldedActivity(ctx.messages).length > 0
    return {
      agents: ctx.subagents.length > 0,
      activity,
      files: touchedFiles(ctx.messages).length > 0,
      rules: ctx.rules.some((r) => r.enabled),
      // Always worth reaching: it is the answer to "what is it allowed to do
      // here", which matters most before anything has happened.
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
   * offering, and requiring a trip through the add menu to discover that would
   * hide them behind a plus sign.
   *
   * The editor is the exception: it is only ever opened by something else
   * handing it a file, so it earns a bubble by having one rather than by the
   * folder existing.
   *
   * Widgets that already exist take their kind's place in the order, so a
   * collapsed terminal reopens where it collapsed from rather than jumping to
   * the end of the rail.
   */
  const bubbles = useMemo(() => {
    const out: Array<{ key: string; kind: WidgetKind; instance?: WidgetInstance }> = []
    for (const kind of [...TOOL_KINDS, ...PANEL_KINDS]) {
      const mine = api.widgets.filter((w) => w.kind === kind)
      for (const w of mine) if (!w.open) out.push({ key: w.id, kind, instance: w })
      // A kind with no instance at all still gets one bubble, so long as it is
      // usable. Clicking it is what creates the widget.
      if (mine.length === 0 && hasData[kind] && kind !== 'editor') {
        out.push({ key: kind, kind })
      }
    }
    return out
  }, [api.widgets, hasData])

  const openWidgets = api.widgets.filter((w) => w.open)

  const paneFor = (w: WidgetInstance): React.ReactNode => {
    switch (w.kind) {
      case 'navigator':
        return folder ? (
          <NavigatorPane key={folder} folder={folder} onOpenFile={api.openFile} />
        ) : (
          <NoFolder />
        )
      case 'editor':
        return folder ? <EditorPane key={`${folder}:${w.path ?? ''}`} folder={folder} path={w.path} /> : <NoFolder />
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

  return (
    <div className="wg-host" ref={hostRef}>
      {openWidgets.map((w) => {
        const meta = WIDGETS[w.kind]
        const geom = w.geom
          ? host
            ? clampGeom(w.geom, host)
            : w.geom
          : host
            ? defaultGeom(w.kind, 0, host)
            : { x: 40, y: 60, w: meta.size.w, h: meta.size.h }
        const z = 10 + Math.max(0, order.indexOf(w.id))
        return (
          <WidgetFrame
            key={w.id}
            title={w.title ?? meta.label}
            subtitle={w.kind === 'editor' ? w.path : undefined}
            icon={meta.icon}
            geom={geom}
            z={z}
            onGeom={(next) => api.move(w.id, next)}
            onCollapse={() => api.collapse(w.id)}
            onClose={() => {
              // A terminal's shell is a real process; closing the widget has to
              // take it with, or it lingers for the life of the app.
              const pty = ptys[w.id]
              if (pty) void window.mochi?.ptyKill(pty)
              setPtys((p) => {
                const next = { ...p }
                delete next[w.id]
                return next
              })
              api.close(w.id)
            }}
            onFocus={() => raise(w.id)}
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
              title={instance?.title ?? instance?.path ?? meta.label}
              aria-label={`Open ${meta.label}`}
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
  )
}

function NoFolder(): React.JSX.Element {
  return (
    <div className="wg-empty meta">
      No folder set for this session. Use the folder button in the composer.
    </div>
  )
}
