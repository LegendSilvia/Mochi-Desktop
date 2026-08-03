import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Asset and data locations.
 *
 * Everything lives under `app.getPath('userData')`, which is `%APPDATA%\Mochi` on
 * Windows. Paths are built with `join` so they come out in native form — never
 * hand-assemble one with '/' (M6-08).
 */
export interface MochiPaths {
  userData: string
  sprites: string
  stickers: string
  sounds: string
  database: string
  settings: string
}

let cached: MochiPaths | null = null

export function getPaths(): MochiPaths {
  if (cached) return cached

  const userData = app.getPath('userData')
  const paths: MochiPaths = {
    userData,
    sprites: join(userData, 'mascots'),
    stickers: join(userData, 'stickers'),
    sounds: join(userData, 'sounds'),
    database: join(userData, 'mochi.db'),
    settings: join(userData, 'settings.json')
  }

  for (const dir of [paths.sprites, paths.stickers, paths.sounds]) {
    mkdirSync(dir, { recursive: true })
  }

  cached = paths
  return paths
}

/** LibSQL wants a file: URL. On Windows the path has backslashes, which must be
 *  converted or libsql reads them as escapes. */
export function databaseUrl(): string {
  return `file:${getPaths().database.replace(/\\/g, '/')}`
}
