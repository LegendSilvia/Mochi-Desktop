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
 * Tags for the built-in tools that actually reach here.
 *
 * Everything in `AUTO_APPROVED` short-circuits long before this, so the reads
 * and the agent's own bookkeeping are deliberately absent. A tool that is not
 * listed is not thereby safe — see the unrecognised-built-in rule in
 * `assess()` below, which is exactly what closes that gap for a name that
 * isn't `mcp__`-prefixed. The argument scan and the always-card rules below
 * still apply to everything here regardless of tag.
 *
 * This list previously named `KillShell` and `SlashCommand`, which do not
 * exist as built-in tools, and omitted `PowerShell` — the actual shell tool
 * on Windows, the platform this app targets first — which reached this table
 * with no tags at all and ran Auto-approved with no card, `rm -rf` included.
 * Sourced from the live built-in tool list, not from memory of an older CLI.
 */
export const TOOL_TAGS: Record<string, ToolTag[]> = {
  // Writes.
  Write: ['write'],
  Edit: ['write'],
  NotebookEdit: ['write'],

  // Shells. `Bash` is kept even though this machine's CLI does not offer it,
  // because the same code may run somewhere it does; `PowerShell` is the
  // shell that actually reaches this table here.
  Bash: ['execute'],
  PowerShell: ['execute'],

  // Spawn agents that can do anything a whole session can — at least as
  // consequential as a shell, so judged the same way.
  Task: ['execute'],
  Workflow: ['execute'],

  // Cause work to happen later, outside this turn's supervision.
  CronCreate: ['execute'],
  CronDelete: ['execute'],
  ScheduleWakeup: ['execute'],
  RemoteTrigger: ['execute'],

  // Mutate the working tree.
  EnterWorktree: ['write'],
  ExitWorktree: ['write'],

  // Loads instructions that then act on the caller's behalf.
  Skill: ['execute'],

  // Reach outside the machine.
  // Reaching outward, but only to say something. Neither changes state nor runs
  // code, so `network` is not a carding tag and the classifier gets to judge
  // them on their arguments — which is the whole point of having a classifier.
  SendMessage: ['network'],
  PushNotification: ['network'],
  // `DesignSync` is deliberately absent. Guessing `network` for a tool nobody
  // here can characterise is exactly the move that left `PowerShell` untagged:
  // a confident label standing in for knowledge. Unlisted, it falls to the
  // unrecognised-built-in rule and cards, which is the honest answer until
  // someone can say what it syncs and to where.

  // Read-only bookkeeping.
  CronList: ['read'],
  TaskGet: ['read'],
  TaskList: ['read'],
  TaskOutput: ['read'],
  ReportFindings: ['read'],

  // Task bookkeeping that mutates state.
  TaskCreate: ['write'],
  TaskUpdate: ['write'],
  TaskStop: ['write'],

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
  {
    // Long flags as well as short ones: `rm --recursive --force ./x` is the
    // same command as `rm -rf ./x` and was not matched at all.
    pattern: /\brm\s+(-[a-z]*[rf]|--recursive\b|--force\b|--dir\b)/i,
    reason: 'the arguments contain a recursive remove'
  },
  { pattern: /--force\b|\bpush\s+--force|-f\b\s*$/i, reason: 'the arguments force an operation' },
  { pattern: /\bformat\s+[a-z]:/i, reason: 'the arguments format a drive' },
  {
    pattern: /\bfilter-branch\b|\breset\s+--hard\b|\bpush\b.*\bforce\b/i,
    reason: 'the arguments rewrite history'
  },
  /*
   * The table above spoke only Unix — `rm -rf`, `--force` (double-dash),
   * `format c:` — and nothing here matched `-Force` (single dash, PowerShell's
   * own convention) or a bare `Remove-Item`. That is exactly how
   * `PowerShell` running `Remove-Item -Recurse -Force C:\work` reached
   * `allow`: the shell itself is now tagged `execute` and cards regardless of
   * its arguments, but an *untagged* tool — an MCP wrapper around a Windows
   * shell, say — carrying this same text in its arguments would not have
   * cleared any rule below without these. Added on Windows, the platform this
   * app targets first, for the tool population that actually runs here.
   */
  { pattern: /\bRemove-Item\b/i, reason: 'the arguments remove a file or folder' },
  {
    // Single-dash: PowerShell's flag syntax, not the `--force`/`--recursive`
    // long-flag shape the `rm` rule above already covers.
    pattern: /-Recurse\b|-Force\b/i,
    reason: 'the arguments force a recursive operation'
  },
  {
    pattern: /\brd\s+\/s\b|\brmdir\s+\/s\b|\bdel\s+\/[fq]\b/i,
    reason: 'the arguments contain a recursive or forced delete'
  },
  {
    pattern: /\bFormat-Volume\b|\bClear-Disk\b/i,
    reason: 'the arguments format or clear a disk'
  },
  { pattern: /\bStop-Computer\b/i, reason: 'the arguments shut down the machine' },
  {
    pattern: /\bSet-ExecutionPolicy\b/i,
    reason: 'the arguments change what scripts are allowed to run'
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
  {
    // `credentials` with no extension is the AWS shape; the same file outside
    // `.aws/` is usually `credentials.json` (gcloud, service accounts, a dozen
    // CI tools) and was matched by neither half of the old rule.
    pattern: /[\\/]\.aws[\\/]|\bcredentials(\.(json|ya?ml|ini|toml|txt))?$/i,
    reason: 'it touches stored credentials'
  },
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
  // `Object.hasOwn`, not a bare index: `TOOL_TAGS['__proto__']` walks the
  // prototype chain and hands back an object, and `TOOL_TAGS['constructor']`
  // hands back a function — neither is an array, so `tags.find` below threw
  // and `assess` broke its own contract of always returning a `Consequence`.
  // A later phase calls this where it is the whole decision, and a throw there
  // is not a card, it is an unhandled rejection in a permission check.
  const recognized = Object.hasOwn(TOOL_TAGS, toolName)
  const tags = recognized ? TOOL_TAGS[toolName] : []

  /*
   * An unrecognised *built-in* tool cards outright — it never reaches the
   * classifier as a defer.
   *
   * The population this module judges splits in two. `mcp__`-prefixed names
   * are third-party and genuinely unknowable ahead of time; an unrecognised
   * one keeps deferring to the classifier, same as always, and the argument
   * scan and always-card rules below still stand as its safety net. Every
   * other name is a built-in the CLI itself ships — a finite, versioned set —
   * and this table is meant to have an entry for each one.
   *
   * This rule exists because it did not, once: `PowerShell` — the shell tool
   * on Windows, the platform this app targets first — reached this table with
   * no tags and no entry, `TOOL_TAGS` fell through to `[]`, and Auto ran
   * `Remove-Item -Recurse -Force` with no card at all. Tagging `PowerShell`
   * fixes that one tool; it does nothing for the next tool the CLI adds
   * before this table is updated to know about it. Carding every built-in
   * name this table has never heard of means that gap fails safe — an
   * unfamiliar built-in is a card, not a silent allow — instead of failing
   * open again the next time the tool list changes underneath this file.
   */
  if (!recognized && !toolName.startsWith('mcp__')) {
    return {
      verdict: 'card',
      reason: 'Mochi does not recognise this tool and cannot judge what it can do',
      tags
    }
  }

  /*
   * Every string and number the call carries — and every object *key* it
   * carries — flattened and tested one unit at a time.
   *
   * A `$`-anchored pattern tested against a joined string only fires when the
   * matching value happens to land last in enumeration order, which is an
   * accident of object shape, not a security property: a `.env` path in an
   * early property was invisible to `credentials$` and `-f\b\s*$` whenever a
   * sibling property came after it. Testing each unit on its own makes every
   * rule below order-independent, and that stays the primary pass.
   *
   * `scan.joined` is the second pass, and it exists because per-value testing
   * alone is blind in the other direction: `{cmd:'rm', args:['-rf','./build']}`
   * carries no single value containing `rm -rf`, so every `\s`-containing
   * rule missed an argv-shaped call entirely. Running both passes is strictly
   * narrowing — the joined string is only ever an extra thing to card on — so
   * it reintroduces none of the order-dependence the per-value pass fixed.
   *
   * A failure to read the input is not a reason to wave the call through — an
   * argument you cannot read is an argument you cannot clear — so the catch
   * cards rather than continuing with an empty list, which would silently
   * skip every scan below. Hitting `flatten`'s depth cap is the same kind of
   * failure and throws for the same reason.
   */
  let scan: Scan
  try {
    scan = flatten(input)
  } catch {
    return { verdict: 'card', reason: 'its arguments could not be read', tags }
  }

  for (const rule of ALWAYS_CARD_PATHS) {
    if (scan.units.some((unit) => rule.pattern.test(unit))) {
      return { verdict: 'card', reason: rule.reason, tags }
    }
  }

  // Only absolute paths are judged against the root by direct comparison. A
  // relative path is the ordinary case inside a workspace, and resolving one
  // here would be guessing at a working directory this module deliberately
  // does not know — but a relative path that climbs with `..` is trying to
  // leave regardless of where it started, so that cards without needing to be
  // resolved.
  //
  // `climbsOut` therefore sits *outside* the root check, unlike the absolute
  // comparison below it. It needs no root by construction, and gating it
  // behind one meant `{p:'../../etc/passwd'}` with no folder open was an
  // ordinary allow — the one case where the agent has least context about
  // where it is standing.
  for (const unit of scan.units) {
    if (climbsOut(unit)) {
      return { verdict: 'card', reason: 'it climbs outside the open folder', tags }
    }
  }

  const root = opts?.workspaceRoot
  if (root) {
    for (const unit of scan.units) {
      if (isAbsolutePath(unit) && !within(root, unit)) {
        return { verdict: 'card', reason: 'it reaches outside the open folder', tags }
      }
    }
  }

  for (const rule of ARGUMENT_PATTERNS) {
    if (scan.units.some((unit) => rule.pattern.test(unit))) {
      return { verdict: 'card', reason: rule.reason, tags }
    }
    if (scan.joined.some((line) => rule.pattern.test(line))) {
      return { verdict: 'card', reason: rule.reason, tags }
    }
  }

  const carding = tags.find((t) => CARDING_TAGS.includes(t))
  if (carding) return { verdict: 'card', reason: `it is tagged ${carding}`, tags }

  return { verdict: 'allow', reason: null, tags }
}

/**
 * Zero-width and format characters: **deleted**.
 *
 * `dr` + a zero-width space + `op` reads as `drop` — to a human on a card, or
 * to a model deciding whether to call this tool again — but is not the
 * substring `drop`, so no pattern above would ever match it. Deleting is the
 * only normalisation that recovers the word, and it is safe here because none
 * of these characters ever separates two tokens for a shell, an SQL parser or
 * a filesystem: they render as nothing and mean nothing. Covers the zero-width
 * space and joiners (U+200B–U+200D), the byte-order mark / zero-width no-break
 * space (U+FEFF), the soft hyphen (U+00AD) and the word joiner (U+2060).
 * `String.prototype.trim()` catches none of these — it only removes characters
 * with the Unicode `White_Space` property, which these are not — so a value
 * ending in one still defeated every `$`-anchored rule even after values were
 * trimmed. Written entirely with `\u` escapes rather than the literal
 * characters, so an editor or a diff view cannot silently mangle the one line
 * that exists to catch exactly that kind of tampering.
 */
const ZERO_WIDTH_CHARS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g

/**
 * Whitespace-class control characters: **replaced with a single space**.
 *
 * Tab, LF, VT, FF and CR (U+0009–U+000D). These were previously deleted along
 * with everything else non-printing, which welded the end of one line onto the
 * start of the next: `cd /tmp` + LF + `rm -rf ./cache` became
 * `cd /tmprm -rf ./cache`, so `\brm\s+-[a-z]*[rf]` had no `rm` on a word
 * boundary left to match, and an ordinary two-line shell script came back
 * `allow`. `rm` + TAB + `-rf /` failed the same way, with nothing left for
 * `\s+` to match at all. The trigger was never a crafted character; it was
 * a newline in a multi-line command.
 *
 * These are exactly the characters whose whole job is to separate tokens, so
 * for them the two intents do not conflict: a space preserves the boundary the
 * character was there to create, and no word is ever split by one that was not
 * already two words.
 */
// eslint-disable-next-line no-control-regex -- tab, LF, VT, FF and CR are the point of this pattern, not an accident; see the comment above.
const WHITESPACE_CONTROLS = /[\u0009-\u000D]/g

/**
 * The remaining C0/C1 controls: **both readings kept**.
 *
 * U+0000–U+0008, U+000E–U+001F and U+007F–U+009F. Here the two intents above
 * genuinely conflict, and there is no single answer that is right for both:
 *
 *   - `dr` + NUL + `op` is the zero-width attack again, and only *deleting*
 *     the character recovers the word `drop`.
 *   - `cd /tmp` + NUL + `rm -rf .` is the newline attack again, and only
 *     *replacing* it with a space keeps `rm` on a word boundary.
 *
 * Choosing either alone leaves the other exploitable, and choosing per
 * character would be guessing at how some downstream shell, parser or
 * filesystem happens to treat a control byte — a guess this module has no
 * business making, and exactly the kind of guess that produced the earlier
 * bugs in this class. So both readings of the value are built and every rule
 * is tested against both: the call cards if *either* reading is dangerous.
 * That is the fail-closed direction, and the cost is bounded, because the two
 * readings differ only for a value that actually contains one of these
 * characters — which ordinary arguments never do.
 */
// eslint-disable-next-line no-control-regex -- the C0/C1 ranges are the point of this pattern, not an accident; see the comment above.
const AMBIGUOUS_CONTROLS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g

/**
 * One string, as every reading of it that a rule should be tested against.
 *
 * Returns a single reading when the two agree — the ordinary case, and the
 * only case for any argument that does not carry a control character — and two
 * when an ambiguous control makes them differ.
 *
 * Also adds a percent-decoded reading: `%2e%2e%2f` is `../` to every URL-aware
 * consumer of a path, while `climbsOut` sees nothing whatsoever in the encoded
 * form. Decoded once rather than to a fixed point, because one pass is what an
 * ordinary consumer does; `decodeURIComponent` throws on a malformed escape,
 * which is not a decodable path to anything else either, and the raw value has
 * already been added by then, so nothing goes unscanned.
 */
function readings(value: string): string[] {
  const out: string[] = []
  const add = (raw: string): void => {
    const base = raw.replace(ZERO_WIDTH_CHARS, '').replace(WHITESPACE_CONTROLS, ' ')
    const deleted = base.replace(AMBIGUOUS_CONTROLS, '').trim()
    const spaced = base.replace(AMBIGUOUS_CONTROLS, ' ').trim()
    if (!out.includes(deleted)) out.push(deleted)
    if (!out.includes(spaced)) out.push(spaced)
  }
  add(value)
  if (value.includes('%')) {
    try {
      const decoded = decodeURIComponent(value)
      if (decoded !== value) add(decoded)
    } catch {
      // Not decodable, so not a path to anything else either.
    }
  }
  return out
}

/** What a flattened input offers the rules in `assess`. */
interface Scan {
  /**
   * Every string the call carries — values *and* object keys — in every
   * reading of each. The primary pass, and order-independent by construction.
   */
  units: string[]
  /**
   * The values only, in encounter order, joined with a single space; one entry
   * per reading. Keys are deliberately absent: a key name sitting between two
   * values would break the very adjacency this pass exists to see, turning
   * `{cmd:'rm', args:['-rf','x']}` into `cmd rm args -rf x` and hiding
   * `rm -rf` all over again. Array indices are absent for the same reason.
   */
  joined: string[]
}

/**
 * Every string and number anywhere in the input, normalised.
 *
 * Normalised here, once, so every rule in `assess` — the `$`-anchored patterns
 * and the word-boundary patterns alike — looks at the same string
 * `isAbsolutePath` and `climbsOut` were already normalising on their own.
 * Before the trim was centralised, a trailing space or newline on a value
 * defeated every `$`-anchored rule (`\.pem$`, `credentials$`, `-f\s*$`,
 * the `.env` rule's `$` alternative) while the path checks, which trimmed
 * independently, stayed unaffected — two paths reading the same value and
 * disagreeing about what it was.
 *
 * Object *keys* are walked as well as values. `Object.values()` alone meant a
 * path-keyed map — a batch writer's `{files:{'/home/u/.ssh/id_rsa': '…'}}`, an
 * env map, a header map, all ordinary MCP shapes — carried its filenames
 * somewhere nothing ever looked, which defeated `ALWAYS_CARD_PATHS` outright
 * despite this module documenting those as firing "whatever the tags or the
 * tool". A key is read at the same depth as the child it names, so the cap
 * counts it the same way, and it is a string, so the cycle guard has nothing
 * to track for it.
 *
 * `seen` tracks the current path only — deleted on the way back out — so an
 * object referenced twice is fine and only a genuine cycle throws. Depth is
 * capped, and hitting the cap throws rather than truncating silently: content
 * past the cap is content this function never actually read, and unread
 * content must card for the same reason a cyclic object does, not fall through
 * to an empty scan that defaults to `allow`. The cap is not a claim that deep
 * nesting is inherently more dangerous — it is where "unreadable" starts.
 */
function flatten(input: unknown): Scan {
  const units: string[] = []
  /** One entry per value: that value's readings, in encounter order. */
  const ordered: string[][] = []

  const walk = (value: unknown, seen: Set<unknown>, depth: number): void => {
    if (depth > 8) throw new Error('input too deep to read')
    if (value === null || value === undefined) return
    if (typeof value === 'string') {
      const variants = readings(value)
      units.push(...variants)
      ordered.push(variants)
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      units.push(String(value))
      ordered.push([String(value)])
      return
    }
    if (typeof value !== 'object') return
    if (seen.has(value)) throw new Error('cyclic input')

    seen.add(value)
    if (Array.isArray(value)) {
      for (const child of value) walk(child, seen, depth + 1)
    } else {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        // A key counts against the cap exactly as its child does, so a key one
        // level past it is unread content and throws, never a silent skip.
        if (depth + 1 > 8) throw new Error('input too deep to read')
        // Scanned, but never joined — see `Scan.joined`.
        units.push(...readings(key))
        walk(child, seen, depth + 1)
      }
    }
    seen.delete(value)
  }

  walk(input, new Set<unknown>(), 0)

  // One joined line per reading: the first reading of every value, and the
  // last reading of every value. These are the same line unless some value
  // carried an ambiguous control, in which case both are tested.
  const first = ordered.map((v) => v[0]).join(' ')
  const last = ordered.map((v) => v[v.length - 1]).join(' ')
  return { units, joined: first === last ? [first] : [first, last] }
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
