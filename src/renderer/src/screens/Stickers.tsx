import { useMemo, useState } from 'react'
import { Play, Plus, FolderOpen } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { ArtPlaceholder, ScreenHeader, Toggle } from '@renderer/components/ui/Controls'
import { playSound, isQuietNow } from '@renderer/lib/audio'
import type { StickerMode, StickerRule } from '@shared/types'
import './screens.css'

const MODES: StickerMode[] = ['chat', 'bubble', 'overlay']
const RATES: StickerRule['howOften'][] = ['always', 'once-per-hour', 'once']

export function Stickers(): React.JSX.Element {
  const { library, rules, dispatch, settings, stickerSrc, fireSticker } = useStore()
  const [tag, setTag] = useState('all')

  const tags = useMemo(() => {
    const set = new Set<string>(['all'])
    library?.stickers.forEach((s) => set.add(s.tag))
    return [...set]
  }, [library])

  const shown = (library?.stickers ?? []).filter((s) => tag === 'all' || s.tag === tag)
  const quiet = settings.quietHours.enabled
    ? isQuietNow(settings.quietHours.from, settings.quietHours.to)
    : false

  const patchRule = (id: string, p: Partial<StickerRule>): void => {
    dispatch({ type: 'rules', rules: rules.map((r) => (r.id === id ? { ...r, ...p } : r)) })
  }

  return (
    <>
      <ScreenHeader
        title="Stickers & sound"
        subtitle="Sticker and sound fire together as one event, so they always land in sync."
        action={
          <div className="pills">
            {tags.map((t) => (
              <button key={t} className="pill-ghost" data-on={tag === t} onClick={() => setTag(t)}>
                {t}
              </button>
            ))}
          </div>
        }
      />

      <div className="stickers">
        <div className="stickers-main">
          <div className="sticker-grid">
            {shown.map((s) => (
              <button
                key={s.id}
                className="sticker-tile"
                onClick={() => fireSticker({ stickerId: s.id, caption: s.name })}
                title="Fire this sticker"
              >
                <div className="sticker-art">
                  {s.src ? <img src={s.src} alt="" /> : <ArtPlaceholder />}
                </div>
                <div className="sticker-caption">
                  <span className="sticker-name">{s.name}</span>
                  <span className="mono meta">{s.tag}</span>
                </div>
              </button>
            ))}
            <button className="sticker-add" onClick={() => window.mochi?.openFolder('stickers')}>
              <Plus size={18} strokeWidth={1.8} />
              <span className="meta">add stickers</span>
            </button>
          </div>
        </div>

        <aside className="stickers-side">
          <section className="config-card">
            <div className="panel-head">
              <span className="section-label">Sounds</span>
              <button className="panel-link" onClick={() => window.mochi?.openFolder('sounds')}>
                <FolderOpen size={11} strokeWidth={1.8} /> folder
              </button>
            </div>
            {(library?.sounds ?? []).map((s, i) => (
              <div className="sound-row" key={s.id}>
                <button
                  className="sound-play"
                  data-first={i === 0}
                  aria-label={`Play ${s.name}`}
                  onClick={() => void playSound(s.src, { enabled: settings.sound, quiet })}
                >
                  <Play size={11} strokeWidth={2.2} />
                </button>
                <span className="mono sound-name">{s.name}</span>
                <span className="meta">{s.duration ? `${s.duration}s` : ''}</span>
              </div>
            ))}
            {(library?.sounds.length ?? 0) === 0 && (
              <span className="meta">
                No sounds yet — the built-in chime plays until you drop some in.
              </span>
            )}
            <button className="drop-target" onClick={() => window.mochi?.openFolder('sounds')}>
              <span>drop wav / mp3 / ogg here</span>
            </button>
          </section>

          <div className="note-accent">
            Sticker and sound fire together as one event, so they always land in sync.
          </div>
        </aside>
      </div>

      {/* Rules table */}
      <div className="rules-bar">
        <div className="rules-head">
          <span className="section-label">Rules</span>
          <span className="rules-free">
            <span className="meta">
              agent may also pick freely — tool <span className="mono">sendSticker()</span>
            </span>
            <Toggle
              dense
              on={settings.agentMayPickStickers}
              onChange={(v) => dispatch({ type: 'settings', patch: { agentMayPickStickers: v } })}
              label="Agent may pick stickers freely"
            />
          </span>
        </div>

        <div className="tbl-wrap">
          <table className="tbl rules-tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Sticker</th>
                <th>Sound</th>
                <th>Show as</th>
                <th>How often</th>
                <th aria-label="Enabled" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} data-off={!r.enabled}>
                  <td>{r.when}</td>
                  <td>
                    <span className="rule-sticker">
                      {stickerSrc(r.stickerId) ? (
                        <img src={stickerSrc(r.stickerId) as string} alt="" />
                      ) : (
                        <ArtPlaceholder size={20} />
                      )}
                      <span className="mono">{r.stickerId ?? '—'}</span>
                    </span>
                  </td>
                  <td className="mono">{r.soundId ?? '—'}</td>
                  <td>
                    <select
                      className="cell-select"
                      value={r.showAs}
                      onChange={(e) => patchRule(r.id, { showAs: e.target.value as StickerMode })}
                    >
                      {MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="cell-select"
                      value={r.howOften}
                      onChange={(e) =>
                        patchRule(r.id, {
                          howOften: e.target.value as StickerRule['howOften']
                        })
                      }
                    >
                      {RATES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Toggle
                      dense
                      on={r.enabled}
                      onChange={(v) => patchRule(r.id, { enabled: v })}
                      label={`Enable rule: ${r.when}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
