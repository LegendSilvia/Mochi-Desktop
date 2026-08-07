# Permission Modes — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Auto-with-a-chosen-model actually work on the subscription backend — a consequence table that vetoes dangerous calls outright, and a classifier that runs the user's chosen model on everything the table lets through.

**Architecture:** Phase 1 left `toSdkPermissionMode('auto', model)` returning `'default'`, which means `canUseTool` already fires for every call outside `AUTO_APPROVED`. That is the single insertion point. A pure consequence table in `src/shared/` decides whether a call may be classified at all; `src/main/classifier.ts` runs the chosen model with `maxTurns: 1` on whatever survives. The classifier can only ever narrow what runs — a table verdict of `card` is not appealable.

**Tech Stack:** TypeScript, Electron, React 19, `@anthropic-ai/claude-agent-sdk`, Hono.

**Reads:** the approved spec at `docs/superpowers/specs/2026-08-07-permission-modes-design.md`, sections "The consequence table" and "Auto, three paths".

## Global Constraints

- **The classifier may only narrow, never widen.** A `card` verdict from the consequence table means the card is shown; no model output can override it. Build it so this is structurally true, not merely the current order of two `if`s.
- **Fail closed, always.** Classifier error, timeout, unparseable answer, missing model — every one of these shows the card. A classifier that is down must never become a classifier that says yes.
- **The classifier only runs for calls that would otherwise show a card.** `AUTO_APPROVED` still short-circuits first, so reads and the agent's own bookkeeping cost nothing. Do not modify `AUTO_APPROVED`.
- **Bypass permissions stays unreachable.** Do not widen `PermissionMode`, do not set `allowDangerouslySkipPermissions`.
- **Native Auto is untouched.** When `autoClassifierModel` is absent the SDK's own `'auto'` runs and none of this code executes. Do not layer the table onto the native path — two policies disagreeing is worse than one.
- **Phase 2 is the subscription backend only.** The Mastra backend is Phase 3. Do not add `requireToolApproval` here.
- `npm run typecheck` and `npm run build` must pass; `npx eslint <changed files>` must report 0 errors. The repo has ~10.8k pre-existing CRLF prettier warnings and 2 pre-existing eslint errors in `src/renderer/src/components/shell/CommandPalette.tsx` — not yours, leave them, and never run `npm run format`.
- **No test runner.** Pure modules get a Node script under `scripts/`, run as `node scripts/<name>.mjs`, importing the real `.ts` via a `file:///` URL. Node 26 strips types natively. Pattern: `scripts/check-permission-modes.mjs`.
- Run `npx prettier --write` only on files authored in full. Surgical edits keep their formatting.

---

## File Structure

**Created:**
- `src/shared/consequences.ts` — tool tags, the argument scan, the always-card rules, and `assess()`. Pure; no `main` or `renderer` imports. Serves Phase 3 unchanged.
- `scripts/check-consequences.mjs` — assertions against the above.
- `src/main/classifier.ts` — runs the chosen model and returns a decision. Owns its own timeout and all its failure modes.

**Modified:**
- `src/main/agent-sdk-route.ts` — consult the table and the classifier at the top of `canUseTool`; carry the reason onto the card.
- `src/renderer/src/components/chat/PermissionCard.tsx` — show why a call was escalated.
- `src/renderer/src/components/chat/ModePicker.tsx` — drop "not active yet".
- `src/shared/types.ts` — `ApprovalRequest` gains an optional escalation reason.

---

### Task 1: The consequence table

Pure, and the only part testable without Electron. Everything downstream trusts it, so it is written and proved first.

**Files:**
- Create: `src/shared/consequences.ts`
- Create: `scripts/check-consequences.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ToolTag = 'read' | 'write' | 'data' | 'execute' | 'network' | 'destructive'`
  - `type Consequence = { verdict: 'allow' | 'card'; reason: string | null; tags: ToolTag[] }`
  - `assess(toolName: string, input: unknown, opts?: { workspaceRoot?: string }): Consequence`
  - `TOOL_TAGS: Record<string, ToolTag[]>`

