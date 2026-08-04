import { watch, type FSWatcher } from 'chokidar'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import { getPaths } from './paths'
import { MASCOT_STATE_LABELS, SPRITE_SLOTS } from '../shared/types'
import type {
  AssetLibrary,
  SpriteSlot,
  SoundAsset,
  Sprite,
  SpriteFile,
  Sticker
} from '../shared/types'

const IMAGE_EXT = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif'])
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac'])

/** Reverse the short studio labels back to states — dropping `work.png` fills `tool-running`. */
const LABEL_TO_STATE = new Map<string, SpriteSlot>(
  SPRITE_SLOTS.map((s) => [MASCOT_STATE_LABELS[s], s])
)

function listFiles(dir: string, allowed: Set<string>): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && allowed.has(extname(e.name).toLowerCase()))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Custom protocol URL. Registered in main so the renderer can load user files
 *  without disabling web security. */
function assetUrl(kind: 'sprites' | 'stickers' | 'sounds', preset: string, file: string): string {
  return `mochi-asset://${kind}/${preset ? `${preset}/` : ''}${file}`
}

/**
 * Every mascot folder the user has dropped in.
 *
 * A preset is just a directory under `mascots/`, so this is the list the studio
 * offers when swapping the whole sprite set. `sprout` is always included even
 * when the folder is empty, so a fresh install still has something to select.
 */
