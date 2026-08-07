/**
 * What a tool call would cost if it were wrong.
 *
 * One table, used three ways: as the veto the chosen classifier model cannot
 * appeal (Phase 2), as the whole decision on the Mastra backend where there is
 * no classifier (Phase 3), and not at all on native Auto, where the CLI has its
 * own better-tuned rules and layering ours on top would be two policies
 * disagreeing.
 *
 * The split is by consequence, not by who wrote the tool. A tool is judged by
 * its tags AND by the arguments it was actually called with, because tags alone
 * cannot tell `runSql('SELECT …')` from `runSql('DROP TABLE …')` — and tagging
 * `runSql` destructive-always would make Auto ask about every read.
 */
export type ToolTag = 'read' | 'write' | 'data' | 'execute' | 'network' | 'destructive'

export interface Consequence {
  /** `card` is final. `allow` means only "the table has no objection" — on the
   *  classifier path it is the classifier's turn, not permission to run. */
  verdict: 'allow' | 'card'
  /** Why it carded, for the card to show. Null when the verdict is `allow`. */
  reason: string | null
  tags: ToolTag[]
}

/**
 * Tags for the tools that actually reach here.
 *
 * Everything in `AUTO_APPROVED` short-circuits long before this, so the reads
 * and the agent's own bookkeeping are deliberately absent. A tool that is not
 * listed is not thereby safe — it is unjudged, and the classifier is exactly
 * the thing meant to judge an unfamiliar call. The argument scan and the
 * always-card rules below still apply to it.
 */
export const TOOL_TAGS: Record<string, ToolTag[]> = {
  Write: ['write'],
  Edit: ['write'],
  MultiEdit: ['write'],
  NotebookEdit: ['write'],
  Bash: ['execute'],
  KillShell: ['execute'],
  SlashCommand: ['execute'],
  mcp__mochi__saveDoc: ['write'],
  mcp__mochi__searchDocs: ['read']
}

/** Tags that are never the classifier's to wave through. */
const CARDING_TAGS: ToolTag[] = ['write', 'execute', 'destructive']

/**
 * Dangerous vocabulary in the arguments, whatever the tool is called.
 *
 * Matched on word boundaries, deliberately: a substring match makes `dropdown`
 * a card and `undeleted` a card, and an Auto mode that asks about everything is
 * one nobody leaves on. Grow this list from evidence, not from imagination.
 */
const ARGUMENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bdrop\b/i, reason: 'the arguments contain “drop”' },
  { pattern: /\bdelete\b/i, reason: 'the arguments contain “delete”' },
  { pattern: /\btruncate\b/i, reason: 'the arguments contain “truncate”' },
  { pattern: /\brm\s+-[a-z]*[rf]/i, reason: 'the arguments contain a recursive remove' },
  { pattern: /--force\b|\bpush\s+--force|-f\b\s*$/i, reason: 'the arguments force an operation' },
  { pattern: /\bformat\s+[a-z]:/i, reason: 'the arguments format a drive' },
  {
    pattern: /\bfilter-branch\b|\breset\s+--hard\b|\bpush\b.*\bforce\b/i,
    reason: 'the arguments rewrite history'
  }
]

/**
 * Paths that always reach a card, whatever the tags or the tool.
 *
 * Credentials, keys, and Mochi's own state — the last because an agent that can
 * edit `settings.json` can edit the permission mode it is running under.
 */
const ALWAYS_CARD_PATHS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[\\/])\.env(\.|$)/i, reason: 'it touches an environment file' },
  { pattern: /[\\/]\.ssh[\\/]|id_rsa|id_ed25519/i, reason: 'it touches an SSH key' },
  { pattern: /[\\/]\.aws[\\/]|credentials$/i, reason: 'it touches stored credentials' },
  {
    pattern: /[\\/]AppData[\\/]Roaming[\\/]Mochi[\\/]/i,
    reason: 'it touches Mochi’s own configuration'
  },
  { pattern: /\.pem$|\.key$|\.pfx$/i, reason: 'it touches a key file' }
]

export function assess(
  toolName: string,
  input: unknown,
  opts?: { workspaceRoot?: string }
): Consequence {
  const tags = TOOL_TAGS[toolName] ?? []

  /*
   * Every string and number the call carries, flattened to a list and tested
   * one value at a time — never joined into a single string.
   *
   * A `$`-anchored pattern tested against a joined string only fires when the
   * matching value happens to land last in `Object.values()` enumeration
   * order, which is an accident of object shape, not a security property: a
   * `.env` path in an early property was invisible to `credentials$` and
   * `-f\b\s*$` whenever a sibling property came after it. Testing each value
   * on its own makes every rule below order-independent.
   *
   * A failure to read the input is not a reason to wave the call through — an
   * argument you cannot read is an argument you cannot clear — so the catch
   * cards rather than continuing with an empty list, which would silently
   * skip every scan below. Hitting `flatten`'s depth cap is the same kind of
   * failure and throws for the same reason.
   */
  let values: string[]
  try {
    values = flatten(input)
  } catch {
    return { verdict: 'card', reason: 'its arguments could not be read', tags }
  }

  for (const rule of ALWAYS_CARD_PATHS) {
    if (values.some((value) => rule.pattern.test(value))) {
      return { verdict: 'card', reason: rule.reason, tags }
    }
  }

  // Only absolute paths are judged against the root by direct comparison. A
  // relative path is the ordinary case inside a workspace, and resolving one
  // here would be guessing at a working directory this module deliberately
  // does not know — but a relative path that climbs with `..` is trying to
  // leave regardless of where it started, so that cards without needing to be
  // resolved.
  const root = opts?.workspaceRoot
  if (root) {
    for (const value of values) {
      if (climbsOut(value)) {
        return { verdict: 'card', reason: 'it climbs outside the open folder', tags }
      }
      if (isAbsolutePath(value) && !within(root, value)) {
        return { verdict: 'card', reason: 'it reaches outside the open folder', tags }
      }
    }
  }

  for (const rule of ARGUMENT_PATTERNS) {
    if (values.some((value) => rule.pattern.test(value))) {
      return { verdict: 'card', reason: rule.reason, tags }
    }
  }

  const carding = tags.find((t) => CARDING_TAGS.includes(t))
  if (carding) return { verdict: 'card', reason: `it is tagged ${carding}`, tags }

  return { verdict: 'allow', reason: null, tags }
}

