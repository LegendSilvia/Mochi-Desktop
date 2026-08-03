import { ScreenHeader } from '@renderer/components/ui/Controls'
import { useStore } from '@renderer/state/context'

type Status = 'ready' | 'wip' | 'planned' | 'n/a'

const COVERAGE: Array<{ area: string; home: string; tasks: string; status: Status }> = [
  {
    area: 'Agents: overview, tools',
    home: 'Agents & loadouts',
    tasks: 'M2-01..06',
    status: 'ready'
  },
  {
    area: 'Agents: supervisor, delegation',
    home: 'Session @mention',
    tasks: 'M2-08..10',
    status: 'wip'
  },
  {
    area: 'Agents: guardrails, processors, code mode',
    home: 'Agent config',
    tasks: 'M2-11..13',
    status: 'planned'
  },
  {
    area: 'Agents: A2A, ACP, SDK agents',
    home: 'Agent connections',
    tasks: 'M2-16..18',
    status: 'planned'
  },
  { area: 'MCP', home: 'Tools & MCP', tasks: 'M8-02..03', status: 'planned' },
  { area: 'Workflows', home: 'Settings → Workflows', tasks: 'M5-01..11', status: 'wip' },
  { area: 'Memory', home: 'Settings → Memory', tasks: 'M4-01..07', status: 'ready' },
  { area: 'Agent Controller', home: 'Session', tasks: 'M3-02..06', status: 'wip' },
  { area: 'Workspaces', home: 'Workspace access', tasks: 'M6-01..08', status: 'planned' },
  { area: 'Browser', home: 'Settings → Browser', tasks: 'M15-01..05', status: 'wip' },
  { area: 'Channels', home: 'Settings → Channels', tasks: 'M9-01..12', status: 'planned' },
  { area: 'RAG', home: 'RAG & sources', tasks: 'M7-01..06', status: 'planned' },
  { area: 'Voice', home: 'Settings → Voice', tasks: 'M10-01..07', status: 'planned' },
  {
    area: 'Long-running agents',
    home: 'Goals & schedules',
    tasks: 'M11-01..08',
    status: 'planned'
  },
  { area: 'Storage', home: 'Settings → Storage', tasks: 'M13-01..05', status: 'ready' },
  { area: 'Models & providers', home: 'Models & providers', tasks: 'M12-01..10', status: 'ready' },
  { area: 'Observability & evals', home: 'Traces & evals', tasks: 'M14-01..14', status: 'wip' },
  { area: 'Streaming', home: 'Session render', tasks: 'M3-07', status: 'ready' },
  { area: 'Server auth (14 providers)', home: '—', tasks: '—', status: 'n/a' },
  { area: 'Studio / Agent Builder / Editor', home: '—', tasks: '—', status: 'n/a' },
  { area: 'Cloud deployment', home: '—', tasks: '—', status: 'n/a' },
  { area: 'Multi-user threads', home: '—', tasks: 'M4-08', status: 'n/a' }
]

const ASSUMPTIONS = [
  'Loadout is the agent. There is no separate mascot entity to manage.',
  'The renderer reaches Mastra over HTTP on an embedded server, not IPC — that is what gives us streaming and tool-call parts for free.',
  'The embedded server binds to a free port chosen at runtime. 4111 is never assumed available.',
  'Scratch sessions get no memory thread, so nothing is written for them.',
  'API keys live in the OS credential store. If encryption is unavailable, Mochi refuses to save rather than writing plaintext.',
  'VOICEVOX was skipped in this build. It is a local HTTP TTS service on port 50021, not an MCP server — wiring it means an HTTP client and a running local process to test against.'
]

/** Design notes & coverage — the map of every Mastra area to where it landed. */
export function NotesPane(): React.JSX.Element {
  const { server } = useStore()

  return (
    <>
      <ScreenHeader
        title="Design notes & coverage"
        subtitle="What was assumed, what is built, and what is still open."
      />
      <div className="screen-body">
        <section className="config-card">
          <span className="section-label">Assumptions</span>
          <ul className="note-list">
            {ASSUMPTIONS.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>

        <section className="config-card">
          <span className="section-label">Runtime</span>
          <div className="kv">
            <span className="meta">Mastra</span>
            <span className="mono">{server?.mastraVersion ?? 'not running'}</span>
          </div>
          <div className="kv">
            <span className="meta">Server</span>
            <span className="mono">{server?.baseUrl ?? '—'}</span>
          </div>
        </section>

        <section className="config-card">
          <span className="section-label">Mastra coverage</span>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Where it landed</th>
                  <th>Tasks</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {COVERAGE.map((c) => (
                  <tr key={c.area}>
                    <td>{c.area}</td>
                    <td>{c.home}</td>
                    <td className="mono">{c.tasks}</td>
                    <td>
                      <span className={`status status-${c.status.replace('/', '')}`}>
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="meta">
            The full 197-task backlog lives in TASKS.md at the repo root.
          </span>
        </section>
      </div>
    </>
  )
}
