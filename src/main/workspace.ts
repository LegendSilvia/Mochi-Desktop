import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace'
import { app } from 'electron'
import { isAbsolute, join, normalize } from 'node:path'
import type { FileEntry, FileStat, WorkspaceToolsConfig } from '@mastra/core/workspace'

/**
 * One Workspace per folder, shared by the widgets and the agent.
 *
 * This is deliberately not two implementations. The file navigator, the editor
 * and the agent's `write_file` all resolve the same paths through the same
 * `LocalFilesystem`, so "the folder the agent can reach" and "the folder you can
 * browse" cannot drift apart — which they would the moment the widgets read disk
 * directly and the agent went through Mastra.
 *
 * It also means the agent's own edits are visible to the editor widget without
 * any wiring: same basePath, same mtimes, so a stale-save check catches the
 * agent exactly as it would catch a second window.
 *
 * Terminals do NOT run through the sandbox here — a real PTY is a different
 * thing from `executeCommand` (see terminal.ts). The sandbox in this workspace
 * exists to give the *agent* a shell.
 */

/** Folders that are never worth walking. Indexing `node_modules` once costs
 *  more than every search the user will ever run against it. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  '.turbo',
  'coverage',
  '.venv',
  '__pycache__'
])

/** Extensions worth putting in a text index. A search over a PNG returns
 *  nothing useful and costs the same as one over a source file. */
const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|css|scss|html|yml|yaml|toml|py|go|rs|java|kt|rb|php|sh|ps1|sql|c|h|cpp|hpp|cs|swift|vue|svelte|xml|ini|env|gitignore)$/i

/** Guardrails on the lazy index, so a search inside a monorepo does not hang
 *  the main process on first use. */
const INDEX_MAX_FILES = 4000
const INDEX_MAX_BYTES = 512 * 1024

/**
 * What the agent may do to the folder through this workspace.
 *
 * `delete` and `execute_command` are off, and that is a deliberate gap rather
 * than an oversight. Mastra's approval mechanism suspends the run and emits a
 * `tool-call-approval` chunk that has to be resumed with `approveToolCall` —
 * a different shape entirely from the `data-permission` part this app's
 * renderer knows how to draw, which is the Agent SDK backend's own convention.
 * Until that path exists, anything switched on here runs with no prompt at all.
 *
 * So the line is drawn at reversibility. Editing a file is recoverable, and
 * being able to edit is the entire point of the feature. Deleting one, or
 * running an arbitrary shell command, is not.
 *
 * This only binds the *agent*. The widgets reach the filesystem through the
 * exported functions below, which are driven by the user pressing something.
 */
