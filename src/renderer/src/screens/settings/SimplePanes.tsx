import { useStore } from '@renderer/state/context'
import type { Screen } from '@renderer/state/screens'
import { Row, ScreenHeader, Toggle } from '@renderer/components/ui/Controls'

/**
 * The remaining non-WIP settings panes.
 *
 * These render the real shape of each pane from the handoff against real local
 * state, but the Mastra capability behind each one is still to be wired — the
 * task ID is noted on each so it is obvious what is and isn't connected. Nothing
 * here pretends to be live data.
 */
export function SimplePanes({ screen }: { screen: Screen }): React.JSX.Element {
  const { settings, dispatch, library } = useStore()

  switch (screen) {
    case 'tools':
      return (
        <>
          <ScreenHeader
            title="Tools & MCP"
            subtitle="sendSticker and setMascotState are first-class Mochi tools."
          />
          <div className="screen-body">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Description</th>
                    <th>From</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="mono">sendSticker</td>
                    <td>Send a sticker + sound as one event</td>
                    <td>
                      <span className="chip">mochi</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="mono">setMascotState</td>
                    <td>Set the mascot lifecycle state</td>
                    <td>
                      <span className="chip">mochi</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="meta pane-note">
              MCP server cards and the connected-tool registry are M8-02 — not wired yet.
            </p>
          </div>
        </>
      )

    case 'rag':
      return (
        <>
          <ScreenHeader title="RAG & sources" subtitle="What the agent can look things up in." />
          <div className="screen-body">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Kind</th>
                    <th>Chunks</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={4} className="empty-cell">
                      No sources indexed yet. Adding sources is M7-01.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )

    case 'channels':
      return (
        <>
          <ScreenHeader
            title="Channels"
            subtitle="Two-way command — you message the agent from Slack or Discord and it answers there."
          />
          <div className="screen-body pane-cols">
            <div className="pane-col">
              <section className="config-card">
                <span className="section-label">Listening in</span>
                <p className="meta">
                  No channels connected. Slack and Discord adapters are M9-02 and M9-03.
                </p>
              </section>
            </div>
            <div className="pane-col">
              <section className="config-card">
                <span className="section-label">What it may send back</span>
                <Row label="Text">
                  <Toggle dense on onChange={() => {}} label="Send text" />
                </Row>
                <Row label="Files">
                  <Toggle dense on onChange={() => {}} label="Send files" />
                </Row>
                <Row label="Stickers" hint="uploaded as an image">
                  <Toggle dense on onChange={() => {}} label="Send stickers" />
                </Row>
                <Row label="Sound effects" hint="chat apps can't autoplay audio">
                  <Toggle dense on={false} onChange={() => {}} label="Send sound" />
                </Row>
              </section>
            </div>
          </div>
        </>
      )

    case 'voice':
      return (
        <>
          <ScreenHeader title="Voice" subtitle="Speaking and listening." />
          <div className="screen-body pane-cols">
            <div className="pane-col">
              <section className="config-card">
                <span className="section-label">Sound</span>
                <Row label="Sound on">
                  <Toggle
                    dense
                    on={settings.sound}
                    onChange={(v) => dispatch({ type: 'settings', patch: { sound: v } })}
                    label="Sound"
                  />
                </Row>
                <Row label="Quiet hours">
                  <Toggle
                    dense
                    on={settings.quietHours.enabled}
                    onChange={(v) =>
                      dispatch({
                        type: 'settings',
                        patch: { quietHours: { ...settings.quietHours, enabled: v } }
                      })
                    }
                    label="Quiet hours"
                  />
                </Row>
                <span className="meta">
                  {library?.sounds.length ?? 0} sound files loaded. The built-in chime plays when a
                  rule has no sound assigned.
                </span>
              </section>
            </div>
            <div className="pane-col">
              <section className="config-card">
                <span className="section-label">Speech</span>
                <p className="meta">
                  Text-to-speech, speech-to-text and lip-sync are M10-01 through M10-06, and are not
                  wired. VOICEVOX was left out of this build on purpose — see the README.
                </p>
              </section>
            </div>
          </div>
        </>
      )

    case 'workspaces':
      return (
        <>
          <ScreenHeader
            title="Workspace access"
            subtitle="The working view lives in the session; this is what it may touch."
          />
          <div className="screen-body">
            <section className="config-card">
              <span className="section-label">Permissions</span>
              <div className="pills">
                <span className="chip">read</span>
                <span className="chip">write</span>
                <span className="chip">run tests</span>
                <span className="chip forbidden">merge</span>
                <span className="chip forbidden">.env</span>
              </div>
              <span className="meta">
                Enforcement against a real workspace is M6-01..M6-07 — these chips are the intended
                shape, not a live policy.
              </span>
            </section>
          </div>
        </>
      )

    case 'storage':
      return (
        <>
          <ScreenHeader title="Storage" subtitle="Where threads, messages and vectors live." />
          <div className="screen-body">
            <section className="config-card">
              <span className="section-label">Provider</span>
              <div className="pills">
                {(['libsql', 'postgres', 'upstash'] as const).map((p) => (
                  <button
                    key={p}
                    className="pill-ghost"
                    data-on={settings.storageProvider === p}
                    disabled={p !== 'libsql'}
                    title={p !== 'libsql' ? 'M13-02 / M13-03 — not wired' : undefined}
                    onClick={() => dispatch({ type: 'settings', patch: { storageProvider: p } })}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </section>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['mastra_threads', 'mastra'],
                    ['mastra_messages', 'mastra'],
                    ['mastra_vectors', 'mastra'],
                    ['mochi_mascot_presets', 'mochi'],
                    ['mochi_sticker_events', 'mochi']
                  ].map(([t, o]) => (
                    <tr key={t}>
                      <td className="mono">{t}</td>
                      <td>
                        <span className="chip">{o}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )

    case 'longrun':
      return (
        <>
          <ScreenHeader title="Goals & schedules" subtitle="Work that outlives a session." />
          <div className="screen-body">
            <section className="config-card">
              <span className="section-label">Goals</span>
              <p className="meta">
                Durable agents, goals, schedules and signals are M11-01..M11-06 — not wired.
              </p>
            </section>
            <div className="note-accent">
              Stickers queue while you are away and replay when you come back.
            </div>
          </div>
        </>
      )

    default:
      return (
        <>
          <ScreenHeader title="Settings" />
          <div className="screen-body">
            <p className="meta">Nothing here yet.</p>
          </div>
        </>
      )
  }
}
