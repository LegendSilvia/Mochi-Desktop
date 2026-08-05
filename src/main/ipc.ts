import { BrowserWindow, dialog, ipcMain, Notification, nativeTheme, shell, app } from 'electron'
import type { FSWatcher } from 'chokidar'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  assignSprite,
  buildBundle,
  openBundle,
  createPreset,
  deletePreset,
  importPresetFolder,
  importSprites,
  listSpritePresets,
  readLibrary,
  removeSprite,
  renamePreset,
  watchAssets
} from './assets'
import { deleteProviderKey, load, maskKey, readProviderKeys, save, writeProviderKey } from './store'
import { getServerInfo } from './mastra-server'
import {
  applyMascotWindowConfig,
  getMascotWindow,
  listDisplays,
  setMascotFocusable,
  setMascotHitRects,
  setMascotVisible
} from './mascot-window'
import { addDocuments, embedderInfo, listDocuments, removeDocument, search } from './rag'
import { readWorkingMemory, resetRecall, writeWorkingMemory } from './recall'
import { listOpenRouterModels } from './openrouter'
import { listSubscriptionModels } from './agent-sdk-route'
import {
  destroyWorkspaces,
  diagnoseFile,
  hoverAt,
  listWorkspaceDir,
  listWorkspaceSkills,
  readWorkspaceFile,
  searchWorkspace,
  statWorkspacePath,
  writeWorkspaceFile
} from './workspace'
import {
  killAllTerminals,
  killTerminal,
  resizeTerminal,
  setTerminalEvents,
  startTerminal,
  terminalAvailable,
  terminalBacklog,
  writeTerminal
} from './terminal'
import { getPaths } from './paths'
import { basename, join } from 'node:path'
import { bus } from '../mastra/events'
import { isUserLooking, notifyIfAway, setAttentionWindow } from './attention'
import type { MascotState, ProviderAccount, SpriteSlot, Theme } from '../shared/types'

export const IPC = {
  getBootstrap: 'mochi:bootstrap',
  getLibrary: 'mochi:library',
  listPresets: 'mochi:list-presets',
  mascotInteractive: 'mochi:mascot-interactive',
  pickPaths: 'mochi:pick-paths',
  ragAdd: 'mochi:rag-add',
  ragList: 'mochi:rag-list',
  ragRemove: 'mochi:rag-remove',
  ragSearch: 'mochi:rag-search',
  ragEmbedder: 'mochi:rag-embedder',
  openrouterModels: 'mochi:openrouter-models',
  anthropicModels: 'mochi:anthropic-models',
  memoryGet: 'mochi:memory-get',
  memorySet: 'mochi:memory-set',
  readText: 'mochi:read-text',
  setMascotState: 'mochi:set-mascot-state',
  focusSession: 'mochi:focus-session',
  mascotFocusable: 'mochi:mascot-focusable',
  sendToSession: 'mochi:send-to-session',
  saveState: 'mochi:save-state',
  setTitleBarTheme: 'mochi:titlebar-theme',
  openFolder: 'mochi:open-folder',
  notify: 'mochi:notify',
  flashFrame: 'mochi:flash-frame',
  providersList: 'mochi:providers',
  providerSetKey: 'mochi:provider-set-key',
  providerDeleteKey: 'mochi:provider-delete-key',
  presetCreate: 'mochi:preset-create',
  presetRename: 'mochi:preset-rename',
  presetDelete: 'mochi:preset-delete',
  presetImport: 'mochi:preset-import',
  presetOpen: 'mochi:preset-open',
  spriteImport: 'mochi:sprite-import',
  spriteAssign: 'mochi:sprite-assign',
  spriteRemove: 'mochi:sprite-remove',
  listDisplays: 'mochi:list-displays',
  agentFinished: 'mochi:agent-finished',
  agentExport: 'mochi:agent-export',
  agentImport: 'mochi:agent-import',
  // Workspace — the folder, shared with the agent
  wsList: 'mochi:ws-list',
  wsRead: 'mochi:ws-read',
  wsWrite: 'mochi:ws-write',
  wsStat: 'mochi:ws-stat',
  wsSearch: 'mochi:ws-search',
  wsDiagnose: 'mochi:ws-diagnose',
  wsSkills: 'mochi:ws-skills',
  wsHover: 'mochi:ws-hover',
  // Terminal
  ptyStart: 'mochi:pty-start',
  ptyWrite: 'mochi:pty-write',
  ptyResize: 'mochi:pty-resize',
  ptyKill: 'mochi:pty-kill',
  ptyBacklog: 'mochi:pty-backlog',
  ptyAvailable: 'mochi:pty-available',
  // main → renderer
  libraryChanged: 'mochi:library-changed',
  stickerFired: 'mochi:sticker-fired',
  mascotState: 'mochi:mascot-state',
  approval: 'mochi:approval',
  stateChanged: 'mochi:state-changed',
  ptyData: 'mochi:pty-data',
  ptyExit: 'mochi:pty-exit'
} as const

