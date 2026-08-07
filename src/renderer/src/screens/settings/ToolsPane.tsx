import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { Row, ScreenHeader, Toggle } from '@renderer/components/ui/Controls'
import { formatCommand, mcpNameError, mcpSecretKey, parseCommand } from '@shared/mcp'
import type { McpServerSpec } from '@shared/types'

/** A credential typed into the draft form, held here until the server is added
 *  — a value written to the store for a server the user then cancels would be
 *  a secret on disk that nothing points at. */
interface DraftSecret {
  name: string
  value: string
}

/**
 * Tools & MCP.
 *
 * Both of these widen what the agent can reach, so both are off until asked
 * for and both say plainly what they turn on. Servers are stored but only
 * handed to the agent when enabled, which makes it possible to keep one
 * configured and switch it off without losing the settings.
 *
 * Header and environment *values* never live in this pane. They are written
 * straight to the main process, which keeps them in the same encrypted store as
 * the provider keys; what comes back is only the list of slots that have
 * something in them.
 */
export function ToolsPane(): React.JSX.Element {
  const { settings, dispatch } = useStore()
  const [draft, setDraft] = useState<McpServerSpec | null>(null)
  const [draftSecrets, setDraftSecrets] = useState<DraftSecret[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  /** Keys of every stored credential, so a slot can be shown as set. */
  const [stored, setStored] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  const servers = settings.mcpServers ?? []
  const skills = settings.skills ?? { enabled: false, allow: 'all' as const }

  const refreshSecrets = (): void => {
    void window.mochi?.mcpSecretNames().then(setStored)
  }
  useEffect(refreshSecrets, [])

  const setServers = (next: McpServerSpec[]): void =>
    dispatch({ type: 'settings', patch: { mcpServers: next } })

  const patchServer = (id: string, patch: Partial<McpServerSpec>): void =>
    setServers(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const blank = (): McpServerSpec => ({
    id: `mcp-${Date.now().toString(36)}`,
    name: '',
    type: 'http',
    url: '',
    enabled: true
  })

  const removeServer = (server: McpServerSpec): void => {
    setServers(servers.filter((x) => x.id !== server.id))
    // Otherwise the credentials outlive the server that used them.
    void window.mochi?.mcpForgetServer(server.id).then(refreshSecrets)
    if (expanded === server.id) setExpanded(null)
  }

  /** The slot list for a server: header names on http, env names on stdio. */
  const slotOf = (server: McpServerSpec): 'header' | 'env' =>
    server.type === 'http' ? 'header' : 'env'
  const slotNames = (server: McpServerSpec): string[] =>
    (server.type === 'http' ? server.headers : server.env) ?? []

  const setSlotNames = (server: McpServerSpec, names: string[]): void =>
    patchServer(server.id, server.type === 'http' ? { headers: names } : { env: names })

  const addSecret = async (server: McpServerSpec, name: string, value: string): Promise<void> => {
    const key = mcpSecretKey(server.id, slotOf(server), name)
    const res = await window.mochi?.mcpSetSecret(key, value)
    if (res && !res.ok) {
      setProblem(res.reason ?? 'Could not save the value.')
      return
    }
    setProblem(null)
    if (!slotNames(server).includes(name)) setSlotNames(server, [...slotNames(server), name])
    refreshSecrets()
  }

  const removeSecret = (server: McpServerSpec, name: string): void => {
    setSlotNames(
      server,
      slotNames(server).filter((n) => n !== name)
    )
    void window.mochi
      ?.mcpDeleteSecret(mcpSecretKey(server.id, slotOf(server), name))
      .then(refreshSecrets)
  }

  const draftError = draft ? mcpNameError(draft.name, otherNames(servers, draft.id)) : null
  const usable = (s: McpServerSpec): boolean =>
    !mcpNameError(s.name, otherNames(servers, s.id)) &&
    (s.type === 'http' ? Boolean(s.url?.trim()) : Boolean(s.command?.trim()))

  const commitDraft = async (): Promise<void> => {
    if (!draft) return
    const named = draftSecrets.filter((s) => s.name.trim() && s.value)
    const slot = slotOf(draft)
    for (const s of named) {
      const res = await window.mochi?.mcpSetSecret(
        mcpSecretKey(draft.id, slot, s.name.trim()),
        s.value
      )
      if (res && !res.ok) {
        setProblem(res.reason ?? 'Could not save the value.')
        return
      }
    }
    const names = named.map((s) => s.name.trim())
    setServers([
      ...servers,
      {
        ...draft,
        name: draft.name.trim(),
        ...(slot === 'header' ? { headers: names } : { env: names })
      }
    ])
    setProblem(null)
    setDraft(null)
    setDraftSecrets([])
    refreshSecrets()
  }

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
              <button
                className="panel-link"
                onClick={() => {
                  setDraft(blank())
                  setDraftSecrets([])
                }}
              >
                <Plus size={11} strokeWidth={2} /> add
              </button>
            </div>

            {servers.length === 0 && !draft && (
              <span className="meta">
                None yet. An MCP server gives the agent a set of tools — a GitHub connector, a
                database, your own service.
              </span>
            )}

            {servers.map((s) => {
              const nameProblem = mcpNameError(s.name, otherNames(servers, s.id))
              const open = expanded === s.id
              return (
                <div className="mcp-entry" key={s.id}>
                  <div className="mcp-row">
                    <Toggle
                      dense
                      on={s.enabled}
                      onChange={(v) => patchServer(s.id, { enabled: v })}
                      label={`Enable ${s.name}`}
                    />
                    <button
                      className="mcp-text"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : s.id)}
                    >
                      <span className="mcp-name">
                        {open ? (
                          <ChevronDown size={11} strokeWidth={2} />
                        ) : (
                          <ChevronRight size={11} strokeWidth={2} />
                        )}
                        {s.name || 'unnamed'}
                      </span>
                      <span className="meta mono">
                        {s.type === 'http' ? s.url : formatCommand(s.command ?? '', s.args)}
                      </span>
                    </button>
                    <button
                      className="loadout-act danger"
                      aria-label={`Remove ${s.name}`}
                      onClick={() => removeServer(s)}
                    >
                      <Trash2 size={13} strokeWidth={1.8} />
                    </button>
                  </div>

                  {nameProblem && (
                    <p className="meta mcp-warn">
                      Not handed to agents. {nameProblem} Remove it and add it again under a
                      different name.
                    </p>
                  )}

                  {open && (
                    <SecretEditor
                      slot={slotOf(s)}
                      names={slotNames(s)}
                      hasValue={(n) => stored.includes(mcpSecretKey(s.id, slotOf(s), n))}
                      onAdd={(n, v) => void addSecret(s, n, v)}
                      onRemove={(n) => removeSecret(s, n)}
                    />
                  )}
                </div>
              )
            })}

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
                  {draft.name.trim() && draftError && (
                    <span className="meta mcp-warn">{draftError}</span>
                  )}
                </label>
                <label className="field">
                  <span className="field-label">Transport</span>
                  <select
                    className="cell-select"
                    value={draft.type}
                    onChange={(e) => {
                      setDraft({ ...draft, type: e.target.value as McpServerSpec['type'] })
                      // Headers and environment variables are not the same list;
                      // carrying one over to the other transport would be junk.
                      setDraftSecrets([])
                    }}
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
                      // Uncontrolled on purpose. Feeding `formatCommand` back in
                      // as `value` would re-quote the line under the cursor as
                      // you type it — the field is parsed on the way out, not
                      // rewritten on the way in.
                      defaultValue={formatCommand(draft.command ?? '', draft.args)}
                      onChange={(e) => {
                        const { command, args } = parseCommand(e.target.value)
                        setDraft({ ...draft, command, args })
                      }}
                    />
                    <span className="meta">
                      Quote anything with a space:{' '}
                      <span className="mono">
                        &quot;C:\Program Files\nodejs\node.exe&quot; server.js
                      </span>
                    </span>
                  </label>
                )}

                <DraftSecrets
                  slot={draft.type === 'http' ? 'header' : 'env'}
                  rows={draftSecrets}
                  onChange={setDraftSecrets}
                />

                <div className="pills">
                  <button
                    className="pill-primary"
                    disabled={!usable(draft)}
                    onClick={() => void commitDraft()}
                  >
                    Add
                  </button>
                  <button
                    className="pill-ghost"
                    onClick={() => {
                      setDraft(null)
                      setDraftSecrets([])
                      setProblem(null)
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {problem && <div className="banner-warn">{problem}</div>}
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
              Reads skills from the open folder&apos;s <span className="mono">.claude/skills</span>,
              and any others your Claude Code install makes available. Off by default, because
              turning it on widens what the agent can reach without saying so.
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
                        : raw
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean)
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

/** Every configured name except this server's own, for the duplicate check. */
function otherNames(servers: McpServerSpec[], selfId: string): string[] {
  // Only the ones *ahead* of this server, and only the ones that are on. The
  // main process walks the list in order and keeps the first server to claim a
  // name, so flagging both halves of a duplicate would blame the one that
  // actually works — and a disabled server never claims its name at all.
  const at = servers.findIndex((s) => s.id === selfId)
  const before = at === -1 ? servers : servers.slice(0, at)
  return before.filter((s) => s.enabled).map((s) => s.name)
}

const SLOT_COPY = {
  header: {
    label: 'Headers',
    name: 'Authorization',
    value: 'Bearer …',
    hint: 'Sent with every request. Stored encrypted, never in settings.json.'
  },
  env: {
    label: 'Environment',
    name: 'GITHUB_TOKEN',
    value: 'ghp_…',
    hint: 'Added to the command’s environment. Stored encrypted, never in settings.json.'
  }
} as const

/** Credentials on a server that already exists — written to the store as they
 *  are added, so an existing value is only ever shown as “set”. */
function SecretEditor({
  slot,
  names,
  hasValue,
  onAdd,
  onRemove
}: {
  slot: 'header' | 'env'
  names: string[]
  hasValue: (name: string) => boolean
  onAdd: (name: string, value: string) => void
  onRemove: (name: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const copy = SLOT_COPY[slot]

  return (
    <div className="mcp-secrets">
      <span className="field-label">{copy.label}</span>
      {names.map((n) => (
        <div className="mcp-secret-row" key={n}>
          <span className="mono">{n}</span>
          <span className="meta">{hasValue(n) ? '•••••• set' : 'no value stored'}</span>
          <button
            className="loadout-act danger"
            aria-label={`Remove ${n}`}
            onClick={() => onRemove(n)}
          >
            <Trash2 size={12} strokeWidth={1.8} />
          </button>
        </div>
      ))}
      <div className="mcp-secret-add">
        <input
          className="field-input mono"
          placeholder={copy.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="field-input mono"
          type="password"
          placeholder={copy.value}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="pill-ghost"
          disabled={!name.trim() || !value}
          onClick={() => {
            onAdd(name.trim(), value)
            setName('')
            setValue('')
          }}
        >
          Save
        </button>
      </div>
      <span className="meta">{copy.hint}</span>
    </div>
  )
}

/** The same list on a server that does not exist yet, so nothing is written
 *  until Add is pressed. */
function DraftSecrets({
  slot,
  rows,
  onChange
}: {
  slot: 'header' | 'env'
  rows: DraftSecret[]
  onChange: (rows: DraftSecret[]) => void
}): React.JSX.Element {
  const copy = SLOT_COPY[slot]
  const patch = (i: number, p: Partial<DraftSecret>): void =>
    onChange(rows.map((r, n) => (n === i ? { ...r, ...p } : r)))

  return (
    <div className="mcp-secrets">
      <div className="panel-head">
        <span className="field-label">{copy.label}</span>
        <button className="panel-link" onClick={() => onChange([...rows, { name: '', value: '' }])}>
          <Plus size={11} strokeWidth={2} /> add
        </button>
      </div>
      {rows.map((row, i) => (
        <div className="mcp-secret-add" key={i}>
          <input
            className="field-input mono"
            placeholder={copy.name}
            value={row.name}
            onChange={(e) => patch(i, { name: e.target.value })}
          />
          <input
            className="field-input mono"
            type="password"
            placeholder={copy.value}
            value={row.value}
            onChange={(e) => patch(i, { value: e.target.value })}
          />
          <button
            className="loadout-act danger"
            aria-label="Remove"
            onClick={() => onChange(rows.filter((_, n) => n !== i))}
          >
            <Trash2 size={12} strokeWidth={1.8} />
          </button>
        </div>
      ))}
      {rows.length > 0 && <span className="meta">{copy.hint}</span>}
    </div>
  )
}
