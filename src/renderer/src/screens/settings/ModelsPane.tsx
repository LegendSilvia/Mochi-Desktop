import { useEffect, useState } from 'react'
import { useStore } from '@renderer/state/context'
import { Row, ScreenHeader, Toggle } from '@renderer/components/ui/Controls'
import type { ProviderAccount } from '@shared/types'

export function ModelsPane(): React.JSX.Element {
  const { settings, dispatch } = useStore()
  const [providers, setProviders] = useState<ProviderAccount[]>([])
  const [adding, setAdding] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = (): void => {
    void window.mochi?.providers().then(setProviders)
  }
  useEffect(refresh, [])

  const saveKey = async (id: string): Promise<void> => {
    const res = await window.mochi?.setProviderKey(id, keyDraft.trim())
    if (res && !res.ok) {
      setProblem(res.reason ?? 'Could not save the key.')
      return
    }
    setProblem(null)
    setAdding(null)
    setKeyDraft('')
    refresh()
  }

  const spent = 12.4
  const pct = settings.spendCap > 0 ? Math.min(100, (spent / settings.spendCap) * 100) : 0

  return (
    <>
      <ScreenHeader
        title="Models & providers"
        subtitle="Keys are stored in the Windows Credential Manager, never in a file."
      />
      <div className="screen-body pane-cols">
        <div className="pane-col">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Billed via</th>
                  <th>Account</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>
                      <span className="chip">{p.billedVia}</span>
                    </td>
                    <td className="mono">
                      {p.billedVia === 'local'
                        ? 'local · free'
                        : (p.account ?? <span className="dim">not connected</span>)}
                    </td>
                    <td>
                      {p.billedVia !== 'local' &&
                        (p.connected ? (
                          <button
                            className="pill-ghost"
                            onClick={() => {
                              void window.mochi?.deleteProviderKey(p.id).then(refresh)
                            }}
                          >
                            Remove
                          </button>
                        ) : (
                          <button className="pill-ghost" onClick={() => setAdding(p.id)}>
                            Connect
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {adding && (
            <section className="config-card">
              <span className="section-label">Add a provider</span>
              <label className="field">
                <span className="field-label">Paste an API key</span>
                <input
                  className="field-input mono"
                  type="password"
                  value={keyDraft}
                  autoFocus
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="sk-…"
                />
              </label>
              <span className="meta">
                Stored with the OS credential store. Mochi never writes keys to disk in plaintext.
              </span>
              {problem && <div className="banner-warn">{problem}</div>}
              <div className="pills">
                <button className="pill-primary" onClick={() => void saveKey(adding)}>
                  Save
                </button>
                <button className="pill-ghost" onClick={() => setAdding(null)}>
                  Cancel
                </button>
              </div>
            </section>
          )}
        </div>

        <div className="pane-col">
          <section className="config-card">
            <span className="section-label">Which model does what</span>
            {(
              [
                ['conversation', 'Conversation'],
                ['quickJobs', 'Quick jobs'],
                ['embeddings', 'Embeddings'],
                ['evalGrader', 'Eval grader']
              ] as const
            ).map(([key, label]) => (
              <label className="field" key={key}>
                <span className="field-label">{label}</span>
                <input
                  className="field-input mono"
                  value={settings.modelRoles[key]}
                  onChange={(e) =>
                    dispatch({
                      type: 'settings',
                      patch: { modelRoles: { ...settings.modelRoles, [key]: e.target.value } }
                    })
                  }
                />
              </label>
            ))}
            <Row label="Run on my Claude subscription">
              <Toggle
                dense
                on={settings.preferSubscription}
                onChange={(v) => dispatch({ type: 'settings', patch: { preferSubscription: v } })}
                label="Run on my Claude subscription"
              />
            </Row>
            <p className="meta">
              {settings.preferSubscription
                ? 'Sessions run through the Claude Agent SDK using your Claude Code login, so no API key is charged. Anthropic models only, and it stops when your plan limit is reached rather than spilling over to API billing.'
                : 'Sessions run through Mastra against the provider APIs, billed per token to the keys above.'}
            </p>
            <Row label="Fall back to Ollama when offline">
              <Toggle
                dense
                on={settings.fallbackToOllamaOffline}
                onChange={(v) =>
                  dispatch({ type: 'settings', patch: { fallbackToOllamaOffline: v } })
                }
                label="Fall back to Ollama"
              />
            </Row>
          </section>

          <section className="config-card">
            <span className="section-label">Spend this month</span>
            <div className="spend">
              <span className="spend-amount">${spent.toFixed(2)}</span>
              <span className="meta">of ${settings.spendCap} cap</span>
            </div>
            <div className="spend-bar">
              <div className="spend-fill" style={{ width: `${pct}%` }} />
            </div>
            <Row label="Warn me at 80%">
              <Toggle
                dense
                on={settings.warnAt80Percent}
                onChange={(v) => dispatch({ type: 'settings', patch: { warnAt80Percent: v } })}
                label="Warn at 80 percent"
              />
            </Row>
            <span className="meta">
              Spend is a placeholder until provider billing APIs are wired (M12-09).
            </span>
          </section>
        </div>
      </div>
    </>
  )
}