/** Providers Mastra's model router knows, with the env var each one reads. */
const PROVIDERS: Array<Omit<ProviderAccount, 'account' | 'connected'>> = [
  // 'api key', not 'subscription': this list is the key store, and a key stored
  // here is billed per token. The subscription path does not use a key at all —
  // it runs through the Agent SDK and is toggled separately in Settings → Models.
  { id: 'anthropic', name: 'Anthropic', billedVia: 'api key', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', billedVia: 'api key', envVar: 'OPENAI_API_KEY' },
  { id: 'google', name: 'Google', billedVia: 'api key', envVar: 'GOOGLE_API_KEY' },
  { id: 'ollama', name: 'Ollama', billedVia: 'local' },
  { id: 'openrouter', name: 'OpenRouter', billedVia: 'api key', envVar: 'OPENROUTER_API_KEY' }
]

let watcher: FSWatcher | null = null

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // The agent route needs the same focus test, and it has no window of its own.
  setAttentionWindow(getWindow)

  ipcMain.handle(IPC.getBootstrap, () => ({
    ...load(),
    server: getServerInfo(),
    platform: process.platform,
    paths: getPaths()
  }))

  ipcMain.handle(IPC.getLibrary, (_e, spritePreset?: string) => readLibrary(spritePreset))

  /**
   * Read a text file back, so a diff can say which line it changed.
   *
   * The transcript only carries the tool's `old_string`, which is enough to show
   * what moved but not where it sits — line numbers need the file. Capped
   * because this exists to number a hunk, not to ship a database into the
   * renderer, and answers null rather than throwing on anything unreadable: a
   * missing file just means the diff shows without numbers.
   */
  ipcMain.handle(IPC.readText, (_e, path: string): string | null => {
    try {
      const text = readFileSync(path, 'utf-8')
      return text.length > 2_000_000 ? null : text
    } catch {
      return null
    }
  })

  /**
   * A mascot state the renderer decided, broadcast to every window.
   *
   * Sleep is worked out in the renderer — it depends on keyboard and pointer
   * activity, which only a renderer sees. But each window has its own store, so
   * each was reaching its own verdict off its own events: the overlay is
   * `focusable: false` and receives almost no keydowns, so it dozed on its own
   * schedule while the app window stayed awake, and the same mascot was asleep
   * in one window and alert in the other.
   *
   * Routing it through main puts it on the same path the agent's own state
   * changes take, so both windows hear one answer.
   */
  ipcMain.handle(IPC.setMascotState, (_e, state: MascotState, note?: string) => {
    bus.emitMascotState({ state, note })
  })

  /**
   * Bring the app forward, on the session that asked.
   *
   * The escape hatch for a command too long to read on the overlay. Approving
   * something you can only half see is worse than a click to go and read it,
   * so the mascot offers this instead of a truncated Allow.
   */
  ipcMain.handle(IPC.focusSession, (_e, sessionId: string) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    // Told after the window is up: the renderer switches session on receipt, and
    // doing it while hidden would leave the switch unseen if focus failed.
    win.webContents.send(IPC.focusSession, sessionId)
  })

  ipcMain.handle(IPC.mascotFocusable, (_e, focusable: boolean) => setMascotFocusable(focusable))

  /**
   * A message written on the desktop, handed to the window that owns the chat.
   *
   * The overlay cannot send it itself: the transcript, the transport and the
   * streaming reply all live in the app window's chat, and a turn started from
   * here would stream to nobody and save nothing. So the text is passed across
   * and the app sends it — deliberately without raising the window, since the
   * point of typing to the mascot is not having to go and find the app.
   */
  ipcMain.handle(IPC.sendToSession, (_e, sessionId: string, text: string) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.sendToSession, { sessionId, text })
  })

  ipcMain.handle(IPC.listPresets, () => listSpritePresets())

  /*
   * Mascot folder management.
   *
   * Each of these can fail on a name the filesystem rejects or a folder that
   * already exists, and a rejected promise in the renderer would surface as an
   * unhandled error rather than something the user can read. So they answer with
   * a result object and the studio shows `error` inline.
   */
  const attempt = <T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      return { ok: true, value: fn() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  ipcMain.handle(IPC.presetCreate, (_e, name: string) => attempt(() => createPreset(name)))
  ipcMain.handle(IPC.presetRename, (_e, from: string, to: string) =>
    attempt(() => renamePreset(from, to))
  )
  ipcMain.handle(IPC.presetDelete, (_e, name: string) => attempt(() => deletePreset(name)))

  ipcMain.handle(IPC.presetImport, async () => {
    const win = getWindow()
    if (!win) return { ok: false as const, error: 'No window' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Pick a folder of mascot art'
    })
    if (canceled || !filePaths[0]) return { ok: false as const, error: 'cancelled' }
    return attempt(() => importPresetFolder(filePaths[0]))
  })

  ipcMain.handle(IPC.presetOpen, (_e, preset: string) =>
    shell.openPath(join(getPaths().sprites, basename(preset)))
  )

  ipcMain.handle(
    IPC.spriteImport,
    (_e, preset: string, files: Array<{ name: string; bytes: Uint8Array }>) =>
      attempt(() => importSprites(preset, files))
  )
  ipcMain.handle(IPC.spriteAssign, (_e, preset: string, state: SpriteSlot, file: string | null) =>
    attempt(() => assignSprite(preset, state, file))
  )
  ipcMain.handle(IPC.spriteRemove, (_e, preset: string, file: string) =>
    attempt(() => removeSprite(preset, file))
  )

  /**
   * Persist, then tell the *other* windows.
   *
   * The overlay is a second window with its own store, seeded once at mount —
   * without this broadcast every settings change (mascot visibility, shell, size,
   * theme, accent) sat unseen there until the app was restarted.
   *
   * INVARIANT — a receiving renderer decides whether to write back by
   * string-comparing `JSON.stringify` of its own slice against the same of this
   * payload (see `toSlice` in src/renderer/src/state/store.tsx). That comparison
   * holds because the receiver stores this payload's own sub-objects **by
   * reference**: both sides of the compare end up serializing the identical
   * objects, so key order — here or nested — cannot make them differ.
   *
   * So the constraint that matters is on the *renderer* side, not this one: the
   * `sync` reducer must keep the payload's sub-objects as-is. Any deep clone,
   * normalisation, or field-by-field rebuild on that path breaks reference
   * sharing and puts key-order sensitivity back in play. Nothing is required of
   * `save()` here beyond returning the state it just stored.
   *
   * Getting that wrong is not one extra write. A payload that no longer compares
   * equal makes the receiver save it straight back, which broadcasts to the
   * original sender, which does the same — an unbounded ping-pong, each hop a
   * synchronous writeFileSync of the entire state. Excluding the sender below
   * does not prevent it: the loop runs *between* the two windows, and each hop
   * has a legitimately different sender.
   */
  ipcMain.handle(IPC.saveState, (e, patch) => {
    const next = save(patch)
    for (const win of [getWindow(), getMascotWindow()]) {
      if (!win || win.isDestroyed()) continue
      // Skip the sender: it already has this state, and echoing it back is how
      // a save loop starts.
      if (win.webContents.id === e.sender.id) continue
      win.webContents.send(IPC.stateChanged, next)
    }
    setMascotVisible(next.settings.mascot.visible)
    // Monitor and always-on-top level are window properties the renderer cannot
    // touch, so they are re-applied here from whatever was just persisted.
    applyMascotWindowConfig()
    // Recall memories are built per agent from the loadout's own settings and
    // the embedding model, and both live in what was just saved — so a memory
    // built a moment ago may already be answering with the wrong topK, the
    // wrong scope, or an embedder the user has since replaced.
    resetRecall()
    return next
  })

  ipcMain.handle(IPC.listDisplays, () => listDisplays())

  /** Write a loadout and its mascot art out as one shareable file. */
  ipcMain.handle(
    IPC.agentExport,
    async (_e, agent: Record<string, unknown>, preset: string, suggested: string) => {
      const win = getWindow()
      if (!win) return { ok: false as const, error: 'No window' }
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Export agent',
        defaultPath: `${suggested || 'agent'}.mochi-agent.json`,
        filters: [{ name: 'Mochi agent', extensions: ['json'] }]
      })
      if (canceled || !filePath) return { ok: false as const, error: 'cancelled' }
      return attempt(() => {
        writeFileSync(filePath, JSON.stringify(buildBundle(agent, preset), null, 2), 'utf8')
        return filePath
      })
    }
  )

  /** Read one back. The art lands in a new mascot folder; the loadout is handed
   *  to the renderer, which owns id uniqueness. */
  ipcMain.handle(IPC.agentImport, async () => {
    const win = getWindow()
    if (!win) return { ok: false as const, error: 'No window' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import agent',
      properties: ['openFile'],
      filters: [{ name: 'Mochi agent', extensions: ['json'] }]
    })
    if (canceled || !filePaths[0]) return { ok: false as const, error: 'cancelled' }
    return attempt(() => openBundle(readFileSync(filePaths[0], 'utf8')))
  })

  /**
   * "The agent finished while you were elsewhere."
   *
   * The focus test lives here because only main can answer it: the overlay is a
   * `focusable: false` window, so `document.hasFocus()` there is always false
   * and the renderer cannot tell being-in-the-background from being-the-overlay.
   *
   * Emitting through the sticker bus rather than a bespoke channel means it
   * reaches the overlay by the same path every other sticker takes, and obeys
   * the same surface settings.
   */
  ipcMain.handle(IPC.agentFinished, (_e, caption?: string) => {
    return notifyIfAway('task-finished', caption || 'done — that one is finished')
  })

  ipcMain.handle(IPC.setTitleBarTheme, (_e, theme: Theme, bg: string, symbol: string) => {
    const win = getWindow()
    if (!win) return
    nativeTheme.themeSource = theme
    // Windows draws the real caption buttons; recolour them so they follow the
    // app theme instead of sitting in a mismatched strip (M0-15).
    if (process.platform === 'win32') {
      try {
        win.setTitleBarOverlay({ color: bg, symbolColor: symbol, height: 46 })
      } catch {
        // setTitleBarOverlay throws if the window wasn't created with titleBarOverlay
      }
    }
  })

  ipcMain.handle(IPC.openFolder, (_e, which: 'sprites' | 'stickers' | 'sounds') => {
    return shell.openPath(getPaths()[which])
  })

  ipcMain.handle(IPC.notify, (_e, title: string, body: string, iconPath?: string) => {
    if (!Notification.isSupported()) return
    new Notification({ title, body, icon: iconPath }).show()
  })

  ipcMain.handle(IPC.flashFrame, () => {
    const win = getWindow()
    if (win && !win.isFocused()) win.flashFrame(true)
  })

  ipcMain.handle(IPC.providersList, (): ProviderAccount[] => {
    const keys = readProviderKeys()
    return PROVIDERS.map((p) => {
      const stored = p.envVar ? keys[p.envVar] : undefined
      return {
        ...p,
        account: stored ? maskKey(stored) : null,
        connected: p.billedVia === 'local' ? true : Boolean(stored)
      }
    })
  })

  ipcMain.handle(IPC.providerSetKey, (_e, providerId: string, key: string) => {
    const provider = PROVIDERS.find((p) => p.id === providerId)
    if (!provider?.envVar) return { ok: false, reason: 'Unknown provider' }
    const result = writeProviderKey(provider.envVar, key)
    if (result.ok) process.env[provider.envVar] = key
    return result
  })

  ipcMain.handle(IPC.providerDeleteKey, (_e, providerId: string) => {
    const provider = PROVIDERS.find((p) => p.id === providerId)
    if (!provider?.envVar) return
    deleteProviderKey(provider.envVar)
    delete process.env[provider.envVar]
  })

  /**
   * Where the overlay should catch the mouse.
   *
   * The renderer reports rects rather than a boolean now: main polls the cursor
   * against them, because the old scheme needed mouse-event forwarding through a
   * full-screen transparent window and that is what made the cursor flicker
   * across the entire desktop. See mascot-window.ts.
   */
  ipcMain.handle(
    IPC.mascotInteractive,
    (_e, rects: Array<{ x: number; y: number; w: number; h: number }>, locked: boolean) => {
      setMascotHitRects(Array.isArray(rects) ? rects : [], Boolean(locked))
    }
  )

  /** Native picker for the composer's attach and workspace buttons. Returns the
   *  chosen paths, or an empty list when the user cancels. */
  ipcMain.handle(IPC.pickPaths, async (_e, kind: 'file' | 'folder') => {
    const win = getWindow()
    if (!win) return []
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']
    })
    return canceled ? [] : filePaths
  })

  /*
   * The folder, as the widgets see it.
   *
   * Every one of these goes through the same Mastra Workspace the agent's file
   * tools use, so the navigator cannot show you a tree the agent cannot reach,
   * and a save here collides with an agent edit rather than silently winning.
   * Each answers with a value or an `{ error }` object; none reject, because a
   * missing folder is an ordinary state for a fresh session rather than a fault.
   */
  ipcMain.handle(IPC.wsList, (_e, folder: string, path?: string) => listWorkspaceDir(folder, path))
  ipcMain.handle(IPC.wsRead, (_e, folder: string, path: string) => readWorkspaceFile(folder, path))
  ipcMain.handle(
    IPC.wsWrite,
    (_e, folder: string, path: string, content: string, expectedMtime?: number | null) =>
      writeWorkspaceFile(folder, path, content, expectedMtime)
  )
  ipcMain.handle(IPC.wsStat, (_e, folder: string, path: string) => statWorkspacePath(folder, path))
  ipcMain.handle(IPC.wsSearch, (_e, folder: string, query: string) =>
    searchWorkspace(folder, query)
  )
  ipcMain.handle(IPC.wsDiagnose, (_e, folder: string, path: string, content: string) =>
    diagnoseFile(folder, path, content)
  )
  ipcMain.handle(IPC.wsSkills, (_e, folder: string) => listWorkspaceSkills(folder))
  ipcMain.handle(
    IPC.wsHover,
    (_e, folder: string, path: string, line: number, character: number) =>
      hoverAt(folder, path, line, character)
  )

  /*
   * Terminals. A real PTY, not the workspace sandbox — see terminal.ts for why
   * those are different things.
   */
  ipcMain.handle(IPC.ptyAvailable, () => terminalAvailable())
  ipcMain.handle(IPC.ptyStart, (_e, cwd: string, cols?: number, rows?: number) =>
    startTerminal(cwd, cols, rows)
  )
  ipcMain.handle(IPC.ptyWrite, (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.handle(IPC.ptyResize, (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows)
  )
  ipcMain.handle(IPC.ptyKill, (_e, id: string) => killTerminal(id))
  ipcMain.handle(IPC.ptyBacklog, (_e, id: string) => terminalBacklog(id))

  ipcMain.handle(IPC.ragAdd, (_e, paths: string[]) => addDocuments(paths))
  ipcMain.handle(IPC.ragList, () => listDocuments())
  ipcMain.handle(IPC.ragRemove, (_e, id: string) => removeDocument(id))
  ipcMain.handle(IPC.ragSearch, (_e, q: string) => search(q))
  ipcMain.handle(IPC.ragEmbedder, () => embedderInfo())

  // The live catalogue behind the OpenRouter group in the model picker.
  ipcMain.handle(IPC.openrouterModels, (_e, opts: { modality?: 'text' | 'embeddings'; q?: string }) =>
    listOpenRouterModels(opts ?? {})
  )

  // What the Claude subscription itself says it can run.
  ipcMain.handle(IPC.anthropicModels, () => listSubscriptionModels(app.getVersion()))

  /**
   * The working memory behind Settings -> Memory.
   *
   * Working memory is resource-scoped, so the thread is not what identifies it
   * -- but the API still wants one. A constant stands in: the editor is not a
   * conversation, and every read and write here names the same agent.
   */
  const EDITOR_THREAD = 'mochi-memory-editor'
  const memoryKeysFor = (agentId: string): { threadId: string; resourceId: string } => ({
    threadId: EDITOR_THREAD,
    resourceId: 'mochi-user:' + agentId
  })

  ipcMain.handle(IPC.memoryGet, async (_e, agentId: string) => {
    const agent = load().agents.find((a) => a.id === agentId)
    if (!agent) return ''
    return readWorkingMemory(agent, memoryKeysFor(agentId))
  })

  ipcMain.handle(IPC.memorySet, async (_e, agentId: string, text: string) => {
    const agent = load().agents.find((a) => a.id === agentId)
    if (!agent) return false
    return writeWorkingMemory(agent, { ...memoryKeysFor(agentId), text })
  })

  /** Both windows get every event — the overlay is a second view of the same
   *  state, not a separate app, so neither may miss a sticker or a state change. */
  const broadcast = (channel: string, payload?: unknown): void => {
    for (const win of [getWindow(), getMascotWindow()]) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  // Live asset folders → renderer
  watcher = watchAssets(() => broadcast(IPC.libraryChanged))

  // Mastra tools → renderer. This is the wire that makes the mascot react to the
  // agent instead of only to clicks (M1-18).
  bus.on('sticker', (payload) => {
    broadcast(IPC.stickerFired, payload)
    const win = getWindow()
    if (win && !win.isFocused()) win.flashFrame(true)
  })
  bus.on('mascot-state', (payload) => broadcast(IPC.mascotState, payload))
  // Approvals reach the overlay this way rather than down the chat stream, which
  // only the app window is reading. The mascot is often the only part of Mochi
  // on screen when a run stops to ask.
  /*
   * Approvals: always to the app, to the mascot only when you are not looking.
   *
   * The card in the transcript is the real one. The mascot's copy exists for the
   * case where Mochi is buried behind something else and a run has quietly
   * stopped to ask — putting it on the desktop while you are already staring at
   * the same question in the chat is just the same prompt twice.
   *
   * Held rather than dropped, because "not looking" can become true after the
   * fact: switching away from Mochi with a question still open is exactly when
   * the desktop copy earns its place.
   */
  const pendingApprovals = new Map<string, unknown>()

  const toMascot = (payload: unknown): void => {
    const win = getMascotWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.approval, payload)
  }

  bus.on('approval', (payload) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.approval, payload)

    const settled = typeof payload === 'object' && payload !== null && 'settled' in payload
    const id = (payload as { id?: string }).id
    if (settled) {
      if (id) pendingApprovals.delete(id)
      // Always forwarded: a card the mascot is already showing has to come down
      // wherever it was answered.
      toMascot(payload)
      return
    }
    if (id) pendingApprovals.set(id, payload)
    if (!isUserLooking()) toMascot(payload)
  })

  // Switching away with a question still open is when the desktop copy is worth
  // having, so anything still unanswered goes over at that moment.
  app.on('browser-window-blur', () => {
    if (isUserLooking()) return
    for (const payload of pendingApprovals.values()) toMascot(payload)
  })

  /**
   * PTY output goes to the app window alone.
   *
   * Unlike stickers and mascot state, this is not a second view of shared state
   * — the overlay has no terminal, and shipping every keystroke of output to a
   * window that will discard it is pure cost on a hot path.
   */
  setTerminalEvents({
    onData: (id, data) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.ptyData, { id, data })
    },
    onExit: (id, exitCode) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.ptyExit, { id, exitCode })
    }
  })

  app.on('before-quit', () => {
    void watcher?.close()
    watcher = null
    // Shells and language servers are child processes. Without this they
    // outlive the app and pile up across restarts.
    killAllTerminals()
    void destroyWorkspaces()
  })
}
