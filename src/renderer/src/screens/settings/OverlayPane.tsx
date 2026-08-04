import { useEffect, useState } from 'react'
import { Monitor, RotateCcw } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { Pills, Row, ScreenHeader, Slider, Toggle } from '@renderer/components/ui/Controls'
import type { DisplayInfo, MascotAnchor, MascotOnTop, StickerMode, ToastSize } from '@shared/types'

const SIZES: Array<{ value: ToastSize; label: string }> = [
  { value: 'small', label: 'small' },
  { value: 'medium', label: 'medium' },
  { value: 'large', label: 'large' }
]

/** Same key `MascotLayer` writes a dragged position under. Reset has to clear
 *  it, or the mascot keeps returning to where it was dropped and the anchor
 *  setting looks broken. */
const POS_KEY = 'mochi.mascot.pos'

const ANCHORS: Array<{ value: MascotAnchor; label: string }> = [
  { value: 'top-left', label: 'top left' },
  { value: 'top-right', label: 'top right' },
  { value: 'bottom-left', label: 'bottom left' },
  { value: 'bottom-right', label: 'bottom right' }
]

const ON_TOP: Array<{ value: MascotOnTop; label: string }> = [
  { value: 'normal', label: 'normal' },
  { value: 'floating', label: 'floating' },
  { value: 'screen-saver', label: 'above everything' }
]

/**
 * The desktop overlay.
 *
 * Distinct from the Mascot studio on purpose: the studio is about the *artwork*
 * and how the sprite behaves, this is about the window it lives in — which
 * monitor, which corner, how hard it fights to stay on top, what a click does.
 * All of it was a constant in the code until this screen existed.
 */
