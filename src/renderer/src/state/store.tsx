import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import type { MascotState } from '@shared/types'
import { DEFAULT_AGENTS, DEFAULT_RULES, DEFAULT_SESSIONS, DEFAULT_SETTINGS } from '@shared/defaults'
import { BUBBLE_LINES, SETTINGS_SCREENS } from './screens'
import { StoreCtx, type Action, type State, type Store } from './context'

const initial: State = {
  ready: false,
  screen: 'new',
  settings: DEFAULT_SETTINGS,
  agents: DEFAULT_AGENTS,
  sessions: DEFAULT_SESSIONS,
  rules: DEFAULT_RULES,
  library: null,
  server: null,
  activeSessionId: DEFAULT_SESSIONS[0]?.id ?? '',
  mascotState: 'idle',
  mascotNote: 'waiting on you',
  pinOpen: true,
  recOpen: true,
  menuOpen: false,
  mentionOpen: false,
  newAgentId: DEFAULT_SETTINGS.defaultAgentId,
  newSessionType: DEFAULT_SETTINGS.defaultSessionType,
  burst: null
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ready':
      return { ...state, ...action.payload, ready: true }
    case 'screen':
      // Any navigation closes the account popover, per the interaction table.
      return { ...state, screen: action.screen, menuOpen: false }
    case 'settings':
      return { ...state, settings: { ...state.settings, ...action.patch } }
    case 'mascot-config':
      return {
        ...state,
        settings: { ...state.settings, mascot: { ...state.settings.mascot, ...action.patch } }
      }
    case 'agents':
      return { ...state, agents: action.agents }
    case 'sessions':
      return { ...state, sessions: action.sessions }
    case 'rules':
      return { ...state, rules: action.rules }
    case 'library':
      return { ...state, library: action.library }
    case 'active':
      return { ...state, activeSessionId: action.id }
    case 'mascot-state':
      return { ...state, mascotState: action.state, mascotNote: action.note ?? state.mascotNote }
    case 'toggle':
      return { ...state, [action.key]: action.value ?? !state[action.key] }
    case 'new-agent':
      return { ...state, newAgentId: action.id }
    case 'new-type':
      return { ...state, newSessionType: action.value }
    case 'burst':
      return { ...state, burst: action.burst }
    default:
      return state
  }
}

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initial)
  const burstId = useRef(0)

  const reloadLibrary = useCallback(() => {
    const preset =
      state.agents.find((a) => a.id === state.settings.defaultAgentId)?.spritePreset ?? 'sprout'
    void window.mochi?.library(preset).then((library) => dispatch({ type: 'library', library }))
  }, [state.agents, state.settings.defaultAgentId])

  // Boot: pull persisted state and the asset library from main.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!window.mochi) return
      const boot = await window.mochi.bootstrap()
      if (cancelled) return
      const preset =
        boot.agents.find((a) => a.id === boot.settings.defaultAgentId)?.spritePreset ?? 'sprout'
      const library = await window.mochi.library(preset)
      if (cancelled) return
      dispatch({
        type: 'ready',
        payload: {
          settings: boot.settings,
          agents: boot.agents,
          sessions: boot.sessions,
          rules: boot.rules,
          server: boot.server,
          library,
          activeSessionId: boot.sessions[0]?.id ?? '',
          newAgentId: boot.settings.defaultAgentId,
          newSessionType: boot.settings.defaultSessionType
        }
      })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Persist on change, but not during boot — that would immediately rewrite the
  // file we just read with the pre-boot defaults.
  useEffect(() => {
    if (!state.ready) return
    void window.mochi?.saveState({
      settings: state.settings,
      agents: state.agents,
      sessions: state.sessions,
      rules: state.rules
    })
  }, [state.ready, state.settings, state.agents, state.sessions, state.rules])

  // Theme + contrast + accent are applied to the root, and the Windows caption
  // buttons are recoloured to match so they don't sit in a mismatched strip.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = state.settings.theme
    root.dataset.contrast = state.settings.contrast
    root.style.setProperty('--ac', state.settings.accent)
    const bg = state.settings.theme === 'dark' ? '#191c20' : '#f3f0ea'
    const sym = state.settings.theme === 'dark' ? '#9c9a95' : '#6b6660'
    void window.mochi?.setTitleBarTheme(state.settings.theme, bg, sym)
  }, [state.settings.theme, state.settings.contrast, state.settings.accent])

  const agentById = useCallback(
    (id: string) => state.agents.find((a) => a.id === id),
    [state.agents]
  )

  const stickerSrc = useCallback(
    (id: string | null) =>
      id ? (state.library?.stickers.find((s) => s.id === id || s.name === id)?.src ?? null) : null,
    [state.library]
  )

  const soundSrc = useCallback(
    (id: string | null) =>
      id ? (state.library?.sounds.find((s) => s.id === id || s.name === id)?.src ?? null) : null,
    [state.library]
  )

  const spriteSrc = useCallback(
    (s: MascotState) => state.library?.sprites.find((sp) => sp.state === s)?.src ?? null,
    [state.library]
  )

  const fireSticker = useCallback<Store['fireSticker']>(
    (opts = {}) => {
      const modes = opts.modes ?? state.settings.mascot.stickerModes
      burstId.current += 1
      dispatch({
        type: 'burst',
        burst: {
          id: burstId.current,
          stickerSrc: stickerSrc(opts.stickerId ?? null),
          soundSrc: soundSrc(null),
          modes,
          caption: opts.caption ?? BUBBLE_LINES[burstId.current % BUBBLE_LINES.length]
        }
      })
    },
    [state.settings.mascot.stickerModes, stickerSrc, soundSrc]
  )

  // Agent-driven events: sendSticker()/setMascotState() from Mastra tools, and
  // the asset watcher. This is what makes the mascot react to the agent.
  useEffect(() => {
    if (!window.mochi) return
    const offSticker = window.mochi.onStickerFired((p) => {
      const rule = state.rules.find((r) => r.event === p.event && r.enabled)
      fireSticker({
        stickerId: p.stickerId ?? rule?.stickerId ?? null,
        caption: p.caption,
        modes: rule ? [rule.showAs] : undefined
      })
    })
    const offState = window.mochi.onMascotState((p) =>
      dispatch({ type: 'mascot-state', state: p.state, note: p.note })
    )
    const offLib = window.mochi.onLibraryChanged(() => reloadLibrary())
    return () => {
      offSticker()
      offState()
      offLib()
    }
  }, [state.rules, fireSticker, reloadLibrary])

  const value = useMemo<Store>(
    () => ({
      ...state,
      dispatch,
      inSettings: SETTINGS_SCREENS.includes(state.screen),
      activeSession: state.sessions.find((s) => s.id === state.activeSessionId),
      agentById,
      stickerSrc,
      soundSrc,
      spriteSrc,
      fireSticker,
      reloadLibrary
    }),
    [state, agentById, stickerSrc, soundSrc, spriteSrc, fireSticker, reloadLibrary]
  )

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}
