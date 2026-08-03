import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StoreProvider } from './state/store'
import { MascotLayer } from './components/mascot/MascotLayer'
import './styles/tokens.css'
import './components/mascot/mascot.css'
// Last: it undoes the opaque body background tokens.css sets, which would
// otherwise paint a solid sheet across the whole desktop.
import './styles/overlay.css'

/**
 * Entry point for the overlay window.
 *
 * Reuses the same store as the app window, so the mascot reads the same
 * settings and receives the same sticker and state events over IPC — the two
 * windows stay in step without a second source of truth.
 */
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <StoreProvider>
      <MascotLayer overlay />
    </StoreProvider>
  </StrictMode>
)
