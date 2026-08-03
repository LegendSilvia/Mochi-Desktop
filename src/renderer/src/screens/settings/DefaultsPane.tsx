import { useStore } from '@renderer/state/context'
import { WIP_SESSION_TYPES } from '@renderer/state/screens'
import { Pills, Row, ScreenHeader, Toggle } from '@renderer/components/ui/Controls'
import { ACCENT_OPTIONS } from '@shared/defaults'
import type { Contrast, SessionType } from '@shared/types'

const TYPES: SessionType[] = ['normal', 'supervised', 'standing', 'scratch']

export function DefaultsPane(): React.JSX.Element {
  const { agents, settings, dispatch } = useStore()

  return (
    <>
      <ScreenHeader title="Defaults" subtitle="What a new session starts as." />
      <div className="screen-body pane-cols">
        <div className="pane-col">
          <section className="config-card">
            <span className="section-label">Default agent</span>
            {agents.map((a) => (
              <label className="radio-row" key={a.id}>
                <input
                  type="radio"
                  name="default-agent"
                  checked={settings.defaultAgentId === a.id}
                  onChange={() => dispatch({ type: 'settings', patch: { defaultAgentId: a.id } })}
                />
                <span className="radio-text">
                  <span className="ctl-row-label">{a.name}</span>
                  <span className="meta">{a.description}</span>
                </span>
              </label>
            ))}
          </section>

          <section className="config-card">
            <span className="section-label">Default session type</span>
            <div className="pills">
              {TYPES.map((t) => {
                const wip = (WIP_SESSION_TYPES as readonly string[]).includes(t)
                return (
                  <button
                    key={t}
                    className="pill-ghost"
                    data-on={settings.defaultSessionType === t}
                    disabled={wip}
                    onClick={() => dispatch({ type: 'settings', patch: { defaultSessionType: t } })}
                  >
                    {t}
                    {wip && <span className="badge wip">wip</span>}
                  </button>
                )
              })}
            </div>
          </section>
        </div>

        <div className="pane-col">
          <section className="config-card">
            <span className="section-label">Appearance</span>
            <Row label="Theme">
              <Pills
                options={[
                  { value: 'dark' as const, label: 'dark' },
                  { value: 'light' as const, label: 'light' }
                ]}
                value={settings.theme}
                onChange={(v) => dispatch({ type: 'settings', patch: { theme: v } })}
              />
            </Row>
            <Row label="Contrast" hint="scales the soft tokens, not a separate palette">
              <Pills
                options={[
                  { value: 'whisper' as Contrast, label: 'whisper' },
                  { value: 'calm' as Contrast, label: 'calm' },
                  { value: 'crisp' as Contrast, label: 'crisp' }
                ]}
                value={settings.contrast}
                onChange={(v) => dispatch({ type: 'settings', patch: { contrast: v } })}
              />
            </Row>
            <Row label="Accent">
              <div className="pills">
                {ACCENT_OPTIONS.map((c) => (
                  <button
                    key={c}
                    className="swatch"
                    data-on={settings.accent === c}
                    style={{ background: c }}
                    aria-label={`Accent ${c}`}
                    onClick={() => dispatch({ type: 'settings', patch: { accent: c } })}
                  />
                ))}
              </div>
            </Row>
          </section>

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
            <Row label="Quiet hours" hint={`${settings.quietHours.from}–${settings.quietHours.to}`}>
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
              Quiet hours mute the sound. The sticker still shows — you just don&apos;t hear it.
            </span>
          </section>
        </div>
      </div>
    </>
  )
}
