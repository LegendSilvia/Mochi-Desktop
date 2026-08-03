import { watch, type FSWatcher } from 'chokidar'
import { readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { getPaths } from './paths'
import { MASCOT_STATES, MASCOT_STATE_LABELS } from '../shared/types'
import type { AssetLibrary, MascotState, SoundAsset, Sprite, Sticker } from '../shared/types'

const IMAGE_EXT = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif'])
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac'])

/** Reverse the short studio labels back to states — dropping `work.png` fills `tool-running`. */
const LABEL_TO_STATE = new Map<string, MascotState>(
  MASCOT_STATES.map((s) => [MASCOT_STATE_LABELS[s], s])
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
  if (!dirs.includes('sprout')) dirs.unshift('sprout')
  return dirs.sort((a, b) => a.localeCompare(b))
}

export function readLibrary(spritePreset = 'sprout'): AssetLibrary {
  const paths = getPaths()
  const presetDir = join(paths.sprites, spritePreset)

  const spriteFiles = listFiles(presetDir, IMAGE_EXT)
  const sprites: Sprite[] = MASCOT_STATES.map((state) => {
    const label = MASCOT_STATE_LABELS[state]
    const match = spriteFiles.find((f) => {
      const stem = basename(f, extname(f)).toLowerCase()
      return stem === label || stem === state || LABEL_TO_STATE.get(stem) === state
    })
    return { state, src: match ? assetUrl('sprites', spritePreset, match) : null }
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

  return { sprites, stickers, sounds, roots: { ...paths } }
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