- [ ] **Step 1: Write the failing test**

Create `scripts/check-consequences.mjs`:

```js
import { assess } from 'file:///C:/Development/Mochi-Desktop/src/shared/consequences.ts'

let fail = 0
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail++
    console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)
  } else console.log(`ok   ${label}`)
}
const v = (name, input, opts) => assess(name, input, opts).verdict
const B = String.fromCharCode(92) // backslash, kept out of string literals

// A tag that writes or executes always cards, whatever the arguments say.
eq('Write cards', v('Write', { file_path: 'a.ts', content: 'x' }), 'card')
eq('Edit cards', v('Edit', { file_path: 'a.ts' }), 'card')
eq('Bash cards', v('Bash', { command: 'ls' }), 'card')

// A benign call on an untagged tool is the classifier's to judge.
eq('unknown mcp tool defers', v('mcp__github__list_issues', { repo: 'x' }), 'allow')
eq('read-tagged tool defers', v('mcp__mochi__searchDocs', { q: 'x' }), 'allow')

// The argument scan is what tags alone cannot do.
eq('benign sql defers', v('mcp__db__runSql', { q: 'SELECT * FROM users' }), 'allow')
eq('drop in args cards', v('mcp__db__runSql', { q: 'DROP TABLE users' }), 'card')
eq('delete in args cards', v('mcp__db__runSql', { q: 'delete from users' }), 'card')
eq('rm -rf cards', v('mcp__sh__run', { cmd: 'rm -rf /tmp/x' }), 'card')
eq('force push cards', v('mcp__git__run', { cmd: 'git push --force' }), 'card')
eq('nested args are scanned', v('mcp__x__y', { a: { b: ['truncate table t'] } }), 'card')

// The scan matches words, not substrings — or every `undelete` and
// `dropdown` becomes a card and Auto is worthless.
eq('dropdown is not drop', v('mcp__x__y', { s: 'render the dropdown' }), 'allow')
eq('undeleted is not delete', v('mcp__x__y', { s: 'undeleted rows' }), 'allow')

// Credentials and Mochi's own state always card, whatever the tags say.
eq('env file cards', v('mcp__fs__read', { path: '/app/.env' }), 'card')
eq('id_rsa cards', v('mcp__fs__read', { path: '/home/u/.ssh/id_rsa' }), 'card')
eq('mochi appdata cards', v('mcp__fs__read', { path: 'C:' + B + 'Users' + B + 'u' + B + 'AppData' + B + 'Roaming' + B + 'Mochi' + B + 'settings.json' }), 'card')
eq('git history rewrite cards', v('mcp__git__run', { cmd: 'git filter-branch' }), 'card')

// Outside the workspace root is a card even for a tool that only reads.
eq(
  'outside workspace cards',
  v('mcp__fs__read', { path: 'C:' + B + 'Windows' + B + 'System32' + B + 'x' }, { workspaceRoot: 'C:' + B + 'work' + B + 'proj' }),
  'card'
)
eq(
  'inside workspace defers',
  v('mcp__fs__read', { path: 'C:' + B + 'work' + B + 'proj' + B + 'src' + B + 'a.ts' }, { workspaceRoot: 'C:' + B + 'work' + B + 'proj' }),
  'allow'
)

// A card verdict always says why — the reason reaches the user.
const carded = assess('Bash', { command: 'ls' })
eq('card carries a reason', typeof carded.reason, 'string')
eq('allow carries no reason', assess('mcp__x__y', { a: 1 }).reason, null)

// Malformed input must not throw. Fail closed if anything is unreadable.
eq('null input does not throw', v('mcp__x__y', null), 'allow')
eq('circular input does not throw', (() => {
  const a = {}
  a.self = a
  return v('mcp__x__y', a)
})(), 'card')

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-consequences.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` — the module does not exist yet.

