import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, FolderPlus, Import, Pencil, Trash2, X } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import {
  ArtPlaceholder,
  Pills,
  Row,
  ScreenHeader,
  Slider,
  Toggle
} from '@renderer/components/ui/Controls'
import { MASCOT_STATES, MASCOT_STATE_LABELS, SPRITE_SLOTS } from '@shared/types'
import type { AssetLibrary, IdleMotion, MascotShell, MascotState, SpriteSlot } from '@shared/types'
import './screens.css'

/** Matches the extensions main will accept, so a dropped `.txt` is rejected here
 *  rather than silently ignored after a round trip. */
const IMAGE_RE = /\.(png|svg|jpe?g|webp|gif)$/i

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
  const { settings, dispatch, mascotState, agents, reloadLibrary } = useStore()
  const cfg = settings.mascot
  const defaultPreset = agents.find((a) => a.id === settings.defaultAgentId)?.spritePreset ?? 'sprout'

  /*
   * The studio edits a folder, it does not pick an agent's folder.
   *
   * Previously the two were the same thing — the dropdown wrote straight to the
   * default agent's `spritePreset` — so you could not look at one mascot set
   * while an agent used another, and there was no way to build a set before
   * committing an agent to it. Which folder each agent *uses* now lives in the
   * loadout editor. This screen keeps its own selection and reads that folder's
   * library directly rather than going through the global one.
   */
  const [folder, setFolder] = useState<string>(defaultPreset)
  const [folders, setFolders] = useState<string[]>([])
  const [lib, setLib] = useState<AssetLibrary | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [dragging, setDragging] = useState(false)

  /** Bumped by anything that changes the folder on disk, to force a re-read. */
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!window.mochi) return
      const [list, library] = await Promise.all([
        window.mochi.listPresets(),
        window.mochi.library(folder)
      ])
      // Switching folders quickly can land an older read last, which would show
      // one folder's art under another folder's name.
      if (cancelled) return
      setFolders(list)
      setLib(library)
    })()
    return () => {
      cancelled = true
    }
  }, [folder, revision])

  // Art dropped into the folder from Explorer should show up too, not only the
  // drops made through this screen.
  useEffect(() => window.mochi?.onLibraryChanged(refresh), [refresh])

  const spriteFor = (state: SpriteSlot): string | null =>
    lib?.sprites.find((s) => s.state === state)?.src ?? null
  const stage = spriteFor(mascotState) ?? spriteFor('idle')
  const usedBy = agents.filter((a) => a.spritePreset === folder)

  /** Anything that touched disk invalidates both this screen and, when the
   *  folder is in use by an agent, the live mascot. */
  const after = async (result: { ok: boolean; error?: string }): Promise<void> => {
    if (!result.ok) {
      setNote(result.error ?? 'That did not work')
      return
    }
    setNote(null)
    await refresh()
    if (usedBy.length > 0) reloadLibrary()
  }

  const importFiles = async (files: File[]): Promise<void> => {
    const images = files.filter((f) => IMAGE_RE.test(f.name))
    if (images.length === 0) {
      setNote('Those were not images — png, svg, jpg, webp or gif.')
      return
    }
    const payload = await Promise.all(
      images.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))
    )
    await after(await window.mochi!.spriteImport(folder, payload))
  }

  /**
   * Re-point a state, or clear one.
   *
   * Assignment lives in the folder's manifest, so moving a file from one state
   * to another is two writes: claim the new state, release the old one. Doing
   * only the first would leave the image mapped twice.
   */
  const assign = async (file: string, from: SpriteSlot | null, to: SpriteSlot | ''): Promise<void> => {
    if (to === '') {
      if (from) await after(await window.mochi!.spriteAssign(folder, from, null))
      return
    }
    await window.mochi!.spriteAssign(folder, to, file)
    if (from && from !== to) await window.mochi!.spriteAssign(folder, from, null)
    await after({ ok: true })
  }

  const newFolder = async (): Promise<void> => {
    const name = window.prompt('Name the new mascot folder')
    if (!name?.trim()) return
    const res = await window.mochi!.presetCreate(name.trim())
    if (res.ok) setFolder(res.value)
    await after(res)
  }

  const importFolder = async (): Promise<void> => {
    const res = await window.mochi!.presetImport()
    // Cancelling the dialog is not a failure worth reporting back.
    if (!res.ok && res.error === 'cancelled') return
    if (res.ok) setFolder(res.value)
    await after(res)
  }

  const commitRename = async (): Promise<void> => {
    const next = draftName.trim()
    setRenaming(false)
    if (!next || next === folder) return
    const res = await window.mochi!.presetRename(folder, next)
    if (res.ok) {
      // Any loadout pointing at the old name would break, so move them with it.
      dispatch({
        type: 'agents',
        agents: agents.map((a) =>
          a.spritePreset === folder ? { ...a, spritePreset: res.value } : a
        )
      })
      setFolder(res.value)
    }
    await after(res)
  }

  const removeFolder = async (): Promise<void> => {
    if (usedBy.length > 0) {
      setNote(`${usedBy.map((a) => a.name).join(', ')} still use this folder.`)
      return
    }
    if (!window.confirm(`Delete the "${folder}" mascot folder and its art?`)) return
    const res = await window.mochi!.presetDelete(folder)
    if (res.ok) setFolder('sprout')
    await after(res)
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
            {renaming ? (
              <input
                className="rail-rename preset-rename"
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename()
                  if (e.key === 'Escape') setRenaming(false)
                }}
              />
            ) : (
              <select
                className="cell-select preset-select"
                value={folder}
                aria-label="Mascot folder"
                onChange={(e) => setFolder(e.target.value)}
              >
                {folders.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
            <button
              className="folder-chip"
              title="New folder"
              aria-label="New mascot folder"
              onClick={() => void newFolder()}
            >
              <FolderPlus size={12} strokeWidth={1.8} />
            </button>
            <button
              className="folder-chip"
              title="Import a folder of art"
              aria-label="Import a folder of art"
              onClick={() => void importFolder()}
            >
              <Import size={12} strokeWidth={1.8} />
            </button>
            <button
              className="folder-chip"
              title="Rename"
              aria-label="Rename this folder"
              onClick={() => {
                setDraftName(folder)
                setRenaming(true)
              }}
            >
              <Pencil size={12} strokeWidth={1.8} />
            </button>
            <button
              className="folder-chip"
              title="Delete this folder"
              aria-label="Delete this folder"
              onClick={() => void removeFolder()}
            >
              <Trash2 size={12} strokeWidth={1.8} />
            </button>
            <button
              className="folder-chip mono"
              title="Reveal in Explorer"
              aria-label="Reveal in Explorer"
              onClick={() => window.mochi?.presetOpen(folder)}
            >
              <FolderOpen size={12} strokeWidth={1.8} />
            </button>
          </div>

          <span className="meta">
            {usedBy.length > 0
              ? `Used by ${usedBy.map((a) => a.name).join(', ')}.`
              : 'Not used by any loadout yet — pick it in Agents & loadouts.'}
          </span>
          {note && <div className="banner-warn">{note}</div>}

          <div className="sprite-grid">
            {SPRITE_SLOTS.map((s) => {
              const src = spriteFor(s)
              return (
                <div key={s} className="sprite-tile" data-selected={s === mascotState}>
                  {src ? <img src={src} alt="" /> : <span className="sprite-empty">?</span>}
                  <span className="sprite-label mono">{MASCOT_STATE_LABELS[s]}</span>
                </div>
              )
            })}
          </div>

          {/* A real drop target. This used to be a button that opened Explorer,
              which meant the label "drop png / svg / jpg here" described
              something the app could not actually do. */}
          <div
            className="drop-target"
            data-hot={dragging}
            role="button"
            tabIndex={0}
            onClick={() => window.mochi?.presetOpen(folder)}
            onKeyDown={(e) => e.key === 'Enter' && window.mochi?.presetOpen(folder)}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              void importFiles(Array.from(e.dataTransfer.files))
            }}
          >
            <span>drop png / svg / jpg here</span>
            <span className="meta">
              a file named after a state is assigned for you — otherwise pick it below
            </span>
          </div>

          {/* Everything in the folder, assigned or not. Unassigned art used to be
              invisible: it sat in the folder doing nothing with no way to tell. */}
          {(lib?.spriteFiles.length ?? 0) > 0 && (
            <div className="sprite-files">
              {lib!.spriteFiles.map((f) => (
                <div className="sprite-file" key={f.file}>
                  <img src={f.src} alt="" />
                  <span className="sprite-file-name mono" title={f.file}>
                    {f.file}
                  </span>
                  <select
                    className="cell-select"
                    aria-label={`State for ${f.file}`}
                    value={f.state ?? ''}
                    onChange={(e) =>
                      void assign(f.file, f.state, e.target.value as SpriteSlot | '')
                    }
                  >
                    <option value="">unassigned</option>
                    {SPRITE_SLOTS.map((s) => (
                      <option key={s} value={s}>
                        {MASCOT_STATE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                  <button
                    className="sprite-file-drop"
                    aria-label={`Delete ${f.file}`}
                    title="Delete this image"
                    onClick={() =>
                      void window.mochi!.spriteRemove(folder, f.file).then((r) => after(r))
                    }
                  >
                    <X size={12} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* These were inert. They set the app accent, which is what actually
              recolours the mascot's shell, glow and highlights. */}
          <div className="swatch-row">
            {['#B1DF7D', '#FAEBE7', '#F2D4A0', '#473646', '#9dc98a'].map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c }}
                data-on={settings.accent.toLowerCase() === c.toLowerCase()}
                aria-label={`Recolour to ${c}`}
                aria-pressed={settings.accent.toLowerCase() === c.toLowerCase()}
                onClick={() => dispatch({ type: 'settings', patch: { accent: c } })}
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
            {/* This row printed cfg.idleMotion and sounds[0] for every state, so
                it always claimed the same mapping regardless of reality. The
                sprite half is now read from the loaded set, and the sound half
                is a real per-state choice the mascot plays on entering it. */}
            {MASCOT_STATES.map((s) => (
              <div className="map-row" key={s}>
                <span className="map-dot" style={{ background: STATE_DOT[s] }} />
                <span className="map-state">{MASCOT_STATE_LABELS[s]}</span>
                <span className="mono map-meta" title={spriteFor(s) ? 'sprite found' : 'no sprite'}>
                  {spriteFor(s) ? 'sprite' : 'no art'}
                </span>
                <select
                  className="cell-select map-sound"
                  aria-label={`Sound for ${s}`}
                  value={cfg.stateSounds?.[s] ?? ''}
                  onChange={(e) =>
                    dispatch({
                      type: 'mascot-config',
                      patch: {
                        stateSounds: { ...(cfg.stateSounds ?? {}), [s]: e.target.value || null }
                      }
                    })
                  }
                >
                  <option value="">silent</option>
                  {(lib?.sounds ?? []).map((snd) => (
                    <option key={snd.id} value={snd.id}>
                      {snd.name}
                    </option>
                  ))}
                </select>
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
