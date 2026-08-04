import type { AgentLoadout, AppSettings, Session } from '@shared/types'
import type { Screen } from './screens'

/**
 * Tours: the reusable slide modal behind first-run setup and, later, any
 * feature hint.
 *
 * A step is data, not a component — adding a hint means adding an object here,
 * not writing another modal. Two presentation modes fall out of one field:
 * a step with a `goto` needs the user to *do* something, so the card docks to a
 * corner and the app stays interactive; a step without one is a plain centred
 * modal.
 */

/** Everything a step predicate is allowed to look at. */
export interface TourSnapshot {
  agents: AgentLoadout[]
  sessions: Session[]
  settings: AppSettings
}

export interface TourStep {
  title: string
  body: string
  /** Renders an extra interactive control inside the card. */
  field?: 'name'
  /** Navigate here when the step opens. Presence of this means docked mode. */
  goto?: Screen
  /** Next stays locked until this returns true. Absent means always unlocked. */
  requires?: (s: TourSnapshot) => boolean
  /** Shown beside the spinner while `requires` is unmet. */
  waiting?: string
}

export interface Tour {
  id: string
  steps: TourStep[]
}

const FIRST_RUN: Tour = {
  id: 'first-run',
  steps: [
    {
      title: 'What should I call you?',
      body: 'Your agents will use this when they talk to you. You can change it later in Settings.',
      field: 'name'
    },
    {
      title: 'Make your first agent',
      body:
        'An agent is a loadout — a name, a model, instructions and the tools it may use. ' +
        'Hit "New loadout" to build one.',
      goto: 'agents',
      requires: (s) => s.agents.length > 0,
      waiting: 'waiting for your first agent…'
    },
    {
      title: 'Start a session',
      body:
        'Pick your agent, choose a session type, and type the first message. ' +
        'That is the whole loop.',
      goto: 'new',
      requires: (s) => s.sessions.length > 0,
      waiting: 'waiting for your first session…'
    }
  ]
}

/** Every tour, in the order they are offered. First unseen one wins. */
export const TOURS: Tour[] = [FIRST_RUN]
