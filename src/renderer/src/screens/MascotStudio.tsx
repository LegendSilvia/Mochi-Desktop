import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import {
  ArtPlaceholder,
  Pills,
  Row,
  ScreenHeader,
  Slider,
  Toggle
} from '@renderer/components/ui/Controls'
import { MASCOT_STATES, MASCOT_STATE_LABELS } from '@shared/types'
import type { IdleMotion, MascotShell, MascotState } from '@shared/types'
import './screens.css'

const MOTIONS = [
  { value: 'breathe' as IdleMotion, label: 'breathe' },
  { value: 'float' as IdleMotion, label: 'float' },
  { value: 'sway' as IdleMotion, label: 'sway' },
  { value: 'still' as IdleMotion, label: 'still' }
]

const SHELLS = [
  { value: 'bare' as MascotShell, label: 'bare' },
  { value: 'card' as MascotShell, label: 'card' },
  { value: 'orb' as MascotShell, label: 'orb' },
  { value: 'terrarium' as MascotShell, label: 'terrarium' }
]

const STATE_DOT: Record<MascotState, string> = {
  idle: 'var(--ac)',
  thinking: 'var(--blue)',
  'tool-running': 'var(--warm)',
  error: 'var(--rose)',
  done: 'var(--ac)',
  sleeping: 'var(--tx3)'
}

