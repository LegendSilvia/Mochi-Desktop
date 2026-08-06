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
 *
 * Sync here is one-directional by assumption, not by construction: nothing this
 * window renders dispatches an action that touches the persisted slice
 * (settings/agents/sessions/rules), so `sync` only ever flows main → overlay and
 * the two windows never write at once. The store's guard is built for the
 * general case, but the concurrent-write half of it has never actually run. The
 * first feature that lets the overlay persist anything — remembering a dragged
 * position is the obvious candidate; note it currently goes to localStorage, not
 * the store — makes both windows writers, and needs that path reviewed before it
 * ships: last write wins on a whole-slice save, so a save from here would carry
 * whatever this window last received and quietly undo an unrelated change made
 * in the app window in between.
 */
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <StoreProvider>
      <MascotLayer overlay />
    </StoreProvider>
  </StrictMode>
)
