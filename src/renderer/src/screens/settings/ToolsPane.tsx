import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { Row, ScreenHeader, Toggle } from '@renderer/components/ui/Controls'
import type { McpServerSpec } from '@shared/types'

/**
 * Tools & MCP.
 *
 * Both of these widen what the agent can reach, so both are off until asked
 * for and both say plainly what they turn on. Servers are stored but only
 * handed to the agent when enabled, which makes it possible to keep one
 * configured and switch it off without losing the settings.
 */
export function ToolsPane(): React.JSX.Element {
  const { settings, dispatch } = useStore()
  const [draft, setDraft] = useState<McpServerSpec | null>(null)

  const servers = settings.mcpServers ?? []
  const skills = settings.skills ?? { enabled: false, allow: 'all' as const }

  const setServers = (next: McpServerSpec[]): void =>
    dispatch({ type: 'settings', patch: { mcpServers: next } })

  const blank = (): McpServerSpec => ({
    id: `mcp-${Date.now().toString(36)}`,
    name: '',
    type: 'http',
    url: '',
    enabled: true
  })

  const usable = (s: McpServerSpec): boolean =>
    Boolean(s.name.trim()) && (s.type === 'http' ? Boolean(s.url?.trim()) : Boolean(s.command?.trim()))

  return (
    <>
      <ScreenHeader
        title="Tools & MCP"
        subtitle="Extra capabilities for agents running on your Claude subscription."
      />
      <div className="screen-body pane-cols">
        <div className="pane-col">
          <section className="config-card">
            <div className="panel-head">
              <span className="section-label">MCP servers</span>
              <button className="panel-link" onClick={() => setDraft(blank())}>
                <Plus size={11} strokeWidth={2} /> add
              </button>
            </div>

            {servers.length === 0 && !draft && (
              <span className="meta">
                None yet. An MCP server gives the agent a set of tools — a GitHub
                connector, a database, your own service.
              </span>
            )}

            {servers.map((s) => (
              <div className="mcp-row" key={s.id}>
                <Toggle
                  dense
                  on={s.enabled}
                  onChange={(v) =>
                    setServers(servers.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)))
                  }
                  label={`Enable ${s.name}`}
                />
                <span className="mcp-text">
                  <span className="mcp-name">{s.name}</span>
                  <span className="meta mono">{s.type === 'http' ? s.url : s.command}</span>
                </span>
                <button
                  className="loadout-act danger"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => setServers(servers.filter((x) => x.id !== s.id))}
                >
                  <Trash2 size={13} strokeWidth={1.8} />
                </button>
              </div>
            ))}

            {draft && (
              <div className="mcp-draft">
                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    className="field-input mono"
                    autoFocus
                    placeholder="github"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Transport</span>
                  <select
                    className="cell-select"
                    value={draft.type}
                    onChange={(e) =>
                      setDraft({ ...draft, type: e.target.value as McpServerSpec['type'] })
                    }
                  >
                    <option value="http">http — a URL</option>
                    <option value="stdio">stdio — a local command</option>
                  </select>
                </label>
                {draft.type === 'http' ? (
                  <label className="field">
                    <span className="field-label">URL</span>
                    <input
                      className="field-input mono"
                      placeholder="https://example.com/mcp"
                      value={draft.url ?? ''}
                      onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    />
                  </label>
                ) : (
                  <label className="field">
                    <span className="field-label">Command</span>
                    <input
                      className="field-input mono"
                      placeholder="npx -y @scope/server"
                      value={draft.command ?? ''}
                      onChange={(e) => {
                        const [command, ...args] = e.target.value.split(' ').filter(Boolean)
                        setDraft({ ...draft, command, args })
                      }}
                    />
                  </label>
                )}
                <div className="pills">
                  <button
                    className="pill-primary"
                    disabled={!usable(draft)}
                    onClick={() => {
                      setServers([...servers, draft])
                      setDraft(null)
                    }}
                  >
                    Add
                  </button>
                  <button className="pill-ghost" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="pane-col">
          <section className="config-card">
            <span className="section-label">Agent Skills</span>
            <Row
              label="Let agents use skills"
              hint="skills are folders of instructions the agent loads when relevant"
            >
              <Toggle
                dense
                on={skills.enabled}
                onChange={(v) =>
                  dispatch({ type: 'settings', patch: { skills: { ...skills, enabled: v } } })
                }
                label="Enable skills"
              />
            </Row>
            <p className="meta">
              Reads skills from this project&apos;s <span className="mono">.agents/skills</span> and
              your Claude Code install. Off by default, because turning it on widens what the agent
              can reach without saying so.
            </p>
            {skills.enabled && (
              <label className="field">
                <span className="field-label">Which skills</span>
                <input
                  className="field-input mono"
                  placeholder="all, or: mastra, pdf, docx"
                  value={skills.allow === 'all' ? 'all' : skills.allow.join(', ')}
                  onChange={(e) => {
                    const raw = e.target.value.trim()
                    const allow =
                      raw === '' || raw === 'all'
                        ? ('all' as const)
                        : raw.split(',').map((s) => s.trim()).filter(Boolean)
                    dispatch({ type: 'settings', patch: { skills: { ...skills, allow } } })
                  }}
                />
                <span className="meta">Comma-separated names, or “all”.</span>
              </label>
            )}
          </section>
        </div>
      </div>
    </>
  )
}
