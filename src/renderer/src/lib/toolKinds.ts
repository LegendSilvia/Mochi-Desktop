/**
 * Mochi's own tools, which are presentation rather than work.
 *
 * A sticker is the mascot saying something and gets a card of its own; a mascot
 * state change renders nothing at all. Folding these into a run of tool calls
 * counted them as steps and buried the sticker inside a collapsed summary — the
 * agent sent it and you never saw it. They belong in the transcript at full
 * size, beside the reply rather than inside the work.
 *
 * In its own file rather than beside the component that uses it: a module that
 * exports components may not also export functions, or fast refresh stops
 * working for the whole file.
 */
const PRESENTATIONAL = new Set(['sendSticker', 'setMascotState', 'askUser', 'delegate'])

/** Accepts either the bare tool name or the `tool-` prefixed part type. */
export function isPresentational(partType: string): boolean {
  return PRESENTATIONAL.has(partType.replace(/^tool-/, ''))
}