/**
 * Zero-width and non-printing characters, stripped from a value before
 * anything else looks at it.
 *
 * `dr` + a zero-width space + `op` reads as `drop` — to a human on a card, or
 * to a model deciding whether to call this tool again — but is not the
 * substring `drop`, so no pattern below would ever match it. Covers the
 * zero-width joiners (U+200B–U+200D), the byte-order mark / zero-width
 * no-break space (U+FEFF), and the C0/C1 control ranges (U+0000–U+001F,
 * U+007F–U+009F). `String.prototype.trim()` catches none of these — it only
 * removes characters with the Unicode `White_Space` property, which these
 * are not — so a value ending in one of them still defeated every
 * `$`-anchored rule even after values were trimmed. Stripped from the whole
 * value, not only the ends: the same character mid-string defeats a
 * substring or word rule exactly as well as one at the boundary defeats an
 * anchor. Written entirely with `\u` escapes rather than the literal
 * characters, so an editor or a diff view cannot silently mangle the one
 * line that exists to catch exactly that kind of tampering.
 */
// eslint-disable-next-line no-control-regex -- the C0/C1 ranges are the point of this pattern, not an accident; see the comment above.
const INVISIBLE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g

/**
 * Every string and number anywhere in the input, flattened, stripped of
 * invisible characters, and trimmed.
 *
 * Normalised here, once, so every rule in `assess` — the `$`-anchored
 * patterns and the word-boundary patterns alike — looks at the same string
 * `isAbsolutePath` and `climbsOut` were already normalising on their own.
 * Before the trim was centralised, a trailing space or newline on a value
 * defeated every `$`-anchored rule (`\.pem$`, `credentials$`, `-f\s*$`, the
 * `.env` rule's `$` alternative) while the path checks, which trimmed
 * independently, stayed unaffected — two paths reading the same value and
 * disagreeing about what it was. The same gap existed one level down for
 * characters `trim()` does not strip at all; see `INVISIBLE_CHARS`.
 *
 * `seen` tracks the current path only — deleted on the way back out — so an
 * object referenced twice is fine and only a genuine cycle throws. Depth is
 * capped, and hitting the cap throws rather than truncating silently: content
 * past the cap is content this function never actually read, and unread
 * content must card for the same reason a cyclic object does, not fall
 * through to an empty scan that defaults to `allow`. The cap is not a claim
 * that deep nesting is inherently more dangerous — it is where "unreadable"
 * starts.
 */
function flatten(value: unknown, seen = new Set<unknown>(), depth = 0): string[] {
  if (depth > 8) throw new Error('input too deep to read')
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return [value.replace(INVISIBLE_CHARS, '').trim()]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (typeof value !== 'object') return []
  if (seen.has(value)) throw new Error('cyclic input')

  seen.add(value)
  const out: string[] = []
  for (const child of Object.values(value as Record<string, unknown>)) {
    out.push(...flatten(child, seen, depth + 1))
  }
  seen.delete(value)
  return out
}

/** `C:\x`, `/x` — the shapes that can be compared to a root without guessing
 *  at a working directory. Takes an already-trimmed value, per `flatten` —
 *  this does not trim again, so there is exactly one place a value's
 *  whitespace is decided, not two agreeing by coincidence. */
function isAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(value)
}

/** A `..` path segment, either slash style, at the start of the value or
 *  after a slash — the shape that climbs out of wherever a relative path
 *  started, whether or not the path as a whole is absolute. Takes an
 *  already-trimmed value, same reason as `isAbsolutePath` above. */
function climbsOut(value: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(value)
}

/** Windows-first: `C:/work` and `C:\work` are the same directory, and case
 *  does not distinguish two paths on this platform. `candidate` is an
 *  already-trimmed value, per `flatten`; `root` is `opts.workspaceRoot`,
 *  supplied directly by the caller rather than flattened from the tool's own
 *  arguments, so it is still trimmed here rather than assumed clean. */
function within(root: string, candidate: string): boolean {
  const norm = (p: string): string => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const r = norm(root)
  const c = norm(candidate)
  return c === r || c.startsWith(`${r}/`)
}
