import { useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { TOURS, type TourSnapshot } from '@renderer/state/tours'
import './tour.css'

/**
 * The slide modal behind first-run setup and any future feature hint.
 *
 * Docked mode is what makes a guided step possible: the backdrop goes away and
 * the card shrinks into the corner, so the user can actually use the screen the
 * step is telling them about. It docks bottom-*left* because the mascot overlay
 * is a separate always-on-top window sitting bottom-right.
 */
export function TourLayer(): React.JSX.Element | null {
  const { tour, agents, sessions, settings, dispatch } = useStore()
  const [name, setName] = useState('')

  // This component is mounted unconditionally by App and only ever *renders* as
  // null, so it never unmounts and the draft would otherwise outlive the tour
  // that collected it — type a name, Skip, then Replay, and the abandoned value
  // is still sitting in the field. Clearing it during render rather than from an
  // effect is React's own recipe for resetting state when an input changes: it
  // re-renders before anything is painted, where an effect would flash the old
  // value first. Above the early return, because hooks may not be skipped.
  const [drafted, setDrafted] = useState(tour?.id)
  if (drafted !== tour?.id) {
    setDrafted(tour?.id)
    setName('')
  }

  const def = TOURS.find((t) => t.id === tour?.id)
  const step = tour && def ? def.steps[tour.step] : undefined
  if (!tour || !def || !step) return null

  const snapshot: TourSnapshot = { agents, sessions, settings }
  const locked = step.requires ? !step.requires(snapshot) : false
  const docked = Boolean(step.goto)
  const last = tour.step === def.steps.length - 1

  const close = (): void => {
    dispatch({
      type: 'settings',
      // Deduped: close() can run twice (Skip on the last step), and a repeated id
      // would grow the list without changing what it means.
      patch: { toursSeen: [...new Set([...settings.toursSeen, tour.id])] }
    })
    dispatch({ type: 'tour-end' })
  }

  const next = (): void => {
    // Committed on Next, not per keystroke, so an abandoned step leaves nothing.
    // Only when non-empty: the field starts blank on every run of the tour, and
    // treating that as "clear my name" would silently wipe a name already set.
    if (step.field === 'name' && name.trim()) {
      dispatch({ type: 'settings', patch: { userName: name.trim() } })
    }
    if (last) close()
    else dispatch({ type: 'tour-step', step: tour.step + 1 })
  }

  const card = (
    <div className="tour-card" role="dialog" aria-modal={!docked} aria-label={step.title}>
      <div className="tour-head">
        <div className="tour-dots" aria-label={`Step ${tour.step + 1} of ${def.steps.length}`}>
          {def.steps.map((_, i) => (
            <span key={i} className="tour-dot" data-on={i === tour.step} />
          ))}
        </div>
        <button className="pill-ghost tiny" onClick={close}>
          Skip
        </button>
      </div>

      <h2 className="tour-title">{step.title}</h2>
      <p className="tour-body">{step.body}</p>

      {step.field === 'name' && (
        <input
          className="field-input"
          value={name}
          placeholder={settings.userName || 'your name'}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // Same guard as the Next button, which is `disabled={locked}` — the
            // keyboard must not be a way around a step's `requires`.
            if (e.key === 'Enter' && !locked) next()
          }}
        />
      )}

      <div className="tour-foot">
        {locked && (
          <span className="tour-waiting meta">
            <Loader2 size={13} strokeWidth={1.9} className="tour-spin" />
            {step.waiting}
          </span>
        )}
        <span className="tour-spacer" />
        {tour.step > 0 && (
          <button className="pill-ghost" onClick={() => dispatch({ type: 'tour-step', step: tour.step - 1 })}>
            Back
          </button>
        )}
        <button className="pill-primary" disabled={locked} onClick={next}>
          {last ? 'Done' : 'Next'}
          {!last && <ArrowRight size={14} strokeWidth={2.2} />}
        </button>
      </div>
    </div>
  )

  if (docked) return <div className="tour-dock">{card}</div>

  return (
    <div className="tour-backdrop" role="presentation">
      {card}
    </div>
  )
}
