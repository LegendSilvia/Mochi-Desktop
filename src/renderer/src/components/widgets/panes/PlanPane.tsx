import { useMemo } from 'react'
import type { UIMessage } from 'ai'
import { Markdown } from '@renderer/components/chat/Markdown'
import { latestPlan } from './panelData'

/**
 * The plan this session is working to.
 *
 * Derived from the transcript rather than held in state, the way TasksPane is:
 * the transcript is already on disk, so a plan survives a restart without a
 * second copy that can disagree with it.
 *
 * The last ExitPlanMode call wins. An agent that re-plans supersedes its own
 * earlier plan, and showing both would leave the user deciding which is live.
 */
export function PlanPane({ messages }: { messages: UIMessage[] }): React.JSX.Element {
  const plan = useMemo(() => latestPlan(messages), [messages])

  if (!plan) {
    return (
      <div className="wg-empty meta">No plan yet. Switch this session to Plan and ask for one.</div>
    )
  }

  return (
    <div className="plan-pane">
      <div className="plan-pane-status meta">
        {plan.approved ? 'Approved' : 'Proposed — waiting on you'}
      </div>
      <div className="plan-pane-body">
        <Markdown text={plan.text} />
      </div>
    </div>
  )
}
