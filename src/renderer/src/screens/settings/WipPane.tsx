import { useStore } from '@renderer/state/context'
import type { Screen } from '@renderer/state/screens'
import { ArtPlaceholder, ScreenHeader } from '@renderer/components/ui/Controls'

const COPY: Record<string, { title: string; body: string; chips: string[]; tasks: string }> = {
  workflows: {
    title: 'Workflows',
    body:
      'A graph editor for defined, multi-step processes — branch, parallel, loop, suspend and ' +
      'resume, with a human-in-the-loop step that asks through the mascot rather than a modal.',
    chips: ['control flow', 'snapshots', 'suspend & resume', 'time travel', 'scheduled'],
    tasks: 'M5-01 … M5-11'
  },
  browser: {
    title: 'Browser',
    body:
      'A live view of what the agent is doing in a browser — the page it is on, what it clicked, ' +
      'and a recording you can scrub back through when something goes wrong.',
    chips: ['AgentBrowser', 'BrowserViewer', 'Stagehand', 'Firecrawl', 'recording'],
    tasks: 'M15-01 … M15-05'
  },
  ops: {
    title: 'Traces & evals',
    body:
      'Where a run went, what it cost, and whether it was any good — traces and logs on one side, ' +
      'scorers and datasets on the other.',
    chips: ['tracing', 'logging', 'metrics', 'scorers', 'datasets', 'trace intelligence'],
    tasks: 'M14-01 … M14-14'
  }
}

/**
 * WIP screens: drafted in the design, deliberately not built.
 *
 * These say plainly what they will be and which tasks cover them, rather than
 * showing a fake UI that looks finished.
 */
export function WipPane({ screen }: { screen: Screen }): React.JSX.Element {
  const { spriteSrc } = useStore()
  const copy = COPY[screen] ?? COPY.workflows
  const sprite = spriteSrc('sleeping') ?? spriteSrc('idle')

  return (
    <>
      <ScreenHeader title={copy.title} subtitle="Drafted, not built yet." />
      <div className="screen-body wip-pane">
        <div className="wip-sprite mo-idle-float">
          {sprite ? <img src={sprite} alt="" /> : <ArtPlaceholder size={104} />}
        </div>
        <span className="badge wip">wip</span>
        <h2 className="wip-title">{copy.title}</h2>
        <p className="wip-body">{copy.body}</p>
        <div className="pills wip-chips">
          {copy.chips.map((c) => (
            <span className="chip" key={c}>
              {c}
            </span>
          ))}
        </div>
        <span className="meta">
          Tracked as <span className="mono">{copy.tasks}</span> in TASKS.md
        </span>
      </div>
    </>
  )
}
