import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import type { PersistedState, SpriteSlot } from '@shared/types'
import { DEFAULT_AGENTS, DEFAULT_RULES, DEFAULT_SESSIONS, DEFAULT_SETTINGS } from '@shared/defaults'
import { BUBBLE_LINES, POKE_LINES, SETTINGS_SCREENS } from './screens'
import { StoreCtx, type Action, type State, type Store } from './context'
import { TOURS } from './tours'
import * as devlog from '@renderer/lib/devlog'
import { mayLeaveScreen } from '@renderer/lib/navGuard'

/**
 * Where each slot looks when it has no art of its own.
 *
 * Every chain ends at idle, but the steps matter: a mascot being dragged should
 * fall back to being held before it falls back to standing still, and a mascot
 * mid-tool should look like it is thinking rather than like it is doing nothing.
 * Only `idle` is genuinely expected to be filled in every folder.
 */
const SLOT_FALLBACK: Partial<Record<SpriteSlot, SpriteSlot>> = {
  'walk-left': 'picked',
  'walk-right': 'picked',
  'walk-up': 'picked',
  'walk-down': 'picked',
  picked: 'hover',
  hover: 'idle',
  click: 'done',
  'tool-running': 'thinking',
  thinking: 'idle',
  done: 'idle',
  error: 'idle',
  sleeping: 'idle'
}

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
  archOpen: false,
  menuOpen: false,
  mentionOpen: false,
  searchOpen: false,
  stickerPickerOpen: false,
  newAgentId: DEFAULT_SETTINGS.defaultAgentId,
  newSessionType: DEFAULT_SETTINGS.defaultSessionType,
  burst: null,
  pendingSend: null,
  tour: null
}

/** Overlays that float above the app — only one may be open at a time. */
const POPOVER_KEYS = ['menuOpen', 'mentionOpen', 'searchOpen', 'stickerPickerOpen'] as const

/**
 * The persisted slice, built in one fixed key order.
 *
 * The single constructor is the point. The persist effect decides whether to
 * write by string-comparing `JSON.stringify` of the local slice against the same
 * of the last payload received over `sync`, and `JSON.stringify` is
 * order-sensitive — two objects with the same entries in a different insertion
 * order produce different strings. Building both sides here pins the four
 * top-level keys.
 *
 * Everything below them is pinned by reference instead: `sync` stores the
 * payload's own sub-objects, so the two sides serialize the identical objects.
 * That is load-bearing — deep-cloning, normalising or rebuilding
 * `settings`/`agents`/`sessions`/`rules` on the `sync` path would break it and
 * put key-order sensitivity back in play, and the failure mode is an unbounded
 * write loop between the two windows rather than one redundant save. See the
 * note on `IPC.saveState` in src/main/ipc.ts.
 */
