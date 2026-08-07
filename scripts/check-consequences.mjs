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
eq(
  'force push cards with trailing space',
  v('mcp__git__run', { cmd: 'git push -f ' }),
  'card'
)
eq(
  'force push cards with trailing newline',
  v('mcp__git__run', { cmd: 'git push -f' + String.fromCharCode(10) }),
  'card'
)

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
