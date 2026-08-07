import {
  PERMISSION_MODES,
  MODE_LABELS,
  toSdkPermissionMode,
  nativeAutoBlocked,
  coerceMode
} from 'file:///C:/Development/Mochi-Desktop/src/shared/permission-modes.ts'

let fail = 0
const eq = (label, got, want) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a !== b) {
    fail++
    console.log(`FAIL ${label}\n  got  ${a}\n  want ${b}`)
  } else console.log(`ok   ${label}`)
}

// The four modes, and only the four.
eq('four modes', PERMISSION_MODES, ['manual', 'acceptEdits', 'plan', 'auto'])
eq('no bypass in the list', PERMISSION_MODES.includes('bypassPermissions'), false)
eq('every mode is labelled', PERMISSION_MODES.every((m) => Boolean(MODE_LABELS[m])), true)

// Mapping onto the SDK's vocabulary.
eq('manual maps to default', toSdkPermissionMode('manual'), 'default')
eq('acceptEdits passes through', toSdkPermissionMode('acceptEdits'), 'acceptEdits')
eq('plan passes through', toSdkPermissionMode('plan'), 'plan')
eq('auto with no model is native', toSdkPermissionMode('auto'), 'auto')
eq('auto with a model is default', toSdkPermissionMode('auto', 'anthropic/claude-sonnet-5'), 'default')
eq('an empty model string is not a model', toSdkPermissionMode('auto', ''), 'auto')

// Availability of the native classifier.
eq(
  'native auto is fine on subscription with support',
  nativeAutoBlocked({ backend: 'subscription', supportsAutoMode: true }),
  null
)
eq(
  'native auto is blocked on mastra',
  typeof nativeAutoBlocked({ backend: 'mastra' }),
  'string'
)
eq(
  'native auto is blocked when the model cannot run it',
  typeof nativeAutoBlocked({ backend: 'subscription', supportsAutoMode: false }),
  'string'
)

// Anything unrecognised is the safest mode, never the loosest.
eq('unknown coerces to manual', coerceMode('bypassPermissions'), 'manual')
eq('undefined coerces to manual', coerceMode(undefined), 'manual')
eq('a real mode survives', coerceMode('plan'), 'plan')

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
