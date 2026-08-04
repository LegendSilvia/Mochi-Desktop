import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { getPaths } from './paths'
import {
  DEFAULT_AGENTS,
  DEFAULT_RULES,
  DEFAULT_SESSIONS,
  DEFAULT_SETTINGS
} from '../shared/defaults'
import type { PersistedState } from '../shared/types'

const seed = (): PersistedState => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  agents: structuredClone(DEFAULT_AGENTS),
  sessions: structuredClone(DEFAULT_SESSIONS),
  rules: structuredClone(DEFAULT_RULES)
})

let state: PersistedState | null = null

/**
 * Set an unreadable settings file aside before defaults bury it.
 *
 * A settings file that won't parse used to be swallowed silently: `load()`
 * returned defaults, the app came up looking factory-fresh, and the first save
 * wrote those defaults straight over the original. Everything in it was gone
 * with no trace and no warning. That is exactly what a stray UTF-8 BOM did to
 * this project's own profile — the file was intact and readable by eye, and
 * `JSON.parse` still refused it.
 *
 * An existing backup is never overwritten. The first failure is the one holding
 * real data; anything after it is likely defaults corrupted again, and clobbering
 * the original with that would defeat the point.
 */
function quarantine(raw: string, reason: unknown): void {
  const base = `${getPaths().settings}.bad`
  let target = base
  for (let n = 2; existsSync(target); n++) target = `${base}.${n}`
  try {
    writeFileSync(target, raw, 'utf-8')
    console.error(
      `[mochi] settings.json could not be parsed (${
        reason instanceof Error ? reason.message : String(reason)
      }). Starting from defaults; the original is kept at ${target}`
    )
  } catch (err) {
    // Nothing further to try. Say so loudly rather than losing it quietly.
    console.error('[mochi] settings.json is unreadable AND could not be backed up:', err)
  }
}

export function load(): PersistedState {
  if (state) return state

  let raw: string | null = null
  try {
    raw = readFileSync(getPaths().settings, 'utf-8')
  } catch {
    // No file at all — a fresh install. There is nothing to preserve, so this is
    // deliberately not treated as corruption.
  }

  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      const base = seed()
      // Shallow-merge so a settings file written by an older build keeps working
      // when new keys are added, instead of failing to load entirely.
      state = {
        settings: { ...base.settings, ...parsed.settings },
        agents: parsed.agents?.length ? parsed.agents : base.agents,
        sessions: parsed.sessions ?? base.sessions,
        rules: parsed.rules?.length ? parsed.rules : base.rules
      }
      return state
    } catch (err) {
      quarantine(raw, err)
    }
  }

  state = seed()
  return state
}

export function save(next: Partial<PersistedState>): PersistedState {
  const current = load()
  state = { ...current, ...next }
  writeFileSync(getPaths().settings, JSON.stringify(state, null, 2), 'utf-8')
  return state
}

/**
 * Provider API keys.
 *
 * Encrypted with Electron's safeStorage, which on Windows is backed by DPAPI —
 * the key material never sits in a readable JSON file (M12-03). If the OS refuses
 * encryption we do NOT silently fall back to plaintext; we refuse and say so.
 */
const KEYS_FILE = (): string => join(getPaths().userData, 'provider-keys.bin')

type KeyMap = Record<string, string>

export function readProviderKeys(): KeyMap {
  if (!safeStorage.isEncryptionAvailable()) return {}
  try {
    const blob = readFileSync(KEYS_FILE())
    return JSON.parse(safeStorage.decryptString(blob)) as KeyMap
  } catch {
    return {}
  }
}

export function writeProviderKey(provider: string, key: string): { ok: boolean; reason?: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      reason:
        'OS credential encryption is unavailable, so the key was not saved. ' +
        'Mochi will not write API keys to disk in plaintext.'
    }
  }
  const keys = readProviderKeys()
  keys[provider] = key
  writeFileSync(KEYS_FILE(), safeStorage.encryptString(JSON.stringify(keys)))
  return { ok: true }
}

export function deleteProviderKey(provider: string): void {
  if (!safeStorage.isEncryptionAvailable()) return
  const keys = readProviderKeys()
  delete keys[provider]
  writeFileSync(KEYS_FILE(), safeStorage.encryptString(JSON.stringify(keys)))
}

/** Push stored keys into the process env so Mastra's model router finds them. */
export function applyProviderKeysToEnv(): void {
  const keys = readProviderKeys()
  for (const [envVar, value] of Object.entries(keys)) {
    if (value) process.env[envVar] = value
  }
}

/** Mask for display: `sk-••••••4f2a`. Never return the raw key to the renderer. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 3)}••••••${key.slice(-4)}`
}
