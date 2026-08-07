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
eq(
  'mochi appdata cards',
  v('mcp__fs__read', {
    path:
      'C:' +
      B +
      'Users' +
      B +
      'u' +
      B +
      'AppData' +
      B +
      'Roaming' +
      B +
      'Mochi' +
      B +
      'settings.json'
  }),
  'card'
)
eq('git history rewrite cards', v('mcp__git__run', { cmd: 'git filter-branch' }), 'card')

// Outside the workspace root is a card even for a tool that only reads.
eq(
  'outside workspace cards',
  v(
    'mcp__fs__read',
    { path: 'C:' + B + 'Windows' + B + 'System32' + B + 'x' },
    { workspaceRoot: 'C:' + B + 'work' + B + 'proj' }
  ),
  'card'
)
eq(
  'inside workspace defers',
  v(
    'mcp__fs__read',
    { path: 'C:' + B + 'work' + B + 'proj' + B + 'src' + B + 'a.ts' },
    { workspaceRoot: 'C:' + B + 'work' + B + 'proj' }
  ),
  'allow'
)

// A card verdict always says why — the reason reaches the user.
const carded = assess('Bash', { command: 'ls' })
eq('card carries a reason', typeof carded.reason, 'string')
eq('allow carries no reason', assess('mcp__x__y', { a: 1 }).reason, null)

// Malformed input must not throw. Fail closed if anything is unreadable.
eq('null input does not throw', v('mcp__x__y', null), 'allow')
eq(
  'circular input does not throw',
  (() => {
    const a = {}
    a.self = a
    return v('mcp__x__y', a)
  })(),
  'card'
)

// Fix round 1: every rule below must fire regardless of where the
// sensitive value falls in the object — testing a joined string only
// caught a `$`-anchored pattern when the match happened to be last.
eq('env file cards, not last', v('mcp__fs__read', { path: '/app/.env', other: 'x' }), 'card')
eq(
  'id_rsa cards, not last',
  v('mcp__fs__read', { path: '/home/u/.ssh/id_rsa', other: 'x' }),
  'card'
)
eq(
  'aws credentials cards, not last',
  v('mcp__fs__read', { path: '/home/u/.aws/credentials', other: 'x' }),
  'card'
)
eq(
  'mochi appdata cards, not last',
  v('mcp__fs__read', {
    path:
      'C:' +
      B +
      'Users' +
      B +
      'u' +
      B +
      'AppData' +
      B +
      'Roaming' +
      B +
      'Mochi' +
      B +
      'settings.json',
    other: 'x'
  }),
  'card'
)
eq(
  'key file cards, not last',
  v('mcp__fs__read', { path: '/home/u/secret.pem', other: 'x' }),
  'card'
)

// Fix round 1: a `$`-anchored pattern must still fire when the matching
// value has a trailing sibling property.
eq(
  'force push cards with trailing sibling',
  v('mcp__git__run', { cmd: 'git push -f', cwd: '/repo' }),
  'card'
)

// Fix round 1: content past the depth cap must not silently vanish from the
// scan and default to allow — it must card, the same as a cycle.
const nest = (n, value) => (n <= 0 ? value : { deep: nest(n - 1, value) })
eq('drop nested past depth 8 cards', v('mcp__x__y', nest(9, 'DROP TABLE students')), 'card')

// Fix round 1: a relative path that climbs with `..` must card once a
// workspace root is set, even though it is never absolute.
eq(
  'relative escape cards',
  v(
    'mcp__fs__read',
    { path: '..' + B + '..' + B + 'etc' + B + 'passwd' },
    { workspaceRoot: 'C:' + B + 'work' + B + 'proj' }
  ),
  'card'
)

// Fix round 2: a trailing space or newline must not defeat a `$`-anchored
// rule. ALWAYS_CARD_PATHS and ARGUMENT_PATTERNS tested the raw value while
// isAbsolutePath/climbsOut tested value.trim() — one untrimmed value could
// pass the credential rules and still be judged "inside the workspace" by
// the path rules a moment later. Every value is now trimmed once, in
// `flatten`, before any rule sees it.
eq(
  'key file cards with trailing space',
  v('mcp__fs__read', { path: '/home/u/secret.pem ' }),
  'card'
)
eq(
  'key file cards with trailing newline',
  v('mcp__fs__read', { path: '/home/u/secret.pem' + String.fromCharCode(10) }),
  'card'
)
eq('env file cards with trailing space', v('mcp__fs__read', { path: '/app/.env ' }), 'card')
eq('force push cards with trailing space', v('mcp__git__run', { cmd: 'git push -f ' }), 'card')
eq(
  'force push cards with trailing newline',
  v('mcp__git__run', { cmd: 'git push -f' + String.fromCharCode(10) }),
  'card'
)