const AGENT_TOOLS: WorkspaceToolsConfig = {
  enabled: true,
  requireApproval: false,
  [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { enabled: false },
  [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { enabled: false },
  // Overwriting a file it has not looked at is how good content gets quietly
  // replaced by a plausible guess.
  [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { requireReadBeforeWrite: true }
}

const workspaces = new Map<string, Workspace>()
/** Folders whose text index has already been built this run. */
const indexed = new Set<string>()

/**
 * A folder path is only usable as a workspace root if it is absolute.
 *
 * A relative one would resolve against `process.cwd()`, which for a packaged
 * Electron app is wherever the user happened to launch it from — so the same
 * session would point at a different folder depending on how it was started.
 */
function rootOf(folder: string): string | null {
  if (!folder || !isAbsolute(folder)) return null
  return normalize(folder)
}

/**
 * Normalise a path the way `LocalFilesystem` actually wants it.
 *
 * It takes paths *relative* to basePath and rejects a leading slash outright —
 * `/src` is read as "the drive root", which is outside the workspace, so it
 * fails with a permission error rather than listing the folder you meant. The
 * workspace root itself is the empty string.
 *
 * This also rejects anything that climbs out. The renderer chooses these
 * strings, and a widget bug should not be able to hand it `../../../..`; this
 * is the only door in.
 */
function safePath(path: string): string | null {
  const clean = normalize(path || '.').replace(/\\/g, '/')
  if (clean.split('/').some((seg) => seg === '..')) return null
  const rel = clean.replace(/^\/+/, '').replace(/\/+$/, '')
  return rel === '.' ? '' : rel
}

/**
 * Where to look for language server binaries.
 *
 * Mochi's own `node_modules/.bin` comes first, because that is where the
 * bundled `typescript-language-server` lives — the folder the user opens is
 * usually someone else's project and cannot be relied on to have one installed,
 * and the whole point is that diagnostics work without them setting anything up.
 *
 * The workspace's own bin directory is included too, so a project pinning a
 * different version gets its own, and the user's PATH is searched last.
 */
function lspSearchPaths(root?: string): string[] {
  const paths = [join(app.getAppPath(), 'node_modules', '.bin')]
  if (root) paths.push(join(root, 'node_modules', '.bin'))
  return paths
}

/** Absolute on-disk path, for the things that need one (the language server
 *  talks in file URIs, not workspace-relative paths). */
function absoluteIn(root: string, rel: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return rel ? `${base}/${rel}` : base
}

/**
 * Get (or build) the workspace for a folder.
 *
 * `bm25`, `lsp` and `skills` are all on: each one costs nothing until the
 * matching tool or widget is first used, and gating them behind settings would
 * mean a widget that exists but silently returns nothing.
 */
export function workspaceFor(folder: string): Workspace | null {
  const root = rootOf(folder)
  if (!root) return null

  const existing = workspaces.get(root)
  if (existing) return existing

  const ws = new Workspace({
    id: `mochi-${Buffer.from(root).toString('base64url').slice(0, 24)}`,
    name: root,
    filesystem: new LocalFilesystem({ basePath: root }),
    sandbox: new LocalSandbox({
      workingDirectory: root,
      // Deliberately NOT `process.env`. The main process holds the user's
      // provider API keys in its environment (see store.ts), and handing the
      // whole environment to a shell the agent drives would put them one
      // `echo $ANTHROPIC_API_KEY` away from the transcript. PATH is included by
      // LocalSandbox itself, which is what makes npm and git resolve.
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE,
        PATHEXT: process.env.PATHEXT
      } as NodeJS.ProcessEnv
    }),
    bm25: true,
    // TypeScript, JavaScript, Python, Go and Rust are supported, but only if the
    // matching language server is actually installed — Mastra spawns them, it
    // does not bundle them. TypeScript ships with Mochi, so that one works in
    // any folder the user opens; the rest are found on PATH if present and
    // simply return no diagnostics if not.
    lsp: {
      // Without this the project root defaults to `process.cwd()`, which for a
      // packaged Electron app is wherever it was launched from — so the language
      // server would resolve tsconfig and node_modules against Mochi's own
      // directory rather than the folder being edited.
      root,
      searchPaths: lspSearchPaths(root)
    },
    skills: ['.claude/skills', 'skills'],
    tools: AGENT_TOOLS
  })

  workspaces.set(root, ws)
  return ws
}

export interface ReadResult {
  text: string
  /** Epoch ms, handed back on save so a write can detect the agent got there
   *  first. Null when the file vanished between read and stat. */
  mtime: number | null
  truncated: boolean
  /** Readable, but big enough to be worth a word of warning before you scroll
   *  into it. */
  large?: boolean
  size: number
}

export interface ReadRefusal {
  error: string
  /** Lets the editor draw a proper notice rather than a red failure — none of
   *  these are faults, they are files that are not editable text. */
  kind?: 'binary' | 'too-large' | 'directory' | 'undecodable'
  size?: number
}

/** Above this a file is still opened, but the editor says so first. */
const LARGE_BYTES = 1024 * 1024
/** Above this it is not opened at all — a textarea this big locks the renderer
 *  for seconds and there is nothing useful to do with it anyway. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * Is this bytes rather than text?
 *
 * A NUL byte is the giveaway and costs nothing to find — no real text file in
 * any encoding this editor could show contains one. The control-character ratio
 * is the backstop for formats that happen to avoid NUL.
 *
 * Only the head is examined: a file that is text for 8KB and binary afterwards
 * does not exist in practice, and reading the whole thing to be sure would mean
 * loading the very files this is trying to avoid loading.
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  if (n === 0) return false
  let control = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    // Tab, newline, carriage return and form feed are text; the rest of C0 is not.
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12) control++
  }
  return control / n > 0.1
}

/** Read a file out of the workspace, refusing the ones a text editor cannot show. */
export async function readWorkspaceFile(
  folder: string,
  path: string
): Promise<ReadResult | ReadRefusal> {
  const ws = workspaceFor(folder)
  const p = safePath(path)
  if (!ws?.filesystem || p === null) return { error: 'No workspace' }
  try {
    const stat = await ws.filesystem.stat(p)
    if (stat.type === 'directory') return { error: 'That is a folder', kind: 'directory' }
    if (stat.size > MAX_BYTES) {
      return {
        error: `This file is ${formatBytes(stat.size)} — too large to open here.`,
        kind: 'too-large',
        size: stat.size
      }
    }

    // Read as bytes first. Decoding straight to UTF-8 is what turns a .pbix or a
    // .png into a screen of replacement characters that looks like a rendering
    // bug rather than "this is not a text file".
    const raw = await ws.filesystem.readFile(p, { encoding: 'binary' })
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'binary')

    if (looksBinary(buf)) {
      return {
        error: `This looks like a binary file (${formatBytes(stat.size)}), not text.`,
        kind: 'binary',
        size: stat.size
      }
    }

    const text = buf.toString('utf-8')
    // A file that decoded but came out mostly as U+FFFD is text in some encoding
    // this cannot read — showing the mojibake would invite editing and saving it,
    // which destroys the original.
    const replacements = (text.match(/�/g) ?? []).length
    if (replacements > 0 && replacements / Math.max(1, text.length) > 0.01) {
      return {
        error: 'This file is text, but not in an encoding Mochi can read (try UTF-8).',
        kind: 'undecodable',
        size: stat.size
      }
    }

    return {
      text,
      mtime: stat.modifiedAt?.getTime() ?? null,
      truncated: false,
      large: stat.size > LARGE_BYTES,
      size: stat.size
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Write a file back, refusing if it changed underneath us.
 *
 * `expectedMtime` is the whole point: the agent edits the same files through the
 * same filesystem, so "I opened this, then the agent rewrote it, then I saved"
 * is an ordinary Tuesday here rather than a rare race. Losing the agent's work
 * silently would be the worst possible outcome, so a stale write fails and the
 * editor offers to reload.
 */
export async function writeWorkspaceFile(
  folder: string,
  path: string,
  content: string,
  expectedMtime?: number | null
): Promise<{ ok: true; mtime: number | null } | { ok: false; error: string; stale?: boolean }> {
  const ws = workspaceFor(folder)
  const p = safePath(path)
  if (!ws?.filesystem || p === null) return { ok: false, error: 'No workspace' }
  try {
    await ws.filesystem.writeFile(p, content, {
      recursive: true,
      overwrite: true,
      ...(expectedMtime ? { expectedMtime: new Date(expectedMtime) } : {})
    })
    const stat = await ws.filesystem.stat(p).catch(() => null)
    return { ok: true, mtime: stat?.modifiedAt?.getTime() ?? null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The expectedMtime guard firing. Flagged separately so the editor can offer
    // "reload" rather than a generic failure — this is the common case when the
    // agent and the user are in the same file, not an exceptional one.
    //
    // Matched on the message as well as the class because Mastra words it
    // "File was modified externally", which contains neither "stale" nor the
    // constructor name once it has crossed the IPC boundary.
    const stale =
      /stale|modified externally/i.test(message) || err?.constructor?.name === 'StaleFileError'
    return { ok: false, error: message, stale }
  }
}

/** List one directory level. The navigator expands lazily rather than walking
 *  the whole tree up front — on a real repo that is thousands of stats for a
 *  view that shows twenty rows. */
export async function listWorkspaceDir(
  folder: string,
  path = ''
): Promise<FileEntry[] | { error: string }> {
  const ws = workspaceFor(folder)
  const p = safePath(path)
  if (!ws?.filesystem || p === null) return { error: 'No workspace' }
  try {
    const entries = await ws.filesystem.readdir(p)
    return entries
      .filter((e) => !(e.type === 'directory' && SKIP_DIRS.has(e.name)))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
      )
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function statWorkspacePath(
  folder: string,
  path: string
): Promise<FileStat | { error: string }> {
  const ws = workspaceFor(folder)
  const p = safePath(path)
  if (!ws?.filesystem || p === null) return { error: 'No workspace' }
  try {
    return await ws.filesystem.stat(p)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Build the BM25 index for a folder, once, on first search.
 *
 * Not `autoIndexPaths` on the Workspace: that runs during `init()`, which is on
 * the path of the *first agent message*, and a 4000-file walk there would show
 * up as the app hanging when you say hello. Deferring it to the first search
 * puts the cost where the user asked for it.
 */
async function ensureIndexed(folder: string, ws: Workspace): Promise<number> {
  const root = rootOf(folder)
  if (!root || indexed.has(root)) return 0
  indexed.add(root)

  let count = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || count >= INDEX_MAX_FILES) return
    let entries: FileEntry[]
    try {
      entries = await ws.filesystem!.readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= INDEX_MAX_FILES) return
      const child = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(child, depth + 1)
        continue
      }
      if (!TEXT_EXT.test(entry.name)) continue
      if ((entry.size ?? 0) > INDEX_MAX_BYTES) continue
      try {
        const raw = await ws.filesystem!.readFile(child, { encoding: 'utf-8' })
        await ws.index(child, typeof raw === 'string' ? raw : raw.toString('utf-8'))
        count++
      } catch {
        // An unreadable file is not worth failing the whole index over.
      }
    }
  }

  await walk('', 0)
  return count
}

export interface WorkspaceHit {
  path: string
  score: number
  excerpt: string
}

/** Keyword search over the folder. */
export async function searchWorkspace(
  folder: string,
  query: string
): Promise<{ hits: WorkspaceHit[]; indexedNow: number } | { error: string }> {
  const ws = workspaceFor(folder)
  if (!ws?.filesystem) return { error: 'No workspace' }
  if (!query.trim()) return { hits: [], indexedNow: 0 }
  try {
    const indexedNow = await ensureIndexed(folder, ws)
    const results = await ws.search(query, { topK: 40 })
    return {
      indexedNow,
      hits: results.map((r) => {
        const record = r as unknown as { id?: string; score?: number; content?: string }
        const content = record.content ?? ''
        // Centre the excerpt on the first match rather than showing the head of
        // the file — the top of a source file is imports in every language.
        const at = content.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0] ?? '')
        const from = at > 60 ? at - 60 : 0
        return {
          path: record.id ?? '',
          score: record.score ?? 0,
          excerpt: content.slice(from, from + 220).replace(/\s+/g, ' ').trim()
        }
      })
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export interface EditorDiagnostic {
  line: number
  character: number
  /** LSP numbering: 1 error, 2 warning, 3 info, 4 hint. */
  severity: number
  message: string
  source?: string
}

/**
 * Mastra reports severity as a word, the protocol numbers it.
 *
 * The editor's gutter and diagnostic rows key off the number, so passing the
 * string through would leave every error styled as though it had no severity at
 * all — visible in the list, but never coloured.
 */
const SEVERITY: Record<string, number> = {
  error: 1,
  warning: 2,
  warn: 2,
  information: 3,
  info: 3,
  hint: 4
}

function severityOf(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return SEVERITY[value.toLowerCase()] ?? 1
  return 1
}

/**
 * Diagnostics for one open file.
 *
 * Takes the editor's *current* buffer rather than reading from disk, so
 * squiggles track what you are typing instead of what you last saved.
 */
export async function diagnoseFile(
  folder: string,
  path: string,
  content: string
): Promise<EditorDiagnostic[]> {
  const ws = workspaceFor(folder)
  const root = rootOf(folder)
  const p = safePath(path)
  if (!ws?.lsp || !root || p === null) return []
  try {
    const abs = absoluteIn(root, p)
    const found = await ws.lsp.getDiagnostics(abs, content)
    return (found ?? []).map((d) => {
      const record = d as unknown as {
        line?: number
        character?: number
        range?: { start?: { line?: number; character?: number } }
        severity?: number | string
        message?: string
        source?: string
      }
      return {
        line: record.line ?? record.range?.start?.line ?? 0,
        character: record.character ?? record.range?.start?.character ?? 0,
        severity: severityOf(record.severity),
        message: record.message ?? '',
        source: record.source
      }
    })
  } catch {
    // No language server for this file type is the common case, not an error.
    return []
  }
}

/**
 * Type information for the symbol under the caret.
 *
 * Goes through `prepareQuery` rather than `getDiagnostics` because hover needs
 * the document open on the server at the content being asked about — the same
 * open/change dance, but answering a position instead of waiting for a publish.
 */
export async function hoverAt(
  folder: string,
  path: string,
  line: number,
  character: number
): Promise<string | null> {
  const ws = workspaceFor(folder)
  const root = rootOf(folder)
  const p = safePath(path)
  if (!ws?.lsp || !root || p === null) return null
  try {
    const abs = absoluteIn(root, p)
    const prepared = await ws.lsp.prepareQuery(abs)
    if (!prepared) return null
    const hover = (await prepared.client.queryHover(prepared.uri, { line, character })) as {
      contents?: unknown
    } | null
    return flattenHover(hover?.contents) || null
  } catch {
    return null
  }
}

/** LSP hover contents are a union of four shapes across protocol versions:
 *  a string, a `{ value }`, a `{ language, value }`, or an array of any of
 *  those. Every one of them shows up in practice depending on the server. */
function flattenHover(contents: unknown): string {
  if (!contents) return ''
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(flattenHover).filter(Boolean).join('\n')
  if (typeof contents === 'object' && 'value' in contents) {
    return String((contents as { value: unknown }).value ?? '')
  }
  return ''
}

export interface SkillEntry {
  name: string
  description?: string
  path: string
}

/** SKILL.md packs discovered in the folder. */
export async function listWorkspaceSkills(folder: string): Promise<SkillEntry[]> {
  const ws = workspaceFor(folder)
  if (!ws?.skills) return []
  try {
    const found = await ws.skills.list()
    return found.map((s) => {
      const record = s as unknown as { name?: string; description?: string; path?: string }
      return {
        name: record.name ?? 'skill',
        description: record.description,
        path: record.path ?? ''
      }
    })
  } catch {
    return []
  }
}

/** Release every workspace. Called on quit so language servers and sandboxes do
 *  not outlive the app as orphaned child processes. */
export async function destroyWorkspaces(): Promise<void> {
  const all = [...workspaces.values()]
  workspaces.clear()
  indexed.clear()
  await Promise.allSettled(all.map((ws) => ws.destroy()))
}