- [ ] **Step 3: Write the module**

Create `src/shared/consequences.ts` with exactly this content.

```ts
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
  'mcp__mochi__saveDoc': ['write'],
  'mcp__mochi__searchDocs': ['read']
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
  { pattern: /\bfilter-branch\b|\breset\s+--hard\b|\bpush\b.*\bforce\b/i, reason: 'the arguments rewrite history' }
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
  { pattern: /[\\/]AppData[\\/]Roaming[\\/]Mochi[\\/]/i, reason: 'it touches Mochi’s own configuration' },
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
```

Five properties the check script pins, stated so a later edit does not lose them:

1. Order is always-card paths → workspace root → argument patterns → carding tags → `allow`. First hit wins and supplies the reason.
2. Unreadable input cards. It never falls through to an empty scan.
3. `assess` never throws, for any input shape.
4. `reason` is non-null exactly when `verdict === 'card'`.
5. Argument patterns match on word boundaries — `dropdown` and `undeleted` are not matches.

> **Corrected during execution — the code above was wrong in three ways, and
> the check script as written passed against all three.** Read the fix-round
> section of `task-1-report.md` for what shipped. In summary:
>
> - **Patterns must be tested against each value individually, not against the
>   values joined into one string.** A `$`-anchored rule (`\.env$`, `\.pem$`,
>   `credentials$`, `-f\s*$`) only fires against the joined form when the
>   sensitive value happens to be last in `Object.values()` order. So
>   `{ path: '/app/.env', other: 'x' }` did **not** card. That is a clean bypass
>   of the credentials rule for any untagged tool.
> - **Hitting `flatten`'s depth cap must card, exactly as a cycle does.**
>   Returning `[]` made content nested past depth 8 invisible to every scan, so
>   an untagged tool got `allow` — the opposite of this module's own stated
>   principle that unreadable input cannot be cleared.
> - **A `..` path segment must card when a `workspaceRoot` is set.**
>   `isAbsolutePath('../../etc/passwd')` is false, so relative escapes skipped
>   the root check entirely.
>
> The lesson worth keeping: every assertion in the original check script used a
> **single-property** object, which is precisely the shape that hides the first
> bug. Test data that is uniformly simpler than production data proves less than
> it appears to.

- [ ] **Step 4: Run the check to verify it passes**