// Fix round 3: trim() strips ASCII whitespace but not zero-width or
// non-printing characters, so a value ending in one still defeated every
// `$`-anchored rule, and one in the middle of a word still defeated a
// substring or word-boundary rule. Built with String.fromCharCode, not a
// literal escape, so this file stays readable and cannot be silently
// mangled by an editor or a diff view.
const ZWSP = String.fromCharCode(0x200b) // zero-width space
eq(
  'key file cards with a trailing zero-width space',
  v('mcp__fs__read', { path: '/home/u/secret.pem' + ZWSP }),
  'card'
)
eq(
  'drop with a zero-width space inside still cards',
  v('mcp__x__y', { s: 'please ' + 'dr' + ZWSP + 'op the table' }),
  'card'
)

// ─────────────────────────────────────────────────────────────────────────
// Fix round 4: standing shapes.
//
// The 38 assertions above were all the same *shape*: a single-line string, in
// an object walked by its values, with no argv array anywhere. Three real bugs
// lived in the gap between that shape and the ones a tool call actually
// arrives in, and not one of those 38 could have caught any of them — the
// script was not under-populated, it was mono-shaped, which is why three
// review rounds went by without it noticing.
//
// So the seeds below are the dangerous content, and the shapes are applied to
// every seed rather than one bespoke assertion being bolted on per bug. A new
// rule added to the table inherits the whole matrix for free; a new shape
// discovered later is added once and tested against everything.
// ─────────────────────────────────────────────────────────────────────────

// Built from char codes, never written as literals: these are exactly the
// characters an editor, a diff view or a copy-paste would silently eat.
const CH = String.fromCharCode
const NL = CH(10)
const TAB = CH(9)
const CR = CH(13)
const VT = CH(11)
const FF = CH(12)

/** Deleted, because they separate nothing: `dr`+ZWSP+`op` is the word `drop`. */
const ZERO_WIDTH = [
  ['zero-width space', CH(0x200b)],
  ['zero-width non-joiner', CH(0x200c)],
  ['zero-width joiner', CH(0x200d)],
  ['byte-order mark', CH(0xfeff)],
  ['soft hyphen', CH(0x00ad)],
  ['word joiner', CH(0x2060)]
]

/** Replaced with a space, because separating tokens is their whole job. */
const WHITESPACE_CONTROLS = [
  ['tab', TAB],
  ['line feed', NL],
  ['vertical tab', VT],
  ['form feed', FF],
  ['carriage return', CR]
]

/** Read both ways, because for these the two intents genuinely conflict. */
const AMBIGUOUS_CONTROLS = [
  ['NUL', CH(0)],
  ['SOH', CH(1)],
  ['ESC', CH(27)],
  ['unit separator', CH(31)],
  ['DEL', CH(127)],
  ['NEL (C1)', CH(0x85)]
]

/** Danger that lives in the *sequence* of tokens, not in any single token. */
const COMMAND_SEEDS = [
  ['rm', '-rf', './cache'],
  ['rm', '--recursive', './cache'],
  ['rm', '--force', './cache'],
  ['drop', 'table', 'users'],
  ['truncate', 'table', 'events'],
  ['delete', 'from', 'users'],
  ['git', 'reset', '--hard'],
  ['git', 'push', '--force'],
  ['git', 'filter-branch'],
  ['format', 'c:']
]

/** Paths that must card whatever shape carries them. */
const PATH_SEEDS = [
  '/app/.env',
  '/home/u/.ssh/id_rsa',
  '/home/u/.aws/credentials',
  '/app/credentials.json',
  '/home/u/secret.pem',
  'C:' + B + 'Users' + B + 'u' + B + 'AppData' + B + 'Roaming' + B + 'Mochi' + B + 'settings.json'
]

/** Relative paths that climb out, in the encodings one actually arrives in. */
const TRAVERSAL_SEEDS = [
  '../../etc/passwd',
  '..' + B + '..' + B + 'etc' + B + 'passwd',
  'a/../../b',
  '%2e%2e%2fetc%2fpasswd',
  '%2E%2E%2F%2E%2E%2Fetc%2Fpasswd'
]

