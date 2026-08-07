import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, ShieldCheck } from 'lucide-react'
import {
  MODE_HINTS,
  MODE_LABELS,
  PERMISSION_MODES,
  nativeAutoBlocked,
  type PermissionMode
} from '@shared/permission-modes'
import './chat.css'

export interface ModePickerModel {
  id: string
  label: string
  supportsAutoMode?: boolean
}

/**
 * What this session is allowed to do, chosen where you are typing.
 *
 * Next to the composer rather than in Settings because it is a per-turn
 * decision: you switch to Plan because of the thing you are about to ask, and a
 * control two screens away would be one you never reach in time.
 *
 * Auto is the only row with a submenu. Leaving it on Native runs the Claude
 * Code classifier; naming a model instead runs Mochi's own, which is why the
 * model list is not filtered by `supportsAutoMode` — that flag is about the
 * native path, and a model being asked a question only has to answer one.
 */
export function ModePicker({
  mode,
  backend,
  models,
  currentModelId,
  classifierModel,
  onChange
}: {
  mode: PermissionMode
  backend: 'subscription' | 'mastra'
  models: ModePickerModel[]
  currentModelId: string
  classifierModel?: string
  onChange: (mode: PermissionMode, classifierModel?: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [autoOpen, setAutoOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // The one way to close the menu, shared by every path that can close it —
  // click-away, Escape, and the pill's own toggle. Closing the whole menu
  // always closes the submenu with it: otherwise `autoOpen` survives in state
  // and the Auto submenu reappears already expanded next time the pill opens,
  // with no click of its own to explain it. A single shared closer is what
  // keeps a future fourth closing path from forgetting the reset.
  const close = (): void => {
    setOpen(false)
    setAutoOpen(false)
  }

  // Click-away and Escape. Without these the menu survives navigating away from
  // it, which on an overlay-heavy screen leaves it floating over unrelated UI.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const supportsAutoMode = models.find((m) => m.id === currentModelId)?.supportsAutoMode
  const nativeBlocked = nativeAutoBlocked({ backend, supportsAutoMode })

  const pick = (next: PermissionMode, model?: string): void => {
    onChange(next, model)
    close()
  }

  const summary =
    mode === 'auto' && classifierModel
      ? `${MODE_LABELS.auto} · ${models.find((m) => m.id === classifierModel)?.label ?? 'model'}`
      : MODE_LABELS[mode]

  return (
    <div className="mode-picker" ref={root}>
      <button
        className="mode-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ShieldCheck size={12} strokeWidth={1.9} />
        {summary}
      </button>

      {open && (
        <div className="mode-menu" role="menu">
          <span className="mode-menu-head">Mode</span>
          {PERMISSION_MODES.map((m, i) => {
            const isAuto = m === 'auto'
            return (
              <div key={m} className="mode-menu-item-wrap">
                <button
                  className="mode-menu-item"
                  role="menuitem"
                  data-on={mode === m}
                  onClick={() => (isAuto ? setAutoOpen((v) => !v) : pick(m))}
                >
                  <span className="mode-menu-label">{MODE_LABELS[m]}</span>
                  <span className="meta mode-menu-hint">{MODE_HINTS[m]}</span>
                  {isAuto ? (
                    <ChevronRight size={12} strokeWidth={2} />
                  ) : mode === m ? (
                    <Check size={12} strokeWidth={2.4} />
                  ) : (
                    <span className="mode-menu-key">{i + 1}</span>
                  )}
                </button>

                {isAuto && autoOpen && (
                  <div className="mode-submenu">
                    <button
                      className="mode-menu-item"
                      role="menuitem"
                      disabled={Boolean(nativeBlocked)}
                      data-on={mode === 'auto' && !classifierModel}
                      onClick={() => pick('auto')}
                    >
                      <span className="mode-menu-label">Native (Claude Code)</span>
                      {mode === 'auto' && !classifierModel && <Check size={12} strokeWidth={2.4} />}
                    </button>
                    {nativeBlocked && <p className="meta mode-blocked">{nativeBlocked}</p>}
                    {/* Phase 1 stores this choice but nothing acts on it yet —
                        Mochi's own classifier arrives in Phase 2, and until then
                        a named model behaves as Manual. Saying so is the
                        difference between a setting that is not finished and a
                        setting that is broken. */}
                    <span className="mode-menu-head">Or a model of your own — not active yet</span>
                    {models.map((m) => (
                      <button
                        key={m.id}
                        className="mode-menu-item"
                        role="menuitem"
                        data-on={mode === 'auto' && classifierModel === m.id}
                        onClick={() => pick('auto', m.id)}
                      >
                        <span className="mode-menu-label">{m.label}</span>
                        {mode === 'auto' && classifierModel === m.id && (
                          <Check size={12} strokeWidth={2.4} />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
