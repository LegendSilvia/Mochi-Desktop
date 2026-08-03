/**
 * Keyboard labels.
 *
 * The prototype printed macOS glyphs in every shortcut chip. On Windows those
 * must read Ctrl / Alt. Derived from the platform in one helper — never
 * hard-coded at a call site (M0-14).
 */

const isMac = (): boolean => navigator.platform.toLowerCase().includes('mac')

export type ChordKey = 'mod' | 'alt' | 'shift' | 'enter' | 'space'

const LABEL: Record<ChordKey, { win: string; mac: string }> = {
  mod: { win: 'Ctrl', mac: '⌘' },
  alt: { win: 'Alt', mac: '⌥' },
  shift: { win: 'Shift', mac: '⇧' },
  enter: { win: 'Enter', mac: '↵' },
  space: { win: 'Space', mac: 'space' }
}

/** `chord('mod', 'K')` → "Ctrl K" on Windows, "⌘K" on macOS. */
export function chord(...parts: Array<ChordKey | string>): string {
  const mac = isMac()
  const rendered = parts.map((p) => (p in LABEL ? LABEL[p as ChordKey][mac ? 'mac' : 'win'] : p))
  return rendered.join(mac ? '' : ' ')
}

export const KEYS = {
  search: () => chord('mod', 'K'),
  newSession: () => chord('mod', 'N'),
  settings: () => chord('mod', ','),
  stickerPicker: () => chord('mod', ';'),
  hideMascot: () => chord('mod', 'M'),
  snapMascot: () => chord('mod', 'shift', 'M'),
  pushToTalk: () => chord('alt', 'space'),
  send: () => chord('mod', 'enter')
}

/** True when the platform's primary modifier is held. */
export function hasMod(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac() ? e.metaKey : e.ctrlKey
}
