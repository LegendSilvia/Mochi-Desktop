import { useState } from 'react'
import { ShieldQuestion, Check, X, Infinity as InfinityIcon, ChevronRight } from 'lucide-react'
import './chat.css'

/**
 * "May I?" — the prompt the agent kept telling users to look for.
 *
 * The run is genuinely blocked in the main process while this is on screen: the
 * SDK's `canUseTool` is awaiting a promise that only a decision here resolves.
 * That is why the answer goes out as its own POST rather than as a chat turn —
 * the stream this arrived on cannot carry anything back.
 */

export interface PermissionRequest {
  id: string
  toolName: string
  input?: Record<string, unknown>
  blockedPath?: string | null
  canAlwaysAllow?: boolean
}

export function PermissionCard({
  request,
  baseUrl,
  stale = false
}: {
  request: PermissionRequest
  baseUrl: string
  /**
   * Restored from a previous run of the app.
   *
   * The parked promise lived in the main process, so closing the app took every
   * pending decision with it. The card is still in the transcript because the
   * transcript is on disk, and it used to render with working-looking buttons
   * that posted an id nothing was waiting for — the route answered `{ok: false}`
   * and the user got no feedback at all. Whether it was answered at the time is
   * not recoverable either, since the answer was never written to the message.
   */
  stale?: boolean
}): React.JSX.Element {
  const [sent, setSent] = useState<'allow' | 'deny' | null>(null)

  const answer = (behavior: 'allow' | 'deny', alwaysAllow = false): void => {
    setSent(behavior)
    void fetch(`${baseUrl}/agent-sdk/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: request.id, behavior, alwaysAllow })
    }).catch(() => {
      // The run may already have been stopped or timed out. Re-enabling the
      // buttons would invite a second click at something that no longer exists.
    })
  }

  /*
   * What you are actually approving.
   *
   * This used to prefer `blockedPath`, which is the SDK saying *why* it stopped —
   * so a PowerShell call to delete a file showed only the file. You would read a
   * path, press Allow, and have approved a command you were never shown. The
   * command leads; the blocked path follows as the reason.
   */
  const target = describeTarget(request.input) || request.blockedPath || ''
  const reason =
    request.blockedPath && request.blockedPath !== target ? request.blockedPath : null

  /*
   * A settled approval folds away.
   *
   * While it is waiting this is the most important thing on screen and stays
   * open. Afterwards it is a receipt, and leaving it at full height pushed the
   * reply it was about down past the fold — the card said "allowed, carrying
   * on" in more space than the answer it enabled.
   */
  if (stale || sent !== null) {
    const outcome = stale
      ? 'asked in an earlier run'
      : sent === 'allow'
        ? 'allowed'
        : 'denied'
    return (
      <details className="perm-card perm-card-settled" data-done="true">
        <summary className="tool-summary">
          <ChevronRight size={12} strokeWidth={2.2} className="tool-chevron" />
          <div className="tool-row">
            <ShieldQuestion size={13} strokeWidth={1.9} className="perm-icon" />
            <span className="mono tool-id">{request.toolName}</span>
            <span className="mono tool-arg">{target}</span>
            <span className="mono tool-dur">{outcome}</span>
          </div>
        </summary>
        <div className="perm-settled-body">
          {target && <div className="perm-target mono">{target}</div>}
          <div className="perm-settled meta">
            {stale
              ? 'The run that asked this has ended, so the answer no longer goes anywhere.'
              : sent === 'allow'
                ? 'You allowed this.'
                : 'You declined this.'}
          </div>
        </div>
      </details>
    )
  }

  return (
    <div className="perm-card" data-done={false}>
      <div className="perm-head">
        <ShieldQuestion size={14} strokeWidth={1.9} />
        <span>
          <strong>{request.toolName}</strong> wants to run
        </span>
      </div>
      {target && <div className="perm-target mono">{target}</div>}
      {reason && (
        <div className="perm-reason meta">
          Stopped because it touches <span className="mono">{reason}</span>
        </div>
      )}

      {
        <div className="perm-actions">
          <button className="pill-primary" onClick={() => answer('allow')}>
            <Check size={13} strokeWidth={2.4} />
            Allow once
          </button>
          {request.canAlwaysAllow && (
            <button className="pill-ghost" onClick={() => answer('allow', true)}>
              <InfinityIcon size={13} strokeWidth={1.9} />
              Always allow
            </button>
          )}
          <button className="pill-ghost" onClick={() => answer('deny')}>
            <X size={13} strokeWidth={2.2} />
            Deny
          </button>
        </div>
      }
    </div>
  )
}

/** Prefer the one argument that says what is about to happen over dumping JSON. */
function describeTarget(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of ['file_path', 'filePath', 'path', 'command', 'pattern', 'url']) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  const json = JSON.stringify(input)
  if (!json || json === '{}') return ''
  return json.length > 120 ? `${json.slice(0, 117)}…` : json
}