// Shape 1: a multi-token command, in every container a tool call uses.
//
// The argv shapes are the ones that were entirely absent before. Round 1
// correctly stopped joining values into one string; the untested cost was that
// every rule containing whitespace went blind to a call that carries its
// tokens as separate array entries, which is how a great many MCP tools take a
// command in the first place.
for (const seed of COMMAND_SEEDS) {
  const line = seed.join(' ')
  eq(`one string: ${line}`, v('mcp__sh__run', { c: line }), 'card')
  eq(`multi-line: ${line}`, v('mcp__sh__run', { c: 'echo start' + NL + line }), 'card')
  eq(`trailing line: ${line}`, v('mcp__sh__run', { c: line + NL + 'echo done' }), 'card')
  eq(`tab-separated: ${line}`, v('mcp__sh__run', { c: seed.join(TAB) }), 'card')
  eq(`CR-separated: ${line}`, v('mcp__sh__run', { c: seed.join(CR) }), 'card')
  eq(`argv array: ${line}`, v('mcp__sh__run', { cmd: seed[0], args: seed.slice(1) }), 'card')
  eq(`argv, one array: ${line}`, v('mcp__sh__run', { argv: seed }), 'card')
  eq(`argv, nested: ${line}`, v('mcp__x__y', { a: { b: { argv: seed } } }), 'card')
  eq(`not last: ${line}`, v('mcp__sh__run', { c: line, cwd: '/repo', z: 'trailing' }), 'card')
  eq(`argv not last: ${line}`, v('mcp__sh__run', { argv: seed, z: 'trailing' }), 'card')
}

// Shape 2: a sensitive path, in every container — including as an object KEY.
//
// `flatten` walked `Object.values()` only, so a path-keyed map carried its
// filenames somewhere no rule ever looked. Batch writers, env maps and header
// maps are all ordinary MCP shapes, and every one of them defeated
// ALWAYS_CARD_PATHS outright.
for (const p of PATH_SEEDS) {
  eq(`path value: ${p}`, v('mcp__fs__read', { path: p }), 'card')
  eq(`path not last: ${p}`, v('mcp__fs__read', { path: p, z: 'trailing' }), 'card')
  eq(`path as map key: ${p}`, v('mcp__fs__write', { files: { [p]: 'x' } }), 'card')
  eq(
    `path key with sibling: ${p}`,
    v('mcp__fs__write', { files: { [p]: 'x', 'ok.txt': 'y' } }),
    'card'
  )
  eq(`path key, nested: ${p}`, v('mcp__x__y', { a: { b: { headers: { [p]: 'v' } } } }), 'card')
  eq(`path in argv: ${p}`, v('mcp__sh__run', { cmd: 'cat', args: [p] }), 'card')
  eq(`path nested in array: ${p}`, v('mcp__x__y', { a: { b: [p] } }), 'card')
}

// Shape 3: climbing out, with and without a folder open.
//
// `climbsOut` was gated behind `if (root)`, so the same traversal that carded
// with a workspace open was an ordinary allow without one — the case where
// there is least context about where the agent is standing. The encoded seeds
// are here because `%2e%2e%2f` is `../` to every URL-aware consumer of a path
// and was invisible to a rule reading the raw string.
for (const t of TRAVERSAL_SEEDS) {
  eq(`climb, no root: ${t}`, v('mcp__fs__read', { p: t }), 'card')
  eq(
    `climb, with root: ${t}`,
    v('mcp__fs__read', { p: t }, { workspaceRoot: 'C:' + B + 'work' }),
    'card'
  )
  eq(`climb as map key: ${t}`, v('mcp__fs__write', { files: { [t]: 'x' } }), 'card')
  eq(`climb in argv: ${t}`, v('mcp__sh__run', { cmd: 'cat', args: [t] }), 'card')
  eq(`climb not last: ${t}`, v('mcp__fs__read', { p: t, z: 'trailing' }), 'card')
}

// Shape 4: every invisible and control character, in each of the three places
// it can sit — and the expectation differs by place, deliberately.
//
// Inside a word, a character that separates nothing must not hide the word.
// Whitespace controls are absent from this loop on purpose: `dr` + TAB + `op`
// genuinely IS two tokens, and asserting a card there would be asserting a
// false positive.
for (const [label, ch] of [...ZERO_WIDTH, ...AMBIGUOUS_CONTROLS]) {
  eq(
    `inside a word, ${label}: drop`,
    v('mcp__x__y', { s: 'please dr' + ch + 'op the table' }),
    'card'
  )
  eq(
    `inside a word, ${label}: id_rsa`,
    v('mcp__fs__read', { p: '/home/u/keys/id_' + ch + 'rsa' }),
    'card'
  )
  eq(
    `inside a word, ${label}: as a map key`,
    v('mcp__fs__write', { files: { ['/home/u/keys/id_' + ch + 'rsa']: 'x' } }),
    'card'
  )
}

