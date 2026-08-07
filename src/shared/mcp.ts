/**
 * MCP server names and command lines.
 *
 * Shared because both ends have to agree: the renderer refuses a bad name while
 * you type it, and the main process refuses it again before handing anything to
 * the Agent SDK. A check that only exists in the UI is a check a stale
 * settings.json walks straight past.
 */

/**
 * Names Mochi keeps for itself.
 *
 * `mochi` is the in-process server carrying sendSticker, askUser, delegate and
 * the memory tools. A user server that took that key used to replace it
 * wholesale — every Mochi tool gone — and worse, the replacement inherited the
 * `mcp__mochi__*` entries in the auto-approve list, so its tools ran without a
 * permission card.
 */
export const RESERVED_MCP_NAMES = ['mochi']

/**
 * Why this name can't be used, or null if it can.
 *
 * `existing` is the names already configured, so the same name twice is caught
 * here rather than by one server silently overwriting the other in the record
 * handed to the SDK.
 */
export function mcpNameError(name: string, existing: string[] = []): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'A name is required.'
  if (RESERVED_MCP_NAMES.includes(trimmed.toLowerCase())) {
    return `“${trimmed}” is reserved for Mochi's own tools.`
  }
  // The SDK builds tool ids as `mcp__<server>__<tool>`, so a name carrying a
  // double underscore makes that ambiguous, and anything outside this set has
  // no defined encoding in a tool id at all.
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return 'Letters, digits, hyphen and underscore only.'
  }
  if (trimmed.includes('__')) return 'No double underscore — it separates parts of a tool id.'
  if (existing.some((e) => e.trim().toLowerCase() === trimmed.toLowerCase())) {
    return 'Another server already has this name.'
  }
  return null
}

/**
 * Split a command line into a command and its arguments.
 *
 * Splitting on spaces is wrong on the platform this app targets first:
 * `C:\Program Files\nodejs\node.exe server.js` is one program and one argument,
 * and the naive split makes it four of neither. Quotes — single or double —
 * hold a token together.
 *
 * Backslash is *not* an escape character here. On Windows it is the path
 * separator, and treating it as an escape would eat every one of them.
 */
export function parseCommand(input: string): { command: string; args: string[] } {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  /** True once this token has opened a quote, so `""` survives as an argument. */
  let quoted = false

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
    } else if (ch === ' ' || ch === '\t') {
      if (current || quoted) tokens.push(current)
      current = ''
      quoted = false
    } else {
      current += ch
    }
  }
  if (current || quoted) tokens.push(current)

  const [command = '', ...args] = tokens
  return { command, args }
}

/** Put a parsed command back together so it can be edited as one line. */
export function formatCommand(command: string, args: string[] = []): string {
  return [command, ...args].filter(Boolean).map(quoteToken).join(' ')
}

function quoteToken(token: string): string {
  if (!/[\s'"]/.test(token)) return token
  return token.includes('"') ? `'${token}'` : `"${token}"`
}

/**
 * Where a header or environment value lives in the encrypted secret store.
 *
 * Keyed by server id rather than name so renaming a server does not orphan its
 * credentials.
 */
export function mcpSecretKey(serverId: string, slot: 'header' | 'env', name: string): string {
  return `${serverId}:${slot}:${name}`
}
