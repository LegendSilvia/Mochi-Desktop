import { useEffect } from 'react'
import { StoreProvider } from './state/store'
import { useStore } from './state/context'
import { TitleBar } from './components/shell/TitleBar'
import { Rail } from './components/shell/Rail'
import { CommandPalette } from './components/shell/CommandPalette'
import { MascotLayer } from './components/mascot/MascotLayer'
import { NewSession } from './screens/NewSession'
import { Session } from './screens/Session'
import { Agents } from './screens/Agents'
import { MascotStudio } from './screens/MascotStudio'
import { Stickers } from './screens/Stickers'
import { SettingsModal } from './screens/settings/SettingsModal'
import { hasMod } from './lib/platform'
import './components/shell/shell.css'
import './screens/screens.css'

function Screens(): React.JSX.Element {
  const { screen, inSettings } = useStore()

  // Settings is a modal over the session, not a destination — so the session
  // stays mounted behind it and its stream is not torn down on open.
  const base = ((): React.JSX.Element => {
    switch (inSettings ? 'chat' : screen) {
      case 'new':
        return <NewSession />
      case 'agents':
        return <Agents />
      case 'mascot':
        return <MascotStudio />
      case 'stickers':
        return <Stickers />
      case 'chat':
      default:
        return <Session />
    }
  })()

  return (
    <>
      {base}
      {inSettings && <SettingsModal />}
    </>
  )
}

function Shortcuts(): null {
  const { dispatch, settings, fireSticker, inSettings } = useStore()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!hasMod(e)) return
      const key = e.key.toLowerCase()
      if (key === 'n') {
        e.preventDefault()
        dispatch({ type: 'screen', screen: 'new' })
      } else if (key === ',') {
        e.preventDefault()
        dispatch({ type: 'screen', screen: inSettings ? 'chat' : 'memory' })
      } else if (key === 'm' && !e.shiftKey) {
        e.preventDefault()
        dispatch({ type: 'mascot-config', patch: { visible: !settings.mascot.visible } })
      } else if (key === ';') {
        e.preventDefault()
        fireSticker()
      } else if (key === 'k') {
        e.preventDefault()
        dispatch({ type: 'toggle', key: 'searchOpen' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch, settings.mascot.visible, fireSticker, inSettings])

  return null
}

function Shell(): React.JSX.Element {
  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <Rail />
        <main className="content">
          <Screens />
        </main>
      </div>
      <MascotLayer />
      <CommandPalette />
      <Shortcuts />
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