// Between two tokens, a character that separates must not weld them together.
// Zero-width characters are absent from this loop on purpose, and for the
// mirror-image reason: `rm` + ZWSP + `-rf` is a single word to any shell, so
// it is not the command `rm -rf` and must not card as one.
for (const [label, ch] of [...WHITESPACE_CONTROLS, ...AMBIGUOUS_CONTROLS]) {
  eq(
    `as a separator, ${label}: next line`,
    v('mcp__sh__run', { c: 'cd /tmp' + ch + 'rm -rf ./cache' }),
    'card'
  )
  eq(
    `as a separator, ${label}: rm and its flags`,
    v('mcp__sh__run', { c: 'rm' + ch + '-rf /' }),
    'card'
  )
  eq(
    `as a separator, ${label}: before drop`,
    v('mcp__db__runSql', { q: 'select 1;' + ch + 'drop table t' }),
    'card'
  )
  eq(
    `as a separator, ${label}: reset --hard`,
    v('mcp__git__run', { c: 'git reset' + ch + '--hard' }),
    'card'
  )
}

// At the end, no character of any class may defeat a `$`-anchored rule.
for (const [label, ch] of [...ZERO_WIDTH, ...WHITESPACE_CONTROLS, ...AMBIGUOUS_CONTROLS]) {
  eq(`trailing ${label}: .pem$`, v('mcp__fs__read', { p: '/home/u/secret.pem' + ch }), 'card')
  eq(`trailing ${label}: credentials$`, v('mcp__fs__read', { p: '/srv/credentials' + ch }), 'card')
  eq(`trailing ${label}: -f$`, v('mcp__git__run', { cmd: 'git push -f' + ch }), 'card')
  eq(`trailing ${label}: .env`, v('mcp__fs__read', { p: '/app/.env' + ch }), 'card')
}

// ─────────────────────────────────────────────────────────────────────────
// The other half of the contract: Auto exists so the user is NOT interrupted.
//
// A table that cards everything passes every assertion above and is useless —
// nobody leaves that mode on. These are as load-bearing as the cards.
// ─────────────────────────────────────────────────────────────────────────
const ROOT = 'C:' + B + 'work' + B + 'proj'
eq('plain SELECT defers', v('mcp__db__runSql', { q: 'SELECT * FROM users WHERE id = 1' }), 'allow')
eq(
  'multi-line SELECT defers',
  v('mcp__db__runSql', { q: 'SELECT *' + NL + 'FROM users' + NL + 'ORDER BY id' }),
  'allow'
)
eq('dropdown is still not drop', v('mcp__x__y', { s: 'render the dropdown' }), 'allow')
eq('undeleted is still not delete', v('mcp__x__y', { s: 'undeleted rows' }), 'allow')
eq(
  'in-workspace absolute path defers',
  v('mcp__fs__read', { path: ROOT + B + 'src' + B + 'a.ts' }, { workspaceRoot: ROOT }),
  'allow'
)
eq(
  'in-workspace path in argv defers',
  v(
    'mcp__fs__read',
    { cmd: 'cat', args: [ROOT + B + 'src' + B + 'a.ts'] },
    { workspaceRoot: ROOT }
  ),
  'allow'
)
eq(
  'ordinary prose defers',
  v('mcp__x__y', { s: 'Please summarise the meeting notes from Tuesday.' }),
  'allow'
)
eq(
  'prose with stray dots defers',
  v('mcp__x__y', { s: 'hmm .. not sure, wait.. what about that?' }),
  'allow'
)
eq(
  'multi-line prose defers',
  v('mcp__x__y', { s: 'first line' + NL + 'second line' + NL + 'third line' }),
  'allow'
)
eq(
  'a benign keyed map defers',
  v('mcp__fs__write', { files: { 'src/a.ts': 'export const a = 1' } }, { workspaceRoot: ROOT }),
  'allow'
)
eq('a benign argv defers', v('mcp__sh__run', { cmd: 'npm', args: ['run', 'build'] }), 'allow')
eq(
  'a percent-encoded URL defers',
  v('mcp__http__get', { url: 'https://x.test/a%20b?q=hello' }),
  'allow'
)
eq(
  'a malformed percent escape defers',
  v('mcp__http__get', { url: 'https://x.test/100%discount' }),
  'allow'
)
eq('numbers and booleans defer', v('mcp__x__y', { count: 42, ok: true }), 'allow')
eq(
  'word joiner inside a benign word defers',
  v('mcp__x__y', { s: 'dro' + CH(0x2060) + 'pdown menu' }),
  'allow'
)
eq('a tab between benign words defers', v('mcp__x__y', { s: 'name' + TAB + 'value' }), 'allow')

