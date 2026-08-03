import { Search, Volume2, VolumeX, Sun, Moon, Eye, EyeOff } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { KEYS } from '@renderer/lib/platform'

/**
 * 46px title bar.
 *
 * The prototype drew macOS traffic lights on the left. On Windows we let the OS
 * draw real caption buttons via titleBarOverlay and reserve --overlay-w at the
 * right end so the avatar and icon buttons never sit underneath them.
 *
 * Empty regions are draggable; every control inside is explicitly no-drag.
 */
export function TitleBar(): React.JSX.Element {
  const { settings, dispatch, server } = useStore()
  const isMac = navigator.platform.toLowerCase().includes('mac')

  const iconBtn = (
    onClick: () => void,
    label: string,
    active: boolean,
    children: React.ReactNode
  ): React.JSX.Element => (
    <button
      className="tb-icon"
      data-on={active}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  )

  return (
    <div className="titlebar">
      <div className="tb-left">
        {isMac && <div className="tb-lights" aria-hidden />}
        <span className="tb-wordmark">Mochi</span>
        <span className="tb-version mono">
          {server ? `${server.appVersion} · mastra ${server.mastraVersion}` : 'starting…'}
        </span>
      </div>

      <div className="tb-center">
        <button className="tb-search" aria-label="Search agents, tools, stickers">
          <Search size={13} strokeWidth={1.8} />
          <span>Search agents, tools, stickers…</span>
          <span className="chip">{KEYS.search()}</span>
        </button>
      </div>

      <div className="tb-right">
        {iconBtn(
          () => dispatch({ type: 'settings', patch: { sound: !settings.sound } }),
          settings.sound ? 'Mute sound' : 'Unmute sound',
          settings.sound,
          settings.sound ? (
            <Volume2 size={15} strokeWidth={1.8} />
          ) : (
            <VolumeX size={15} strokeWidth={1.8} />
          )
        )}
        {iconBtn(
          () =>
            dispatch({
              type: 'settings',
              patch: { theme: settings.theme === 'dark' ? 'light' : 'dark' }
            }),
          settings.theme === 'dark' ? 'Switch to light' : 'Switch to dark',
          false,
          settings.theme === 'dark' ? (
            <Moon size={15} strokeWidth={1.8} />
          ) : (
            <Sun size={15} strokeWidth={1.8} />
          )
        )}
        {iconBtn(
          () => dispatch({ type: 'mascot-config', patch: { visible: !settings.mascot.visible } }),
          `${settings.mascot.visible ? 'Hide' : 'Show'} mascot (${KEYS.hideMascot()})`,
          settings.mascot.visible,
          settings.mascot.visible ? (
            <Eye size={15} strokeWidth={1.8} />
          ) : (
            <EyeOff size={15} strokeWidth={1.8} />
          )
        )}
        <div className="tb-avatar" aria-hidden />
      </div>
    </div>
  )
}