Run: `node scripts/check-consequences.mjs`
Expected: PASS — `all passed`, exit 0.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck
npx eslint src/shared/consequences.ts
npx prettier --write src/shared/consequences.ts
git add src/shared/consequences.ts scripts/check-consequences.mjs
git commit -m "feat: a table of what a tool call would cost if it were wrong"
```

---

### Task 2: The classifier

**Files:**
- Create: `src/main/classifier.ts`

**Interfaces:**
- Consumes: `assess`, `Consequence` from Task 1.
- Produces: `classify(opts: ClassifyOptions): Promise<ClassifierVerdict>` where
  - `interface ClassifyOptions { model: string; toolName: string; input: unknown; workspaceRoot?: string; agentTask?: string; signal?: AbortSignal; appVersion: string }`
  - `type ClassifierVerdict = { decision: 'allow' | 'deny' | 'ask'; reason: string }`

- [ ] **Step 1: Export the env helper**

`subscriptionEnv` is a module-scope function in `src/main/agent-sdk-route.ts:74`. Add `export` to it so the classifier can reuse it rather than keeping a second copy of the same environment that would drift.

- [ ] **Step 2: Write the module**

Create `src/main/classifier.ts`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import { assess } from '../shared/consequences'
import { subscriptionEnv } from './agent-sdk-route'

/**
 * The chosen-model classifier for Auto.
 *
 * Native Auto runs Anthropic's own classifier and never reaches this file. This
 * is the other arm: the user named a model in the Auto submenu, so that model
 * gets a say on each call the consequence table did not already stop.
 *
 * It can only ever narrow. `assess()` runs first and returns before the model
 * is even asked, so a `card` verdict is not something the model can appeal —
 * the worst a confused or hostile model can do is ask for a permission card
 * that would have been shown anyway.
 */

export interface ClassifyOptions {
  /** Router id of the model the user chose in the Auto submenu. */
  model: string
  toolName: string
  input: unknown
  workspaceRoot?: string
  /** Cancels with the turn, so a stopped run leaves no model call behind. */
  signal?: AbortSignal
  appVersion: string
}

export type ClassifierVerdict = {
  decision: 'allow' | 'deny' | 'ask'
  reason: string
}

/**
 * Long enough for a small model to answer, short enough that a permission
 * prompt does not feel hung. The user is watching a blocked turn while this
 * runs, so the timeout is a UI budget, not a network one.
 */
const CLASSIFIER_TIMEOUT_MS = 15_000

/** What of the arguments goes into the prompt. A whole-file Write would
 *  otherwise put the file in the context of a yes/no question. */
const ARGS_MAX = 3000

const SYSTEM_PROMPT =
  'You decide whether a tool call may run without interrupting the user. ' +
  'You answer with one JSON object and nothing else. You never use tools, ' +
  'and you never explain yourself outside the JSON.'

export async function classify(opts: ClassifyOptions): Promise<ClassifierVerdict> {
  // The table first, and it is final. This ordering is the whole safety
  // property: a call it stops never reaches the model at all, so no model
  // output can widen what runs.
  const table = assess(opts.toolName, opts.input, { workspaceRoot: opts.workspaceRoot })
  if (table.verdict === 'card') {
    return { decision: 'ask', reason: table.reason ?? 'a safety rule stopped it' }
  }

  let args: string
  try {
    args = JSON.stringify(opts.input) ?? ''
  } catch {
    return { decision: 'ask', reason: 'its arguments could not be read' }
  }

  const prompt = [
    `Tool: ${opts.toolName}`,
    opts.workspaceRoot ? `Open folder: ${opts.workspaceRoot}` : 'No folder is open.',
    `Arguments: ${args.slice(0, ARGS_MAX)}`,
    '',
    'Answer with exactly this JSON and nothing else:',
    '{"decision":"allow"|"deny"|"ask","reason":"<one short sentence>"}',
    '',
    'allow — routine and reversible, the user would not want to be asked.',
    'deny  — clearly destructive or outside what was asked for.',
    'ask   — anything else.',
    '',
    'Answer "ask" whenever you are unsure. A needless question costs the user ' +
      'one click; a wrong "allow" can cost them work they cannot get back.'
  ].join('\n')

  try {
    const text = await withTimeout(runModel(prompt, opts), CLASSIFIER_TIMEOUT_MS, opts.signal)
    return parseVerdict(text)
  } catch {
    // Timeout, abort, a model that is not reachable, anything at all. A
    // classifier that is down must never become a classifier that says yes.
    return { decision: 'ask', reason: 'the classifier could not be reached' }
  }
}

async function runModel(prompt: string, opts: ClassifyOptions): Promise<string> {
  let out = ''
  for await (const raw of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: opts.model,
      // It answers a question; it does not act. An empty allow-list plus no
      // canUseTool would stall any tool it tried, but maxTurns 1 means it
      // never gets a second turn to try one.
      allowedTools: [],
      maxTurns: 1,
      // No settings, no skills. Those exist for the conversation, not for a
      // yes/no judgement, and loading them here would widen what a permission
      // check can read.
      settingSources: [],
      skills: [],
      env: subscriptionEnv(opts.appVersion)
    }
  })) {
    const message = raw as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } }
    if (message.type !== 'assistant') continue
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text' && block.text) out += block.text
    }
  }
  return out
}

/** Rejects on timeout or abort so the caller's single catch handles both. */
function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('classifier timed out')), ms)
    const onAbort = (): void => reject(new Error('classifier aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    work
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      })
  })
}

/**
 * The model's answer, or `ask`.
 *
 * Models wrap JSON in prose and code fences however firmly you ask them not
 * to, so the first balanced object in the text is taken rather than the whole
 * string being parsed. Anything that is not exactly one of the three decisions
 * is `ask` — including a model that invents a fourth.
 */
function parseVerdict(text: string): ClassifierVerdict {
  const match = text.match(/\{[\s\S]*?\}/)
  if (!match) return { decision: 'ask', reason: 'the classifier did not answer in a usable form' }
  try {
    const parsed = JSON.parse(match[0]) as { decision?: unknown; reason?: unknown }
    const decision = parsed.decision
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') {
      return { decision: 'ask', reason: 'the classifier gave no clear answer' }
    }
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'the classifier gave no reason'
    return { decision, reason }
  } catch {
    return { decision: 'ask', reason: 'the classifier did not answer in a usable form' }
  }
}
```

