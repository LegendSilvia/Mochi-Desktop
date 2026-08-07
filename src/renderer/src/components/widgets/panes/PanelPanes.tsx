import type { UIMessage } from 'ai'
import { Plus, Check, Loader2, FileText, BookOpen, Circle, CircleDot } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ArtPlaceholder } from '@renderer/components/ui/Controls'
import { touchedFiles } from '@renderer/lib/diffStat'
import { foldedActivity, latestTasks } from './panelData'
import type { AgentLoadout, StickerRule, WsSkill } from '@shared/types'
import { MODE_HINTS, MODE_LABELS, type PermissionMode } from '@shared/permission-modes'

export function ActivityPane({ messages }: { messages: UIMessage[] }): React.JSX.Element {
  const activity = foldedActivity(messages)
  if (activity.length === 0) return <div className="wg-empty meta">Nothing running.</div>
  return (
    <div className="wg-rows">
      {activity.slice(0, 40).map((a, ai) => (
        <div className="panel-task" key={`${a.name}-${ai}`}>
          {a.done ? (
            <Check size={13} strokeWidth={2.2} className="tool-check" />
          ) : (
            <Loader2 size={13} strokeWidth={2} className="panel-task-spin" />
          )}
          <span className="panel-task-text">
            <span className="panel-task-name">
              {a.name}
              {a.count > 1 && <span className="meta panel-task-count"> ×{a.count}</span>}
            </span>
            {a.detail && <span className="meta mono">{a.detail}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

export function FilesPane({
  messages,
  onOpenFile
}: {
  messages: UIMessage[]
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const touched = touchedFiles(messages)
  if (touched.length === 0) return <div className="wg-empty meta">No files changed yet.</div>
  return (
    <div className="wg-rows">
      {touched.map((f) => (
        <button
          className="panel-file wg-file-row"
          key={f.path}
          onClick={() => onOpenFile?.(f.path)}
          title={onOpenFile ? `Open ${f.path}` : f.path}
        >
          <FileText size={12} strokeWidth={1.8} />
          <span className="mono panel-file-path">{f.path}</span>
          <span className="tool-stat mono">
            {f.added > 0 && <span className="tool-plus">+{f.added}</span>}
            {f.removed > 0 && <span className="tool-minus">−{f.removed}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

export function AgentsPane({
  subagents,
  subArt,
  agentName,
  onAdd
}: {
  subagents: AgentLoadout[]
  subArt: Record<string, string | null>
  agentName: string
  onAdd: () => void
}): React.JSX.Element {
  return (
    <div className="wg-rows">
      <button className="panel-link wg-add-agent" onClick={onAdd}>
        <Plus size={11} strokeWidth={2} /> @agent
      </button>
      {subagents.length === 0 && (
        <div className="wg-empty meta">Just {agentName}. Add another with @agent.</div>
      )}
      {subagents.map((sub) => {
        const art = subArt[sub.spritePreset]
        return (
          <div className="panel-agent" key={sub.id}>
            {art ? (
              <img className="mention-avatar-img" src={art} alt="" draggable={false} />
            ) : (
              <span className="mention-avatar">{sub.name[0]}</span>
            )}
            <span className="panel-agent-text">
              <span className="panel-agent-name">{sub.name}</span>
              <span className="meta">subagent · memory isolated</span>
            </span>
            <span className="dot-warm" />
          </div>
        )
      })}
      <div className="panel-foot meta">max delegation steps · 10</div>
    </div>
  )
}

export function RulesPane({
  rules,
  stickerSrc
}: {
  rules: StickerRule[]
  stickerSrc: (id: string | null) => string | null
}): React.JSX.Element {
  const armed = rules.filter((r) => r.enabled)
  if (armed.length === 0) return <div className="wg-empty meta">No rules armed.</div>
  return (
    <div className="wg-rows">
      {armed.map((r) => (
        <div className="panel-rule" key={r.id}>
          <div className="panel-rule-thumb">
            {stickerSrc(r.stickerId) ? (
              <img src={stickerSrc(r.stickerId) as string} alt="" />
            ) : (
              <ArtPlaceholder size={26} />
            )}
          </div>
          <span className="panel-rule-name">{r.when}</span>
          <span className="mono panel-rule-meta">
            {r.soundId ?? '—'} · {r.showAs}
          </span>
          <span className="dot-accent" />
        </div>
      ))}
    </div>
  )
}

export function PermissionsPane({
  canPush,
  folder,
  mode
}: {
  canPush: boolean
  folder?: string
  mode: PermissionMode
}): React.JSX.Element {
  return (
    <div className="wg-rows">
      <div className="rag-row">
        <span className="mono">{MODE_LABELS[mode]}</span>
        <span className="meta">{MODE_HINTS[mode]}</span>
      </div>
      <div className="panel-chips">
        <span className="chip">read</span>
        <span className="chip">write</span>
        <span className="chip">run tests</span>
        <span className="chip">commit</span>
        <span className="chip forbidden">merge</span>
        <span className="chip forbidden">.env</span>
      </div>
      {!canPush && <div className="meta">Pushing to git always asks first.</div>}
      {folder ? (
        <div className="meta mono wg-perm-path" title={folder}>
          {folder}
        </div>
      ) : (
        <div className="meta">No folder set — the agent cannot reach your files.</div>
      )}
    </div>
  )
}

/**
 * The agent's plan.
 *
 * Read off the newest `task_write` call rather than kept in state: that tool
 * takes the *whole* list every time, so the last one to run is the current plan
 * by definition, and there is nothing to reconcile.
 *
 * This is the widget that was missing when the agent first started writing todo
 * lists nobody could see.
 */
export function TasksPane({ messages }: { messages: UIMessage[] }): React.JSX.Element {
  const tasks = latestTasks(messages)
  if (tasks.length === 0) return <div className="wg-empty meta">No plan yet.</div>
  return (
    <div className="wg-rows">
      {tasks.map((t, i) => (
        <div className="wg-task" key={t.id ?? i} data-status={t.status}>
          {t.status === 'completed' ? (
            <Check size={13} strokeWidth={2.4} className="tool-check" />
          ) : t.status === 'in_progress' ? (
            <CircleDot size={13} strokeWidth={2} className="wg-task-now" />
          ) : (
            <Circle size={13} strokeWidth={1.8} className="wg-task-todo" />
          )}
          <span className="wg-task-text">
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </span>
        </div>
      ))}
    </div>
  )
}

export function SkillsPane({ folder }: { folder: string }): React.JSX.Element {
  const [skills, setSkills] = useState<WsSkill[] | null>(null)
  useEffect(() => {
    void window.mochi?.wsSkills(folder).then((s) => setSkills(s ?? []))
  }, [folder])

  if (skills === null) return <div className="wg-empty meta">Looking for skills…</div>
  if (skills.length === 0) {
    return (
      <div className="wg-empty meta">
        No SKILL.md folders here. Mochi looks in <span className="mono">.claude/skills</span> and{' '}
        <span className="mono">skills</span>.
      </div>
    )
  }
  return (
    <div className="wg-rows">
      {skills.map((s) => (
        <div className="wg-skill" key={s.path}>
          <BookOpen size={13} strokeWidth={1.8} className="ic-code" />
          <span className="wg-skill-text">
            <span className="wg-skill-name">{s.name}</span>
            {s.description && <span className="meta">{s.description}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}
