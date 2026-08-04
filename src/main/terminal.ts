import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

/**
 * Real terminals, one per widget.
 *
 * A pseudo-terminal rather than the workspace sandbox's `executeCommand`,
 * because the two are not the same thing. `executeCommand` is a pipe: it gives
 * you stdout after the fact, with no colours, no cursor control, and no way to
 * answer a prompt. Everything that makes a terminal worth having — a spinner
 * that spins, `git rebase` opening an editor, Ctrl+C reaching the process group,
 * `npm init` asking questions — needs a PTY.
 *
 * The sandbox still exists in workspace.ts. That one is the agent's shell; this
 * one is yours.
 */

/** node-pty is CommonJS and native. The main bundle is ESM, so it cannot be
 *  `import`ed — and it must stay external (electron.vite.config externalizes
 *  everything in `dependencies`) or the prebuilt .node binary is left behind. */
const require = createRequire(import.meta.url)

interface PtyProcess {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: NodeJS.ProcessEnv
    }
  ): PtyProcess
}

let ptyModule: PtyModule | null = null
let ptyError: string | null = null

/** Loaded lazily and behind a try: a missing prebuild for this platform should
 *  cost the terminal widget, not the whole app. */
function loadPty(): PtyModule | null {
  if (ptyModule || ptyError) return ptyModule
  try {
    ptyModule = require('@lydell/node-pty') as PtyModule
  } catch (err) {
    ptyError = err instanceof Error ? err.message : String(err)
  }
  return ptyModule
}

export function terminalAvailable(): { ok: boolean; error?: string } {
  return loadPty() ? { ok: true } : { ok: false, error: ptyError ?? 'unavailable' }
}

/** Which shell to open. PowerShell 7 when it is installed, Windows PowerShell
 *  otherwise; a POSIX box gets its login shell. */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { file: process.env.SHELL || '/bin/bash', args: [] }
  }
  const pwsh = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\6\\pwsh.exe'
  ].find((p) => existsSync(p))
  // -NoLogo only: -NoProfile would be wrong here. This is the user's own
  // terminal, and their profile is where their aliases and prompt live.
  return pwsh
    ? { file: pwsh, args: ['-NoLogo'] }
    : { file: 'powershell.exe', args: ['-NoLogo'] }
}

/**
 * The environment the shell starts with.
 *
 * Inherits the user's real environment — it is their terminal, and stripping it
 * would break every tool that reads a config var. The provider keys are the one
 * exception: main loads them out of safeStorage into `process.env` so the Mastra
 * model router can read them, which would otherwise leave them one `echo` away
 * from anyone watching a screenshare.
 */
const SECRET_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY'
]

function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of SECRET_VARS) delete env[key]
  // Electron sets these for its own child processes; a shell that inherits them
  // will run `node` as Electron rather than as node.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

interface Session {
  id: string
  pty: PtyProcess
  /** Output produced before the widget mounted its view, replayed on attach so
   *  reopening a collapsed terminal does not show a blank pane. */
  backlog: string
  exited: boolean
}

const sessions = new Map<string, Session>()

/** Cap the replay buffer. A `npm install` scrollback is megabytes, and none of
 *  it past the last screenful is worth restoring. */
const BACKLOG_MAX = 200_000

export interface TerminalEvents {
  onData(id: string, data: string): void
  onExit(id: string, exitCode: number): void
}

let events: TerminalEvents | null = null

export function setTerminalEvents(handlers: TerminalEvents): void {
  events = handlers
}

export function startTerminal(
  cwd: string,
  cols = 80,
  rows = 24
): { ok: true; id: string; pid: number } | { ok: false; error: string } {
  const pty = loadPty()
  if (!pty) return { ok: false, error: ptyError ?? 'node-pty unavailable' }

  const { file, args } = defaultShell()
  try {
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      // Falls back to the home directory rather than refusing: a session with no
      // folder set should still get a usable shell.
      cwd: cwd && existsSync(cwd) ? cwd : process.env.USERPROFILE || process.cwd(),
      env: shellEnv()
    })

    const id = randomUUID()
    const session: Session = { id, pty: proc, backlog: '', exited: false }
    sessions.set(id, session)

    proc.onData((data) => {
      session.backlog = (session.backlog + data).slice(-BACKLOG_MAX)
      events?.onData(id, data)
    })
    proc.onExit(({ exitCode }) => {
      session.exited = true
      events?.onExit(id, exitCode)
    })

    return { ok: true, id, pid: proc.pid }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function writeTerminal(id: string, data: string): void {
  const session = sessions.get(id)
  if (!session || session.exited) return
  session.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = sessions.get(id)
  if (!session || session.exited) return
  try {
    session.pty.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  } catch {
    // Racing a shell that exited between the check and the call.
  }
}

/** Everything printed so far, for a widget that is being reopened. */
export function terminalBacklog(id: string): string {
  return sessions.get(id)?.backlog ?? ''
}

export function killTerminal(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  if (session.exited) return
  try {
    session.pty.kill()
  } catch {
    // Already gone.
  }
}

/** Kill every shell. Without this each terminal outlives the app as an orphan
 *  console process, and they accumulate across restarts. */
export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
