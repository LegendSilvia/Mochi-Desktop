import { useState } from 'react'
import {
  ShieldQuestion,
  Check,
  X,
  Infinity as InfinityIcon,
  ChevronRight,
  ClipboardList
} from 'lucide-react'
import { Markdown } from './Markdown'
import {
  MODE_LABELS,
  escalationLead,
  type EscalationSource,
  type PermissionMode
} from '@shared/permission-modes'
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
  /** Why this reached a card rather than running. Set only in Auto: a rule
   *  from the consequence table (e.g. "it touches an SSH key") or the
   *  classifier model's own sentence explaining its call. Absent in Manual
   *  and Accept edits, where the mode itself is the whole answer. */
  escalationReason?: string
  /** Which of the two said so. Drives the wording, not just the text. */
  escalationSource?: EscalationSource
}

export function PermissionCard({
  request,
  baseUrl,
  agentName,
  stale = false,
  onAnswered,
  onModeChange,
  planFollowOn
}: {
  request: PermissionRequest
  baseUrl: string
  /** Who is asking. The tool is the mechanism; the agent is the one making the
   *  request, and with several agents in a session "Write wants to run" does not
   *  say whose write it is. Matches the wording the mascot's card already uses. */
  agentName?: string
  /** Told when the user decides, so the enclosing card can stop waiting. */
  onAnswered?: (id: string) => void
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
  /**
   * Approving a plan also switches the session's mode. This is `Session.tsx`'s
   * `setMode`, which persists the mode to the store *and* posts it to the live
   * run — passed down rather than the card POSTing `/agent-sdk/mode` itself,
   * because a POST with no matching store write left the mode pill and the
   * Permissions widget still showing Plan while the run had moved on, and the
   * next turn's `load()` dropped it straight back to Plan.
   */
  onModeChange?: (mode: PermissionMode) => void
  /** What approving a plan drops into. */
  planFollowOn?: PermissionMode
}): React.JSX.Element {
  const [sent, setSent] = useState<'allow' | 'deny' | null>(null)

  const answer = (behavior: 'allow' | 'deny', alwaysAllow = false): void => {
    setSent(behavior)
    // The card that contains this needs to know too — it stays open while an
    // approval is outstanding, and without being told it would sit there saying
    // "waiting on you" long after you had answered.
    onAnswered?.(request.id)
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
   * A plan is not a permission question, even though it arrives as one.
   *
   * The CLI ends plan mode by calling ExitPlanMode, which lands here like any
   * other gated tool. Rendering it as "may I run ExitPlanMode" would show the
   * user a tool name and hide the only thing that matters, which is the plan
   * itself — so it gets a card of its own, and Approve does two things at once:
   * resolves the permission and moves the session out of Plan, so the agent
   * carries on in the same turn instead of waiting to be told again.
   */
  const planText = request.toolName === 'ExitPlanMode' ? planOf(request.input) : null
  if (planText && !stale && sent === null) {
    const follow = planFollowOn ?? 'acceptEdits'
    const approve = (): void => {
      // The permission itself must go through even if switching the mode
      // throws — a plan the user approved is not something to leave hanging
      // because the mode change had trouble.
      try {
        onModeChange?.(follow)
      } catch {
        // setMode's own fetch already swallows the run-not-live case; this is
        // only a guard against the callback itself misbehaving.
      }
      answer('allow')
    }
    return (
      <div className="perm-card plan-card" data-done={false}>
        <div className="perm-head">
          <ClipboardList size={14} strokeWidth={1.9} />
          <span>
            <strong>{agentName ?? 'This agent'}</strong> has a plan
          </span>
        </div>
        <div className="plan-body">
          <Markdown text={planText} />
        </div>
        <div className="perm-actions">
          <button className="pill-primary" onClick={approve}>
            <Check size={13} strokeWidth={2.4} />
            Approve → {MODE_LABELS[follow]}
          </button>
          <button className="pill-ghost" onClick={() => answer('deny')}>
            <X size={13} strokeWidth={2.2} />
            Keep planning
          </button>
        </div>
      </div>
    )
  }

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
          <strong>{agentName ?? 'This agent'}</strong> needs permission to run{' '}
          <strong>{request.toolName}</strong>
        </span>
      </div>
      {target && <div className="perm-target mono">{target}</div>}
      {/*
       * Escalation first, blocked path second — the escalation reason is Auto
       * saying specifically why *this* call stopped; the blocked path is the
       * more general "you touched something sensitive" that the SDK itself
       * would say regardless of mode.
       *
       * The lead-in names which of Auto's two policies spoke, because they are
       * different things to act on. A safety rule is fixed and applies whatever
       * model you pick, so the answer is to look at what the call touches. The
       * classifier is a judgement, so the answer might be a different model —
       * or simply reading its sentence and deciding it is wrong. One prefix for
       * both hid that distinction behind identical wording.
       */}
      {request.escalationReason && (
        <div className="perm-reason meta">
          {escalationLead(request.escalationSource)}: {request.escalationReason}
        </div>
      )}
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

/** The plan out of an ExitPlanMode call. The SDK names the field `plan`; older
 *  CLIs have been seen to send `content`, so both are read before giving up. */
function planOf(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  for (const key of ['plan', 'content']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}