// ─────────────────────────────────────────────────────────────────────────
// The specific regressions, named after the findings they close. The shapes
// above are what should have caught these; these are here so the exact
// reproduction is on the record and can never silently come back.
// ─────────────────────────────────────────────────────────────────────────

// C2 — the invisible-character strip deleted \n, \t and \r, welding the last
// word of one line onto the first of the next.
eq('C2 semicolon still cards', v('mcp__sh__run', { c: 'cd /tmp; rm -rf ./cache' }), 'card')
eq('C2 newline cards too', v('mcp__sh__run', { c: 'cd /tmp' + NL + 'rm -rf ./cache' }), 'card')
eq(
  'C2 newline before drop',
  v('mcp__sh__run', { c: 'echo start' + NL + 'drop table users' }),
  'card'
)
eq('C2 tab inside rm -rf', v('mcp__sh__run', { c: 'rm' + TAB + '-rf /' }), 'card')

// C3 — object keys were never scanned.
eq(
  'C3 ssh key as a map key',
  v('mcp__fs__write', { files: { '/home/u/.ssh/id_rsa': 'ssh-rsa AAAA' } }),
  'card'
)
eq('C3 env file as a map key', v('mcp__fs__write', { files: { '/app/.env': 'X=1' } }), 'card')
eq(
  'C3 traversal as a map key',
  v('mcp__fs__write', { files: { '../../etc/passwd': 'x' } }, { workspaceRoot: ROOT }),
  'card'
)

// I4 — multi-token phrases split across an argv array were invisible.
eq('I4 rm as argv', v('mcp__sh__run', { cmd: 'rm', args: ['-rf', './build'] }), 'card')
eq(
  'I4 git reset --hard as argv',
  v('mcp__git__run', { cmd: 'git', args: ['reset', '--hard'] }),
  'card'
)
eq('I4 format c: as argv', v('mcp__sh__run', { cmd: 'format', args: ['c:'] }), 'card')

// M9 — climbsOut needed no root, but was gated behind one.
eq('M9 traversal with no folder open', v('mcp__fs__read', { p: '../../etc/passwd' }), 'card')

// M10 — TOOL_TAGS[name] was a prototype-chain lookup, so these threw rather
// than returning a Consequence. `assess` is documented as always returning
// one, and a later phase calls it where it is the whole decision.
eq('M10 __proto__ returns a verdict', v('__proto__', { a: 1 }), 'allow')
eq('M10 constructor returns a verdict', v('constructor', { a: 1 }), 'allow')
eq('M10 toString returns a verdict', v('toString', { a: 1 }), 'allow')
eq('M10 __proto__ carries array tags', Array.isArray(assess('__proto__', { a: 1 }).tags), true)
eq('M10 a real tag still resolves', assess('Bash', { command: 'ls' }).tags, ['execute'])
eq('M10 __proto__ still scans arguments', v('__proto__', { q: 'drop table t' }), 'card')

// Deferred items the review ruled fix-before-merge.
eq('rm --recursive is a recursive remove', v('mcp__sh__run', { c: 'rm --recursive ./x' }), 'card')
eq('rm --force is a recursive remove', v('mcp__sh__run', { c: 'rm --force ./x' }), 'card')
eq('URL-encoded traversal cards', v('mcp__fs__read', { p: '%2e%2e%2fetc%2fpasswd' }), 'card')
eq(
  'credentials.json outside .aws cards',
  v('mcp__fs__read', { p: '/app/credentials.json' }),
  'card'
)
eq(
  'credentials.yaml outside .aws cards',
  v('mcp__fs__read', { p: '/app/credentials.yaml' }),
  'card'
)

// The depth cap still counts keys, so content past it throws rather than
// vanishing from the scan.
eq(
  'a key past the depth cap cards',
  v('mcp__x__y', nest(9, { '/home/u/.ssh/id_rsa': 'x' })),
  'card'
)

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