function toSlice(s: PersistedState): PersistedState {
  return { settings: s.settings, agents: s.agents, sessions: s.sessions, rules: s.rules }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ready': {
      const next = { ...state, ...action.payload, ready: true }
      // `activeSessionId` is picked from the bootstrap snapshot, but a `sync`
      // from the other window may have replaced the session list while boot was
      // still in flight — in which case that id points at nothing. Re-derive it
      // from whatever the sessions actually are rather than leaving the chat
      // looking at a session that isn't there. On an ordinary boot the id is
      // already present and this changes nothing.
      if (next.sessions.some((s) => s.id === next.activeSessionId)) return next
      return { ...next, activeSessionId: next.sessions[0]?.id ?? '' }
    }
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
    case 'toggle': {
      const next = action.value ?? !state[action.key]
      // Popovers are mutually exclusive: opening one closes the rest, so the
      // sticker picker can't sit on top of the mention list. Doing it here
      // rather than at each call site means a new popover can't reintroduce the
      // overlap by forgetting to close its siblings.
      if (next && (POPOVER_KEYS as readonly string[]).includes(action.key)) {
        const closed = Object.fromEntries(
          POPOVER_KEYS.filter((k) => k !== action.key).map((k) => [k, false])
        )
        return { ...state, ...closed, [action.key]: true }
      }
      return { ...state, [action.key]: next }
    }
    case 'new-agent':
      return { ...state, newAgentId: action.id }
    case 'new-type':
      return { ...state, newSessionType: action.value }
    case 'burst':
      return { ...state, burst: action.burst }
    case 'pending-send':
      return { ...state, pendingSend: action.text }
    case 'sync':
      return { ...state, ...toSlice(action.payload) }
    // Navigation lives in the reducer rather than an effect: advancing a step and
    // moving the user to the screen that step is about are one atomic change, and
    // doing it in an effect would mean a render where the two disagree.
    case 'tour-start': {
      // An id no tour defines would set `tour` to something TourLayer renders as
      // null — no card, no Skip button, and so no way left to reach 'tour-end'.
      // Refusing the action keeps an unknown id from wedging the window.
      const def = TOURS.find((t) => t.id === action.id)
      if (!def) return state
      return {
        ...state,
        tour: { id: action.id, step: 0 },
        screen: def.steps[0]?.goto ?? state.screen
      }
    }
    case 'tour-step': {
      if (!state.tour) return state
      const goto = TOURS.find((t) => t.id === state.tour?.id)?.steps[action.step]?.goto
      return {
        ...state,
        tour: { ...state.tour, step: action.step },
        screen: goto ?? state.screen
      }
    }
    case 'tour-end':
      return { ...state, tour: null }
    default:
      return state
  }
}

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, rawDispatch] = useReducer(reducer, initial)

  /*
   * Screen changes go through a veto.
   *
   * A screen holding unsaved work — the agent editor is the first — registers a
   * guard and gets the chance to stop the navigation. Doing it here rather than
   * at the call sites means every route into a screen change is covered,
   * including the ones added later; there are already nine components that
   * dispatch one.
   */
  const dispatch = useCallback<React.Dispatch<Action>>((action) => {
    if (action.type === 'screen' && !mayLeaveScreen()) return
    rawDispatch(action)
  }, [])

  const burstId = useRef(0)
  // Snapshot of what was last written or received. The persist effect compares
  // against it so state arriving over `sync` is not immediately written back —
  // a boolean flag would stay stuck if the merge produced no change.
  const lastPersisted = useRef('')
  // Whether a `sync` has already landed. The listener below is live from mount,
  // so a save in the other window can reach us *before* bootstrap resolves; that
  // payload is newer than the one boot is holding, and `ready` must not undo it.
  const synced = useRef(false)

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
      // A `sync` that landed while boot was in flight carries state newer than
      // `boot`. Seeding `ready` with the persisted slice would overwrite it with
      // the older read, and `lastPersisted` would then match that older slice —
      // so the persist effect would decline to write and the window would sit
      // stale with no way to correct itself. Hand `ready` only the fields boot
      // is the sole source of, and leave the sync's snapshot in place.
      const superseded = synced.current
      if (!superseded) lastPersisted.current = JSON.stringify(toSlice(boot))
      dispatch({
        type: 'ready',
        payload: {
          ...(superseded
            ? {}
            : {
                settings: boot.settings,
                agents: boot.agents,
                sessions: boot.sessions,
                rules: boot.rules
              }),
          server: boot.server,
          library,
          activeSessionId: boot.sessions[0]?.id ?? '',
          newAgentId: boot.settings.defaultAgentId,
          newSessionType: boot.settings.defaultSessionType
        }
      })
      // After ready, so the tour reads real persisted state rather than defaults.
      const pending = TOURS.find((t) => !(boot.settings.toursSeen ?? []).includes(t.id))
      if (pending) dispatch({ type: 'tour-start', id: pending.id })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Another window saved. Merge rather than reload, so in-flight UI state
  // (open popovers, the active tour) survives.
  useEffect(() => {
    if (!window.mochi?.onStateChanged) return
    return window.mochi.onStateChanged((next) => {
      synced.current = true
      lastPersisted.current = JSON.stringify(toSlice(next))
      devlog.push('ipc', 'stateChanged', {
        sessions: next.sessions.length,
        agents: next.agents.length
      })
      dispatch({ type: 'sync', payload: next })
    })
  }, [])

  // Arm the debug log from settings. Done here rather than in the log pane so
  // capture starts at boot — a bug you have to reproduce with the pane already
  // open is a bug you have mostly already lost.
  useEffect(() => {
    devlog.arm(state.settings.devMode === true)
  }, [state.settings.devMode])

  // Persist on change, but not during boot — that would immediately rewrite the
  // file we just read with the pre-boot defaults.
  useEffect(() => {
    if (!state.ready) return
    const slice = toSlice(state)
    const json = JSON.stringify(slice)
    if (json === lastPersisted.current) return
    lastPersisted.current = json
    devlog.push('state', 'saveState', { bytes: json.length })
    void window.mochi?.saveState(slice)
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

  /**
   * The art for a slot, falling back to idle.
   *
   * Without the fallback every unfilled slot rendered the `art?` placeholder, so
   * a mascot folder with one good drawing in it looked broken the moment the
   * agent started thinking. Idle is the one slot worth insisting on: a mascot
   * that stands still is fine, a mascot that blinks out of existence is not.
   */
  const spriteSrc = useCallback(
    (s: SpriteSlot) => {
      const sprites = state.library?.sprites
      const at = (slot: SpriteSlot): string | null =>
        sprites?.find((sp) => sp.state === slot)?.src ?? null

      // Walk the chain rather than dropping straight to idle. Dragging a mascot
      // that has `held` art but no `walk-left` looked broken: it was being
      // carried, and it flipped to standing still the moment it moved. The
      // nearest *related* pose is a better answer than the neutral one.
      let slot: SpriteSlot | undefined = s
      const seen = new Set<SpriteSlot>()
      while (slot && !seen.has(slot)) {
        const hit = at(slot)
        if (hit) return hit
        seen.add(slot)
        slot = SLOT_FALLBACK[slot]
      }
      return at('idle')
    },
    [state.library]
  )

  /*
   * What the mascot says.
   *
   * There is one mascot, so it speaks with one voice: the default agent's. Its
   * lines are generated from that agent's persona when the loadout is saved.
   * `BUBBLE_LINES` remains the fallback for a fresh install, an agent saved
   * before this existed, or a generation that failed.
   */
  const lines = useMemo(() => {
    const main = state.agents.find((a) => a.id === state.settings.defaultAgentId)
    // Blank rows are an artefact of editing the field as free text; an empty
    // string would surface as an empty bubble.
    const clean = (rows?: string[]): string[] =>
      (rows ?? []).map((l) => l.trim()).filter(Boolean)

    const finish = clean(main?.bubbleLines)
    // Poking has its own built-in fallback: borrowing the finish lines would
    // have the mascot answer "that's done" to a poke that interrupted nothing.
    const poke = clean(main?.pokeLines)
    return {
      finish: finish.length ? finish : BUBBLE_LINES,
      poke: poke.length ? poke : POKE_LINES
    }
  }, [state.agents, state.settings.defaultAgentId])

  const fireSticker = useCallback<Store['fireSticker']>(
    (opts = {}) => {
      /*
       * Where it appears follows what it is.
       *
       * A poke is a reply to you touching the mascot, so it belongs in the
       * bubble over its head — you are already looking right at it. A finished
       * turn is news you may have missed, so it belongs in the corner toast.
       * Sharing one surface put "that's handled" in a toast you had to look
       * away to receive, and put work reports over the head of a mascot you had
       * just prodded.
       */
      const modes =
        opts.modes ?? (opts.voice === 'poke' ? ['bubble'] : state.settings.mascot.stickerModes)
      burstId.current += 1
      dispatch({
        type: 'burst',
        burst: {
          id: burstId.current,
          stickerSrc: stickerSrc(opts.stickerId ?? null),
          soundSrc: soundSrc(null),
          modes,
          // A poke and a finished task are different moments, so they draw on
          // different lists. `voice` says which; an explicit caption still wins.
          caption:
            opts.caption ??
            (opts.voice === 'poke'
              ? lines.poke[burstId.current % lines.poke.length]
              : lines.finish[burstId.current % lines.finish.length])
        }
      })
    },
    [state.settings.mascot.stickerModes, stickerSrc, soundSrc, lines]
  )

  // The idle rule. It shipped in the seeded rules but nothing ever fired it, so
  // "no input for 20 minutes" never happened. Any real interaction re-arms the
  // timer; it fires once per quiet spell rather than repeating every 20 minutes,
  // because a mascot that nags on a loop stops being nice quite fast.
  useEffect(() => {
    if (!state.ready) return
    const rule = state.rules.find((r) => r.event === 'idle-20min' && r.enabled)
    if (!rule) return

    // Overridable so the behaviour can actually be exercised without waiting
    // twenty minutes; unset in normal use.
    const stored = Number(localStorage.getItem('mochi:idle-ms'))
    const wait = Number.isFinite(stored) && stored > 0 ? stored : 20 * 60 * 1000

    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        fireSticker({
          stickerId: rule.stickerId,
          caption: 'still here whenever you are',
          modes: [rule.showAs]
        })
        dispatch({ type: 'mascot-state', state: 'sleeping', note: 'resting — poke me' })
      }, wait)
    }

    const events: Array<keyof WindowEventMap> = ['keydown', 'pointerdown', 'wheel', 'focus']
    events.forEach((e) => window.addEventListener(e, arm))
    arm()
    return () => {
      clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, arm))
    }
  }, [state.ready, state.rules, fireSticker])

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