Check before you build on it: `subscriptionEnv` returns `Record<string, string | undefined>`, and the SDK's `env` option may want a narrower type. If it does not typecheck, fix it at the helper rather than casting at the call site — a cast here would hide the same problem from `agent-sdk-route.ts`, which calls it too.

Watch for an import cycle: `classifier.ts` imports from `agent-sdk-route.ts`, which Task 3 makes import from `classifier.ts`. If that proves to be a problem at runtime rather than just at typecheck, move `subscriptionEnv` into its own small module and import it from both. Say what you found in your report.

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — Expected: PASS.
Run: `npx eslint src/main/classifier.ts src/main/agent-sdk-route.ts` — Expected: 0 errors.

This file imports the Agent SDK and cannot be exercised by a Node script. State plainly in your report that its behaviour is unverified beyond typecheck, and list what a Windows pass would need to confirm.

`parseVerdict` and `withTimeout` are pure enough to test if you extract them, but do not restructure the module for testability without saying so — a second file for two helpers may cost more than it proves.

- [ ] **Step 4: Commit**

```bash
npx prettier --write src/main/classifier.ts
git add src/main/classifier.ts
git commit -m "feat: a classifier that can only ever narrow"
```

---

### Task 3: Wire it into the permission path

**Files:**
- Modify: `src/main/agent-sdk-route.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Consumes: `classify` from Task 2, `assess` from Task 1.
- Produces: `ApprovalRequest.escalationReason?: string` on the `data-permission` payload and on `bus.emitApproval`.

- [ ] **Step 1: Carry a reason on the approval types**

In `src/shared/types.ts`, add to `ApprovalRequest`:

```ts
  /** Why this reached a card rather than running. Set when Auto escalated it —
   *  the consequence table's rule, or the classifier's own words. Absent in
   *  Manual and Accept edits, where "because you asked to be asked" is the
   *  whole answer and saying it would be noise. */
  escalationReason?: string
```

- [ ] **Step 2: Classify at the top of `canUseTool`**

In `src/main/agent-sdk-route.ts`, add `import { classify } from './classifier'`, then insert this at the very start of the `canUseTool` callback (~line 1817) — **before** the `const id = randomUUID()` line and the `data-permission` chunk:

```ts
                /*
                 * Auto with a chosen model: that model answers first.
                 *
                 * Only this arm. Native Auto (no model named) is the SDK's own
                 * classifier and never reaches here, and Manual and Accept
                 * edits must arrive at the card exactly as they did before —
                 * which is why this returns early or falls through, and never
                 * rewrites the path below.
                 */
                let escalationReason: string | undefined
                const classifierModel =
                  sessionMode(chatId) === 'auto'
                    ? load().sessions.find((s) => s.id === chatId)?.autoClassifierModel
                    : undefined

                if (classifierModel) {
                  try {
                    const verdict = await classify({
                      model: classifierModel,
                      toolName,
                      input: toolInput,
                      workspaceRoot: workspace.cwd || undefined,
                      signal,
                      appVersion
                    })
                    if (verdict.decision === 'allow') return { behavior: 'allow' }
                    if (verdict.decision === 'deny') {
                      return { behavior: 'deny', message: verdict.reason }
                    }
                    escalationReason = verdict.reason
                  } catch (err) {
                    // `classify` is written not to throw, so this is the belt to
                    // its braces. A throw escaping into the SDK here would stall
                    // the turn on a tool nobody was ever asked about.
                    console.warn('[mochi] classifier threw:', err)
                    escalationReason = 'the classifier failed'
                  }
                }
