import { useState } from 'react'
import { Copy, Check, PenLine, RotateCcw } from 'lucide-react'
import './chat.css'

/**
 * Hover actions on a message.
 *
 * Copy hands back the *source* text, not what the markdown renderer drew, so
 * pasting a reply into an editor keeps its fences and emphasis intact. That is
 * the whole reason this takes the raw string rather than reading the DOM.
 */
export function MessageActions({
  text,
  onEdit,
  onRetry
}: {
  text: string
  onEdit?: () => void
  onRetry?: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      },
      () => {
        /* clipboard denied — no useful recovery, and a toast would be noise */
      }
    )
  }

  return (
    <div className="msg-actions">
      <button
        className="msg-action"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy message'}
      >
        {copied ? <Check size={12} strokeWidth={2.4} /> : <Copy size={12} strokeWidth={1.9} />}
      </button>
      {onEdit && (
        <button className="msg-action" onClick={onEdit} aria-label="Edit and resend" title="Edit and resend">
          <PenLine size={12} strokeWidth={1.9} />
        </button>
      )}
      {onRetry && (
        <button className="msg-action" onClick={onRetry} aria-label="Retry this reply" title="Retry this reply">
          <RotateCcw size={12} strokeWidth={1.9} />
        </button>
      )}
    </div>
  )
}
