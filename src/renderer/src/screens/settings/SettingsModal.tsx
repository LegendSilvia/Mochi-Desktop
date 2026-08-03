import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { WIP_SCREENS, type Screen } from '@renderer/state/screens'
import { ModelsPane } from './ModelsPane'
import { DefaultsPane } from './DefaultsPane'
import { MemoryPane } from './MemoryPane'
import { SimplePanes } from './SimplePanes'
import { NotesPane } from './NotesPane'
import { ToolsPane } from './ToolsPane'
import { WipPane } from './WipPane'
import './settings.css'

const NAV: Array<{ group: string; items: Array<{ key: Screen; label: string }> }> = [
  {
    group: 'You',
    items: [
      { key: 'models', label: 'Models & providers' },
      { key: 'defaults', label: 'Defaults' }
    ]
  },
  {
    group: 'Agent',
    items: [
      { key: 'memory', label: 'Memory' },
      { key: 'tools', label: 'Tools & MCP' },
      { key: 'rag', label: 'RAG & sources' }
    ]
  },
  {
    group: 'Work',
    items: [
      { key: 'workspaces', label: 'Workspace access' },
      { key: 'longrun', label: 'Goals & schedules' },
      { key: 'workflows', label: 'Workflows' },
      { key: 'browser', label: 'Browser' }
    ]
  },
  {
    group: 'Reach',
    items: [
      { key: 'channels', label: 'Channels' },
      { key: 'voice', label: 'Voice' }
    ]
  },
  {
    group: 'System',
    items: [
      { key: 'storage', label: 'Storage' },
      { key: 'ops', label: 'Traces & evals' },
      { key: 'notes', label: 'Design notes' }
    ]
  }
]

const isWip = (s: Screen): boolean => WIP_SCREENS.includes(s)

export function SettingsModal(): React.JSX.Element {
  const { screen, dispatch } = useStore()

  const close = (): void => dispatch({ type: 'screen', screen: 'chat' })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pane = ((): React.JSX.Element => {
    if (isWip(screen)) return <WipPane screen={screen} />
    switch (screen) {
      case 'models':
        return <ModelsPane />
      case 'defaults':
        return <DefaultsPane />
      case 'memory':
        return <MemoryPane />
      case 'notes':
        return <NotesPane />
      case 'tools':
        return <ToolsPane />
      default:
        return <SimplePanes screen={screen} />
    }
  })()

  return (
    <div className="settings-backdrop" onClick={close} role="presentation">
      <div
        className="settings-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <nav className="settings-nav">
          <div className="settings-nav-head">
            <span>Settings</span>
            <button className="tb-icon" onClick={close} aria-label="Close settings">
              <X size={15} strokeWidth={1.9} />
            </button>
          </div>
          <div className="settings-nav-body">
            {NAV.map((g) => (
              <div key={g.group} className="settings-group">
                <span className="section-label">{g.group}</span>
                {g.items.map((it) => (
                  <button
                    key={it.key}
                    className="settings-nav-row"
                    data-active={screen === it.key}
                    onClick={() => dispatch({ type: 'screen', screen: it.key })}
                  >
                    <span>{it.label}</span>
                    {isWip(it.key) && <span className="badge wip">wip</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>
        <div className="settings-pane">{pane}</div>
      </div>
    </div>
  )
}