export function MascotStudio(): React.JSX.Element {
  const { settings, dispatch, library, spriteSrc, mascotState, agents, reloadLibrary } = useStore()
  const cfg = settings.mascot
  const preset = agents.find((a) => a.id === settings.defaultAgentId)?.spritePreset ?? 'sprout'
  const stage = spriteSrc(mascotState) ?? spriteSrc('idle')
  const [presets, setPresets] = useState<string[]>([])

  // Swapping the whole sprite set was the one thing the studio couldn't do: the
  // folder was read off the default agent and there was no way to change it.
  useEffect(() => {
    void window.mochi?.listPresets().then(setPresets)
  }, [library])

  const usePreset = (next: string): void => {
    dispatch({
      type: 'agents',
      agents: agents.map((a) =>
        a.id === settings.defaultAgentId ? { ...a, spritePreset: next } : a
      )
    })
    // The library is loaded per preset, so it has to be re-read for the new art
    // to reach the stage and the mascot layer.
    reloadLibrary()
  }

  return (
    <>
      <ScreenHeader
        title="Mascot studio"
        subtitle="Drop artwork in, map it to states, and set how it moves. The file name becomes the state."
      />
      <div className="studio">
        {/* Left — sprite set */}
        <div className="studio-left">
          <div className="preset-row">
            <button
              className="folder-chip mono"
              onClick={() => window.mochi?.openFolder('sprites')}
              title="Open the folder"
            >
              <FolderOpen size={12} strokeWidth={1.8} />
              mascots/{preset}/
            </button>
            {presets.length > 1 && (
              <select
                className="cell-select preset-select"
                value={preset}
                aria-label="Sprite set"
                onChange={(e) => usePreset(e.target.value)}
              >
                {presets.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
          </div>
          {presets.length <= 1 && (
            <span className="meta">
              Drop another folder into <span className="mono">mascots/</span> to swap the whole
              sprite set.
            </span>
          )}

          <div className="sprite-grid">
            {MASCOT_STATES.map((s) => {
              const src = spriteSrc(s)
              return (
                <div key={s} className="sprite-tile" data-selected={s === mascotState}>
                  {src ? <img src={src} alt="" /> : <span className="sprite-empty">?</span>}
                  <span className="sprite-label mono">{MASCOT_STATE_LABELS[s]}</span>
                </div>
              )
            })}
          </div>

          <button className="drop-target" onClick={() => window.mochi?.openFolder('sprites')}>
            <span>drop png / svg / jpg here</span>
            <span className="meta">file name becomes the state</span>
          </button>

          <div className="swatch-row">
            {['#B1DF7D', '#FAEBE7', '#F2D4A0', '#473646', '#9dc98a'].map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c }}
                aria-label={`Recolour to ${c}`}
              />
            ))}
          </div>
        </div>

        {/* Centre — stage */}
        <div className="studio-centre">
          <div className="stage">
            <div className="stage-chips">
              <span className="chip mono">state: {mascotState}</span>
              <span className="chip mono">
                {cfg.size}px · {Math.round(cfg.opacity * 100)}%
              </span>
            </div>
            <div className="stage-inner">
              <div
                className={`stage-sprite ${cfg.idleMotion === 'still' ? '' : `mo-idle-${cfg.idleMotion}`}`}
                style={{ width: 190, height: 190, opacity: cfg.opacity }}
              >
                {stage ? <img src={stage} alt="" /> : <ArtPlaceholder size={190} />}
              </div>
              <div className="stage-ground" />
            </div>
          </div>

          <div className="stage-controls">
            <section className="config-card">
              <span className="section-label">Size & opacity</span>
              <Row label="Size" hint={`${cfg.size}px`}>
                <Slider
                  value={cfg.size}
                  min={72}
                  max={200}
                  onChange={(v) => dispatch({ type: 'mascot-config', patch: { size: v } })}
                  label="Mascot size"
                />
              </Row>
              <Row label="Opacity" hint={`${Math.round(cfg.opacity * 100)}%`}>
                <Slider
                  value={cfg.opacity * 100}
                  min={30}
                  max={100}
                  onChange={(v) => dispatch({ type: 'mascot-config', patch: { opacity: v / 100 } })}
                  label="Mascot opacity"
                />
              </Row>
            </section>

            <section className="config-card">
              <span className="section-label">Idle motion</span>
              <Pills
                options={MOTIONS}
                value={cfg.idleMotion}
                onChange={(v) => dispatch({ type: 'mascot-config', patch: { idleMotion: v } })}
              />
              <span className="section-label">Shell</span>
              <Pills
                options={SHELLS}
                value={cfg.shell}
                onChange={(v) => dispatch({ type: 'mascot-config', patch: { shell: v } })}
              />
            </section>

            <section className="config-card">
              <span className="section-label">Physics</span>
              <Row label="Bounce on drop">
                <Toggle
                  dense
                  on={cfg.bounceOnDrop}
                  onChange={(v) => dispatch({ type: 'mascot-config', patch: { bounceOnDrop: v } })}
                  label="Bounce on drop"
                />
              </Row>
              <Row label="Drag anywhere">
                <Toggle
                  dense
                  on={cfg.dragAnywhere}
                  onChange={(v) => dispatch({ type: 'mascot-config', patch: { dragAnywhere: v } })}
                  label="Drag anywhere"
                />
              </Row>
              <Row label="Walk window edges" hint="not wired yet">
                <Toggle
                  dense
                  on={cfg.walkWindowEdges}
                  onChange={(v) =>
                    dispatch({ type: 'mascot-config', patch: { walkWindowEdges: v } })
                  }
                  label="Walk window edges"
                />
              </Row>
              <Row label="Remember position">
                <Toggle
                  dense
                  on={cfg.rememberPosition}
                  onChange={(v) =>
                    dispatch({ type: 'mascot-config', patch: { rememberPosition: v } })
                  }
                  label="Remember position"
                />
              </Row>
            </section>
          </div>
        </div>

        {/* Right — mapping + personality */}
        <div className="studio-right">
          <section className="config-card">
            <span className="section-label">State → sprite → sound</span>
            {MASCOT_STATES.map((s) => (
              <div className="map-row" key={s}>
                <span className="map-dot" style={{ background: STATE_DOT[s] }} />
                <span className="map-state">{MASCOT_STATE_LABELS[s]}</span>
                <span className="mono map-meta">
                  {spriteSrc(s) ? 'sprite' : '—'} · {cfg.idleMotion} ·{' '}
                  {library?.sounds[0]?.id ?? 'chime'}
                </span>
              </div>
            ))}
          </section>

          <section className="config-card">
            <span className="section-label">Personality</span>
            <Row label="Talks unprompted" hint={`${cfg.talksUnprompted}/10`}>
              <Slider
                value={cfg.talksUnprompted}
                onChange={(v) => dispatch({ type: 'mascot-config', patch: { talksUnprompted: v } })}
                label="Talks unprompted"
              />
            </Row>
            <Row label="Sticker rate">
              <Pills
                options={[
                  { value: 'rare' as const, label: 'rare' },
                  { value: 'often' as const, label: 'often' },
                  { value: 'constant' as const, label: 'constant' }
                ]}
                value={cfg.stickerRate}
                onChange={(v) => dispatch({ type: 'mascot-config', patch: { stickerRate: v } })}
              />
            </Row>
          </section>
        </div>
      </div>
    </>
  )
}
