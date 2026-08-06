import { ChevronUp } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { KEYS } from '@renderer/lib/platform'

export function AccountPopover({ sessionCount }: { sessionCount: number }): React.JSX.Element {
  const { menuOpen, dispatch, settings } = useStore()
  const name = settings.userName.trim()

  const row = (label: string, onClick: () => void, kbd?: string): React.JSX.Element => (
    <button className="pop-row" onClick={onClick}>
      <span>{label}</span>
      {kbd && <span className="chip">{kbd}</span>}
    </button>
  )

  return (
    <div className="rail-footer">
      {menuOpen && (
        <div className="rail-pop" role="menu">
          <div className="pop-label mono">{(name || 'you').toLowerCase()}@localhost</div>
          {row('Settings', () => dispatch({ type: 'screen', screen: 'memory' }), KEYS.settings())}
          {row('Appearance', () => dispatch({ type: 'screen', screen: 'defaults' }))}
          {row('Sound', () => dispatch({ type: 'screen', screen: 'voice' }))}
          <div className="pop-divider" />
          {row('Design notes & coverage', () => dispatch({ type: 'screen', screen: 'notes' }))}
        </div>
      )}

      <button
        className="rail-account"
        onClick={() => dispatch({ type: 'toggle', key: 'menuOpen' })}
        aria-expanded={menuOpen}
      >
        <span className="rail-account-avatar" aria-hidden />
        <span className="rail-account-text">
          <span className="rail-account-name">{name || 'You'}</span>
          <span className="meta">local · {sessionCount} sessions</span>
        </span>
        <ChevronUp size={13} strokeWidth={1.8} data-open={menuOpen} className="rail-caret-up" />
      </button>
    </div>
  )
}
