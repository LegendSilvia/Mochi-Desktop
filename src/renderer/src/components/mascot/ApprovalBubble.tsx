import { useState } from 'react'
import { ShieldQuestion, Check, X, ExternalLink } from 'lucide-react'
import { escalationLead } from '@shared/permission-modes'
import type { ApprovalRequest } from '@shared/types'
import type { MenuPlacement } from './MascotMenu'

/**
 * "May I?", asked from the desktop.
 *
 * The same decision the transcript offers, on the surface most likely to be
 * visible when the app is buried. It names the session because with more than
 * one conversation open, "allow this?" is not answerable without knowing which
 * one stopped.
 *
 * A command too long for this space is not offered for approval at all — the
 * card sends you to the window that can show the whole thing instead. Approving
 * what you can only half read is the failure this whole path exists to prevent.
 */
export function ApprovalBubble({
  request,
  baseUrl,
  onAnswered,
  cardRef,
  placement
}: {
  request: ApprovalRequest
  baseUrl: string
  onAnswered: () => void
  /** Handed up so the overlay's click-through hit test can include this card —
   *  it sits out of flow, so the wrapper's own rect does not cover it. */
  cardRef?: React.Ref<HTMLDivElement>
  /** Which way to open. A mascot parked near the top of the screen would
   *  otherwise push this card off it — the overlay is exactly the work area, so
   *  anything past its bounds is cut off rather than scrolled to. */
  placement: MenuPlacement
}): React.JSX.Element {
  const [sent, setSent] = useState(false)

  const answer = (behavior: 'allow' | 'deny'): void => {
    setSent(true)
    void fetch(`${baseUrl}/agent-sdk/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: request.id, behavior })
    }).catch(() => {
      // Already timed out or stopped. Main clears the card either way, so there
      // is nothing here worth telling the user about.
    })
    onAnswered()
  }

  const openApp = (): void => {
    void window.mochi?.focusSession(request.sessionId)
    onAnswered()
  }

  return (
    <div
      ref={cardRef}
      className="mo-approval"
      data-v={placement.vertical}
      data-h={placement.horizontal}
      role="alertdialog"
      aria-label="Permission needed"
    >
      {/* Named rather than "Write wants to run": the tool is the mechanism, the
          agent is who is asking, and on a desktop card away from the transcript
          the agent is the part that makes the request make sense. */}
      <div className="mo-approval-head">
        <ShieldQuestion size={13} strokeWidth={1.9} />
        <span>
          <strong>{request.agentName}</strong> needs permission to run{' '}
          <strong>{request.toolName}</strong>
        </span>
      </div>
      <div className="mo-approval-where meta">in {request.sessionTitle}</div>
      <div className="mo-approval-target mono">
        {request.target}
        {request.truncated && '…'}
      </div>

      {/* Auto's reason, worded by which policy gave it — the same distinction
          the in-thread card draws. It was being put on this payload and then
          dropped on the floor here, which is the worst place to lose it: this
          card exists precisely because it may be the only part of Mochi on
          screen, and "allow this?" with no stated reason is the question this
          whole path exists to stop asking. */}
      {request.escalationReason && (
        <div className="mo-approval-why meta">
          {escalationLead(request.escalationSource)}: {request.escalationReason}
        </div>
      )}

      {request.truncated ? (
        <>
          <div className="mo-approval-note meta">Too long to read here.</div>
          <button className="mo-approval-btn mo-approval-open" onClick={openApp}>
            <ExternalLink size={12} strokeWidth={2} />
            Open Mochi
          </button>
        </>
      ) : (
        <div className="mo-approval-actions">
          <button className="mo-approval-btn mo-approval-yes" disabled={sent} onClick={() => answer('allow')}>
            <Check size={12} strokeWidth={2.4} />
            Allow
          </button>
          <button className="mo-approval-btn" disabled={sent} onClick={() => answer('deny')}>
            <X size={12} strokeWidth={2.2} />
            Deny
          </button>
        </div>
      )}
    </div>
  )
}
