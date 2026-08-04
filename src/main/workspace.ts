import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace'
import { isAbsolute, normalize } from 'node:path'
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
 * Reject anything that climbs out of the workspace.
 *
 * `LocalFilesystem` resolves against its basePath, but the renderer is the one
 * choosing these strings and a widget bug should not be able to hand it
 * `../../../..`. Cheap to check here, and this is the only door in.
 */
function safePath(path: string): string | null {
  const clean = normalize(path).replace(/\\/g, '/')
  if (clean.split('/').includes('..')) return null
  return clean.startsWith('/') ? clean : `/${clean}`
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
    // TypeScript, JavaScript, Python, Go and Rust are built in. Anything else
    // simply returns no diagnostics rather than failing.
    lsp: true,
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
}

/** Read a text file out of the workspace. */
export async function readWorkspaceFile(
  folder: string,
  path: string
): Promise<ReadResult | { error: string }> {
  const ws = workspaceFor(folder)
  const p = safePath(path)
  if (!ws?.filesystem || !p) return { error: 'No workspace' }
  try {
    const stat = await ws.filesystem.stat(p)
    if (stat.type === 'directory') return { error: 'That is a folder' }
    // A 5MB source file is a generated bundle, and loading it into a textarea
    // locks the renderer for seconds. Better to say so than to hang.
    if (stat.size > 4 * 1024 * 1024) {
      return { error: `Too large to open (${Math.round(stat.size / 1024 / 1024)}MB)` }
    }
    const raw = await ws.filesystem.readFile(p, { encoding: 'utf-8' })
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8')
    return { text, mtime: stat.modifiedAt?.getTime() ?? null, truncated: false }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
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
  if (!ws?.filesystem || !p) return { ok: false, error: 'No workspace' }
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
    // StaleFileError is the expectedMtime guard firing. Named separately so the
    // editor can offer "reload" rather than showing a generic failure.
    const stale = /stale/i.test(message) || err?.constructor?.name === 'StaleFileError'
    return { ok: false, error: message, stale }
  }
}

/** List one directory level. The navigator expands lazily rather than walking
 *  the whole tree up front — on a real repo that is thousands of stats for a
 *  view that shows twenty rows. */
export async function listWorkspaceDir(
  folder: string,
  path = '/'
): Promise<FileEntry[] | { error: string }> {
  const ws = workspaceFor(folder)
  const p = safePath(path)
  if (!ws?.filesystem || !p) return { error: 'No workspace' }
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
  if (!ws?.filesystem || !p) return { error: 'No workspace' }
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
      const child = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`
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

  await walk('/', 0)
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
  severity: number
  message: string
  source?: string
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
  if (!ws?.lsp || !root || !p) return []
  try {
    const abs = `${root.replace(/\\/g, '/')}${p}`
    const found = await ws.lsp.getDiagnostics(abs, content)
    return (found ?? []).map((d) => {
      const record = d as unknown as {
        line?: number
        character?: number
        range?: { start?: { line?: number; character?: number } }
        severity?: number
        message?: string
        source?: string
      }
      return {
        line: record.line ?? record.range?.start?.line ?? 0,
        character: record.character ?? record.range?.start?.character ?? 0,
        severity: record.severity ?? 1,
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
  if (!ws?.lsp || !root || !p) return null
  try {
    const abs = `${root.replace(/\\/g, '/')}${p}`
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
