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
   * Everything the call carries, as one searchable body of text.
   *
   * A failure to read it is not a reason to wave the call through — an
   * argument you cannot read is an argument you cannot clear — so the catch
   * cards rather than continuing with an empty string, which would silently
   * skip every scan below.
   */
  let values: string[]
  try {
    values = flatten(input)
  } catch {
    return { verdict: 'card', reason: 'its arguments could not be read', tags }
  }
  const text = values.join('\n')

  for (const rule of ALWAYS_CARD_PATHS) {
    if (rule.pattern.test(text)) return { verdict: 'card', reason: rule.reason, tags }
  }

  // Only absolute paths are judged against the root. A relative path is the
  // ordinary case inside a workspace, and resolving one here would be guessing
  // at a working directory this module deliberately does not know.
  const root = opts?.workspaceRoot
  if (root) {
    for (const value of values) {
      if (isAbsolutePath(value) && !within(root, value)) {
        return { verdict: 'card', reason: 'it reaches outside the open folder', tags }
      }
    }
  }

  for (const rule of ARGUMENT_PATTERNS) {
    if (rule.pattern.test(text)) return { verdict: 'card', reason: rule.reason, tags }
  }

  const carding = tags.find((t) => CARDING_TAGS.includes(t))
  if (carding) return { verdict: 'card', reason: `it is tagged ${carding}`, tags }

  return { verdict: 'allow', reason: null, tags }
}

/**
 * Every string and number anywhere in the input, flattened.
 *
 * `seen` tracks the current path only — deleted on the way back out — so an
 * object referenced twice is fine and only a genuine cycle throws. Depth is
 * capped because a deeply nested argument is not more dangerous than a shallow
 * one, and an unbounded walk on hostile input is its own problem.
 */
function flatten(value: unknown, seen = new Set<unknown>(), depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
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
 *  at a working directory. */
function isAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(value.trim())
}

/** Windows-first: `C:/work` and `C:\work` are the same directory, and case
 *  does not distinguish two paths on this platform. */
function within(root: string, candidate: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const r = norm(root)
  const c = norm(candidate.trim())
  return c === r || c.startsWith(`${r}/`)
}