export function listSpritePresets(): string[] {
  const { sprites } = getPaths()
  let dirs: string[] = []
  try {
    dirs = readdirSync(sprites, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    dirs = []
  }
  // Only conjure `sprout` when there is genuinely nothing, so a fresh install
  // still has something to select. Adding it whenever it happens to be absent
  // meant that renaming it left a phantom entry in the list pointing at a
  // folder that no longer exists.
  if (dirs.length === 0) dirs.push('sprout')
  return dirs.sort((a, b) => a.localeCompare(b))
}

/** Per-folder state → file mapping. Kept beside the art so a mascot folder is
 *  self-contained: copy the directory somewhere else and it still knows itself. */
const MANIFEST = 'mascot.json'

type Manifest = Partial<Record<SpriteSlot, string>>

function readManifest(presetDir: string): Manifest {
  try {
    const raw = JSON.parse(readFileSync(join(presetDir, MANIFEST), 'utf8')) as {
      states?: Manifest
    }
    return raw.states ?? {}
  } catch {
    // Absent or corrupt. Name-matching still covers hand-made folders, so this
    // is a normal path rather than an error.
    return {}
  }
}

function writeManifest(presetDir: string, states: Manifest): void {
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(join(presetDir, MANIFEST), JSON.stringify({ states }, null, 2), 'utf8')
}

const FORBIDDEN_IN_NAME = '<>:"/\\|?*'

/**
 * Guard every path segment that reaches the filesystem from a renderer string.
 *
 * `basename` strips any traversal first. The rest is filtered rather than
 * regex-replaced because matching the control range needs literal control
 * characters in the pattern, which is both unreadable and what
 * `no-control-regex` exists to stop. Spaces and dashes are deliberately kept:
 * they are ordinary in a folder name, and stripping them would quietly create
 * a different folder than the one the user typed.
 */
function safeSegment(name: string): string {
  const clean = [...basename(name.trim())]
    .filter((ch) => ch >= ' ' && !FORBIDDEN_IN_NAME.includes(ch))
    .join('')
    .trim()
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid name')
  return clean
}

function presetPath(preset: string): string {
  return join(getPaths().sprites, safeSegment(preset))
}

export function readLibrary(spritePreset = 'sprout'): AssetLibrary {
  const paths = getPaths()
  const presetDir = join(paths.sprites, spritePreset)

  const files = listFiles(presetDir, IMAGE_EXT)
  const manifest = readManifest(presetDir)

  /** Manifest first, file name second. An explicit assignment should always beat
   *  a coincidence of naming. */
  const resolve = (state: SpriteSlot): { file: string; byName: boolean } | null => {
    const mapped = manifest[state]
    if (mapped && files.includes(mapped)) return { file: mapped, byName: false }
    const label = MASCOT_STATE_LABELS[state]
    const match = files.find((f) => {
      const stem = basename(f, extname(f)).toLowerCase()
      return stem === label || stem === state || LABEL_TO_STATE.get(stem) === state
    })
    return match ? { file: match, byName: true } : null
  }

  const resolved = new Map<SpriteSlot, { file: string; byName: boolean }>()
  for (const state of SPRITE_SLOTS) {
    const hit = resolve(state)
    if (hit) resolved.set(state, hit)
  }

  const sprites: Sprite[] = SPRITE_SLOTS.map((state) => {
    const hit = resolved.get(state)
    return { state, src: hit ? assetUrl('sprites', spritePreset, hit.file) : null }
  })

  // Every image in the folder, so the studio can show what is sitting there
  // unassigned instead of silently ignoring it.
  const spriteFiles: SpriteFile[] = files.map((file) => {
    let state: SpriteSlot | null = null
    let byName = false
    for (const [s, hit] of resolved) {
      if (hit.file === file) {
        state = s
        byName = hit.byName
        break
      }
    }
    return { file, src: assetUrl('sprites', spritePreset, file), state, byName }
  })

  const stickers: Sticker[] = listFiles(paths.stickers, IMAGE_EXT).map((f) => {
    const stem = basename(f, extname(f))
    // `happy.nice-work.png` → tag "happy", name "nice-work". A plain name gets "all".
    const [maybeTag, ...rest] = stem.split('.')
    const hasTag = rest.length > 0
    return {
      id: stem,
      name: hasTag ? rest.join('.') : stem,
      tag: hasTag ? maybeTag : 'all',
      src: assetUrl('stickers', '', f)
    }
  })

  const sounds: SoundAsset[] = listFiles(paths.sounds, AUDIO_EXT).map((f) => ({
    id: basename(f, extname(f)),
    name: f,
    duration: 0, // probed in the renderer, where an AudioContext exists
    src: assetUrl('sounds', '', f)
  }))

  return { sprites, spriteFiles, preset: spritePreset, stickers, sounds, roots: { ...paths } }
}

/* --- mascot folder management -------------------------------------------- */

/** Never collide with something already in the folder — importing the same file
 *  twice should give you two images, not silently replace one. */
function freeName(dir: string, name: string): string {
  const ext = extname(name)
  const stem = basename(name, ext).replace(/[<>:"/\\|?*]/g, '').trim() || 'sprite'
  let candidate = `${stem}${ext}`
  let n = 2
  while (existsSync(join(dir, candidate))) candidate = `${stem}-${n++}${ext}`
  return candidate
}

export function createPreset(name: string): string {
  const dir = presetPath(name)
  mkdirSync(dir, { recursive: true })
  return basename(dir)
}

export function renamePreset(from: string, to: string): string {
  const src = presetPath(from)
  const dest = presetPath(to)
  if (src === dest) return basename(dest)
  if (existsSync(dest)) throw new Error(`A folder called ${basename(dest)} already exists`)
  renameSync(src, dest)
  return basename(dest)
}

export function deletePreset(name: string): void {
  const dir = presetPath(name)
  // `sprout` is the fallback every fresh install resolves to; deleting it would
  // leave loadouts pointing at nothing.
  if (basename(dir) === 'sprout') throw new Error('The default sprout folder cannot be deleted')
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Copy images into a mascot folder.
 *
 * Bytes rather than paths: the renderer gets these from a drop event or a file
 * dialog, and shipping the buffer avoids handing the renderer a way to ask main
 * to read an arbitrary path.
 */
export function importSprites(
  preset: string,
  incoming: Array<{ name: string; bytes: Uint8Array }>
): SpriteFile[] {
  const dir = presetPath(preset)
  mkdirSync(dir, { recursive: true })
  const manifest = readManifest(dir)
  const taken = new Set(Object.values(manifest))

  for (const item of incoming) {
    const ext = extname(item.name).toLowerCase()
    if (!IMAGE_EXT.has(ext)) continue
    const name = freeName(dir, basename(item.name))
    writeFileSync(join(dir, name), item.bytes)

    // Auto-assign when the name already says what it is and nothing else has
    // claimed that state — this is the "sleep.png just works" case.
    const stem = basename(name, ext).toLowerCase()
    const state =
      LABEL_TO_STATE.get(stem) ?? (SPRITE_SLOTS.includes(stem as SpriteSlot) ? (stem as SpriteSlot) : null)
    if (state && !manifest[state] && !taken.has(name)) {
      manifest[state] = name
      taken.add(name)
    }
  }

  writeManifest(dir, manifest)
  return readLibrary(basename(dir)).spriteFiles
}

/** Import a whole folder of art as a new mascot folder, named after it. */
export function importPresetFolder(sourceDir: string): string {
  const name = createPreset(basename(sourceDir))
  const dir = presetPath(name)
  for (const file of listFiles(sourceDir, IMAGE_EXT)) {
    copyFileSync(join(sourceDir, file), join(dir, freeName(dir, file)))
  }
  // Existing manifest travels with the folder when there is one.
  const incoming = join(sourceDir, MANIFEST)
  if (existsSync(incoming)) copyFileSync(incoming, join(dir, MANIFEST))
  return name
}

/** Point a state at a file, or clear it when `file` is null. */
export function assignSprite(preset: string, state: SpriteSlot, file: string | null): void {
  const dir = presetPath(preset)
  const manifest = readManifest(dir)
  if (file === null) delete manifest[state]
  else manifest[state] = basename(file)
  writeManifest(dir, manifest)
}

export function removeSprite(preset: string, file: string): void {
  const dir = presetPath(preset)
  const name = basename(file)
  try {
    unlinkSync(join(dir, name))
  } catch {
    // Already gone — still worth clearing any mapping that pointed at it.
  }
  const manifest = readManifest(dir)
  for (const state of SPRITE_SLOTS) if (manifest[state] === name) delete manifest[state]
  writeManifest(dir, manifest)
}

/**
 * Watch the three asset folders so dropping a PNG updates the grid live (M16-11).
 * `awaitWriteFinish` keeps us from reading a half-copied file.
 */
export function watchAssets(onChange: () => void): FSWatcher {
  const paths = getPaths()
  const watcher = watch([paths.sprites, paths.stickers, paths.sounds], {
    ignoreInitial: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
  })
  let timer: NodeJS.Timeout | null = null
  const debounced = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, 120)
  }
  watcher.on('add', debounced).on('unlink', debounced).on('change', debounced)
  return watcher
}

/* --- agent bundles -------------------------------------------------------- */

/**
 * A shareable agent: the loadout plus the mascot art it wears.
 *
 * One JSON file with the images base64'd inside rather than a folder or a zip.
 * A folder is awkward to send someone, and a zip would mean a new dependency in
 * the main process for what is at most a handful of PNGs. The cost is ~33%
 * size over the raw bytes, which for six sprites is nothing.
 */
export interface AgentBundle {
  kind: 'mochi-agent'
  version: 1
  agent: Record<string, unknown>
  mascot: {
    name: string
    /** `mascot.json` if the folder had one, so assignments travel too. */
    manifest: unknown
    files: Array<{ name: string; data: string }>
  }
}

export function buildBundle(agent: Record<string, unknown>, preset: string): AgentBundle {
  const dir = presetPath(preset)
  const files = listFiles(dir, IMAGE_EXT).map((name) => ({
    name,
    data: readFileSync(join(dir, name)).toString('base64')
  }))
  let manifest: unknown = null
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
  } catch {
    // No manifest is normal — a hand-made folder maps by file name instead.
  }
  return {
    kind: 'mochi-agent',
    version: 1,
    agent,
    mascot: { name: basename(dir), manifest, files }
  }
}

/**
 * Unpack a bundle's art into a *new* mascot folder and hand back the loadout.
 *
 * Never writes into an existing folder: importing must not quietly overwrite the
 * art an agent you already have is using. `createPreset` + `freeName` mean a
 * second import of the same bundle lands beside the first.
 */
export function openBundle(raw: string): { agent: Record<string, unknown>; preset: string } {
  const parsed = JSON.parse(raw) as AgentBundle
  if (parsed?.kind !== 'mochi-agent' || !parsed.agent) {
    throw new Error('That file is not a Mochi agent bundle')
  }

  const wanted = parsed.mascot?.name || 'imported'
  let name = safeSegment(wanted)
  if (existsSync(join(getPaths().sprites, name))) {
    let n = 2
    while (existsSync(join(getPaths().sprites, `${name}-${n}`))) n++
    name = `${name}-${n}`
  }
  const dir = presetPath(createPreset(name))

  for (const file of parsed.mascot?.files ?? []) {
    const ext = extname(file.name).toLowerCase()
    if (!IMAGE_EXT.has(ext)) continue
    writeFileSync(join(dir, freeName(dir, basename(file.name))), Buffer.from(file.data, 'base64'))
  }
  if (parsed.mascot?.manifest) {
    writeFileSync(join(dir, MANIFEST), JSON.stringify(parsed.mascot.manifest, null, 2), 'utf8')
  }

  return { agent: parsed.agent, preset: basename(dir) }
}