export function OverlayPane(): React.JSX.Element {
  const { settings, dispatch } = useStore()
  const cfg = settings.mascot
  const [displays, setDisplays] = useState<DisplayInfo[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = (await window.mochi?.listDisplays()) ?? []
      if (cancelled) return
      setDisplays(list)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const patch = (p: Partial<typeof cfg>): void => dispatch({ type: 'mascot-config', patch: p })

  const modes = cfg.stickerModes ?? []
  /** Order is preserved deliberately — `stickerModes` is persisted, and
   *  reshuffling it on every toggle would churn the settings file for nothing. */
  const setMode = (mode: StickerMode, on: boolean): void =>
    patch({
      stickerModes: on
        ? modes.includes(mode)
          ? modes
          : [...modes, mode]
        : modes.filter((m) => m !== mode)
    })

  const resetPosition = (): void => {
    try {
      localStorage.removeItem(POS_KEY)
    } catch {
      /* storage disabled — the anchor below still applies on next launch */
    }
    // Nudging a value the layer reads is what makes the change visible without a
    // restart; the placement effect re-runs off the anchor.
    patch({ anchor: cfg.anchor ?? 'bottom-right' })
  }

  return (
    <>
      <ScreenHeader
        title="Desktop overlay"
        subtitle="Where the mascot sits on your desktop, and how it behaves there."
      />
      <div className="screen-body">
        <div className="config-cols">
          <section className="config-card">
            <span className="section-label">Window</span>
            <Row label="Show the mascot" hint="Ctrl+M toggles it too">
              <Toggle
                dense
                on={cfg.visible}
                onChange={(v) => patch({ visible: v })}
                label="Show the mascot"
              />
            </Row>

            <label className="field">
              <span className="field-label">Monitor</span>
              <div className="field-row">
                <Monitor size={14} strokeWidth={1.8} className="ic-code" />
                <select
                  className="cell-select field-grow"
                  value={cfg.displayId ?? ''}
                  onChange={(e) =>
                    patch({ displayId: e.target.value === '' ? null : Number(e.target.value) })
                  }
                >
                  <option value="">Follow the primary display</option>
                  {displays.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label} · {d.width}×{d.height}
                      {d.primary ? ' (primary)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            <span className="meta">
              A monitor that gets unplugged falls back to the primary one rather than leaving the
              mascot somewhere you cannot see it.
            </span>

            <span className="section-label">Stay on top</span>
            <Pills
              options={ON_TOP}
              value={cfg.onTopLevel ?? 'screen-saver'}
              onChange={(v) => patch({ onTopLevel: v })}
            />
            <span className="meta">
              <span className="mono">above everything</span> also covers full-screen apps and
              games. Drop to <span className="mono">floating</span> if the mascot gets in the way of
              those.
            </span>
          </section>

          <section className="config-card">
            <span className="section-label">Where it starts</span>
            <Pills
              options={ANCHORS}
              value={cfg.anchor ?? 'bottom-right'}
              onChange={(v) => patch({ anchor: v })}
            />
            <Row label="Gap across" hint={`${cfg.offsetX ?? 34}px`}>
              <Slider
                value={cfg.offsetX ?? 34}
                min={0}
                max={300}
                onChange={(v) => patch({ offsetX: v })}
                label="Horizontal gap"
              />
            </Row>
            <Row label="Gap down" hint={`${cfg.offsetY ?? 30}px`}>
              <Slider
                value={cfg.offsetY ?? 30}
                min={0}
                max={300}
                onChange={(v) => patch({ offsetY: v })}
                label="Vertical gap"
              />
            </Row>
            <Row label="Remember where I drag it">
              <Toggle
                dense
                on={cfg.rememberPosition}
                onChange={(v) => patch({ rememberPosition: v })}
                label="Remember position"
              />
            </Row>
            <div className="field-row">
              <button className="pill-ghost tiny" onClick={resetPosition}>
                <RotateCcw size={12} strokeWidth={1.9} />
                Put it back in the corner
              </button>
            </div>
            <span className="meta">
              A remembered position wins over the corner above — reset it to see the corner take
              effect.
            </span>
          </section>

          <section className="config-card">
            <span className="section-label">Appearance</span>
            <span className="section-label">Background</span>
            <Pills
              options={[
                { value: 'bare' as const, label: 'none' },
                { value: 'card' as const, label: 'card' },
                { value: 'orb' as const, label: 'orb' },
                { value: 'terrarium' as const, label: 'terrarium' }
              ]}
              value={cfg.shell}
              onChange={(v) => patch({ shell: v })}
            />
            <span className="meta">
              <span className="mono">none</span> drops the panel entirely and leaves just the
              sprite on your desktop. Same setting as Shell in the Mascot studio.
            </span>
            <Row label="Status line" hint="the “idle · waiting on you” caption">
              <Toggle
                dense
                on={cfg.showStatus !== false}
                onChange={(v) => patch({ showStatus: v })}
                label="Status line"
              />
            </Row>
            <span className="meta">
              Only the <span className="mono">card</span> and{' '}
              <span className="mono">terrarium</span> backgrounds draw it at all.
            </span>
            <Row label="Ground shadow" hint="the soft ellipse beneath">
              <Toggle
                dense
                on={cfg.showShadow !== false}
                onChange={(v) => patch({ showShadow: v })}
                label="Ground shadow"
              />
            </Row>
          </section>

          <section className="config-card">
            <span className="section-label">Behaviour</span>
            <Row label="Clicking the mascot" hint="a drag never counts as a click">
              <Pills
                options={[
                  { value: 'sticker' as const, label: 'send a sticker' },
                  { value: 'none' as const, label: 'do nothing' }
                ]}
                value={cfg.clickAction ?? 'sticker'}
                onChange={(v) => patch({ clickAction: v })}
              />
            </Row>
            <Row label="Drag from anywhere" hint="off means only the sprite itself">
              <Toggle
                dense
                on={cfg.dragAnywhere}
                onChange={(v) => patch({ dragAnywhere: v })}
                label="Drag anywhere"
              />
            </Row>
            <Row label="Bounce when dropped">
              <Toggle
                dense
                on={cfg.bounceOnDrop}
                onChange={(v) => patch({ bounceOnDrop: v })}
                label="Bounce on drop"
              />
            </Row>
          </section>

          {/* One sticker used to fire on every surface at once with no way to
              say otherwise: `stickerModes` had been in the config all along and
              nothing ever read it into a control. */}
          <section className="config-card">
            <span className="section-label">Where a sticker shows up</span>
            <Row label="In the chat thread" hint="a card in the conversation">
              <Toggle
                dense
                on={modes.includes('chat')}
                onChange={(v) => setMode('chat', v)}
                label="In the chat thread"
              />
            </Row>
            <Row label="Bubble over the mascot" hint="a short speech bubble">
              <Toggle
                dense
                on={modes.includes('bubble')}
                onChange={(v) => setMode('bubble', v)}
                label="Bubble over the mascot"
              />
            </Row>
            <Row label="Full-screen card" hint="the big one, centred">
              <Toggle
                dense
                on={modes.includes('overlay')}
                onChange={(v) => setMode('overlay', v)}
                label="Full-screen card"
              />
            </Row>
            <Row label="Desktop toast" hint="replaces the old system notification">
              <Toggle
                dense
                on={cfg.toastEnabled !== false}
                onChange={(v) => patch({ toastEnabled: v })}
                label="Desktop toast"
              />
            </Row>
            <span className="meta">
              Turn them all off and a sticker still fires its sound — silence it in Stickers &amp;
              sound instead.
            </span>
            <Row label="How long it stays" hint={`${((cfg.burstMs ?? 2600) / 1000).toFixed(1)}s`}>
              <Slider
                value={cfg.burstMs ?? 2600}
                min={800}
                max={8000}
                onChange={(v) => patch({ burstMs: v })}
                label="Sticker duration"
              />
            </Row>
          </section>

          <section className="config-card">
            <span className="section-label">Full-screen card</span>
            <Row label="Dim the desktop behind it" hint="the blurred backdrop">
              <Toggle
                dense
                on={cfg.overlayScrim !== false}
                onChange={(v) => patch({ overlayScrim: v })}
                label="Dim the desktop"
              />
            </Row>
            <span className="meta">
              The most intrusive thing Mochi does to your screen. Off leaves the card floating on
              its own.
            </span>
            <span className="section-label">Card size</span>
            <Pills
              options={SIZES}
              value={cfg.overlayCardSize ?? 'medium'}
              onChange={(v) => patch({ overlayCardSize: v })}
            />
          </section>

          <section className="config-card">
            <span className="section-label">Desktop toast</span>
            <span className="meta">
              Drawn by Mochi rather than by Windows, so it carries the mascot and obeys the settings
              here instead of the system&apos;s notification rules. It shows even when the mascot
              itself is hidden.
            </span>
            <span className="section-label">Corner</span>
            <Pills
              options={ANCHORS}
              value={cfg.toastAnchor ?? 'bottom-right'}
              onChange={(v) => patch({ toastAnchor: v })}
            />
            <span className="section-label">Size</span>
            <Pills
              options={SIZES}
              value={cfg.toastSize ?? 'medium'}
              onChange={(v) => patch({ toastSize: v })}
            />
          </section>

          <section className="config-card">
            <span className="section-label">Speech bubble</span>
            <Pills
              options={[
                { value: 'soft' as const, label: 'soft' },
                { value: 'square' as const, label: 'square' },
                { value: 'none' as const, label: 'none' }
              ]}
              value={cfg.bubbleStyle}
              onChange={(v) => patch({ bubbleStyle: v })}
            />
            <span className="meta">
              Shape of the bubble above the mascot. Duration is shared with the other surfaces —
              set it under <span className="mono">Where a sticker shows up</span>. The full-screen
              card clears a little sooner than the rest; it is the loudest of the three.
            </span>
          </section>
        </div>
      </div>
    </>
  )
}