```

Then thread `escalationReason` into the two places the request is announced — the `data-permission` chunk's `data` object, and the `bus.emitApproval` call — both already in this callback:

```ts
                    escalationReason,
```

`{ behavior: 'allow' }` with no other field is valid: `updatedInput` is optional on the SDK's allow variant (`sdk.d.ts:2114-2119`). Do not pass `updatedInput: toolInput` — echoing the input back claims you modified it.

Two things to confirm rather than assume, because the surrounding code has moved since this plan was written:

- That `workspace`, `signal`, `appVersion` and `chatId` are all genuinely in scope at that point. If any is not, find the right identifier rather than inventing one, and say so in your report.
- That making this callback's body `await` something new does not change `canUseTool`'s signature — it is already `async`, so it should not, but check.

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — Expected: PASS.
Run: `npx eslint src/main/agent-sdk-route.ts` — Expected: 0 errors.
Run: `node scripts/check-consequences.mjs && node scripts/check-permission-modes.mjs` — Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/main/agent-sdk-route.ts src/shared/types.ts
git commit -m "feat: in Auto, the chosen model answers before you have to"
```

---

### Task 4: Say why, and stop saying "not active yet"

**Files:**
- Modify: `src/renderer/src/components/chat/PermissionCard.tsx`
- Modify: `src/renderer/src/components/chat/ModePicker.tsx`

- [ ] **Step 1: Show the escalation reason on the card**

`PermissionCard.tsx` already renders a `reason` line for `blockedPath` ("Stopped because it touches …"). Add `escalationReason?: string` to `PermissionRequest` and render it in the same place and style. When both exist, show the escalation reason first — it is the more specific statement of why this call stopped.

The point is that a user in Auto who gets a card can see whether it was a rule or the model's judgement that stopped it. Word it so those read differently.

- [ ] **Step 2: Drop the "not active yet" label**

`ModePicker.tsx` currently heads the Auto model list with "Or a model of your own — not active yet" — a Phase 1 honesty note that is now false. Replace it with wording that says what choosing a model actually does: that model judges each call the safety rules did not already stop.

Search the file for any other Phase 1 caveat about the classifier being inert and remove those too.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck
npm run build
npx eslint src/renderer/src/components/chat/PermissionCard.tsx src/renderer/src/components/chat/ModePicker.tsx
git add src/renderer/src/components/chat/
git commit -m "feat: an Auto card says what stopped it"
```

- [ ] **Step 4: Hand-verification list — needs Windows**

Not runnable from the development environment. Record in the report, do not claim any of it works:

1. Auto + a chosen model: a `Write` still cards (table veto), and the card says why.
2. Auto + a chosen model: a benign unknown MCP call runs without a card.
3. Auto + a chosen model with the network down: every call cards rather than running.
4. Native Auto (no model chosen) is unaffected — none of this code runs.
5. Manual and Accept edits are unaffected.

---

## What Phase 2 does not do

- **The Mastra backend still ignores mode entirely.** Phase 3. The consequence table is written to serve it unchanged — `assess()` alone is the whole decision there.
- **No per-tool user overrides.** The table is code, not configuration. If it proves wrong in practice that is evidence for changing it, not for a settings screen.
- **The classifier is not cached.** Every call the table lets through costs a model round-trip. `AUTO_APPROVED` bounds this to calls that would otherwise have carded, which is the intended ceiling; revisit only if it proves too slow in real use.
