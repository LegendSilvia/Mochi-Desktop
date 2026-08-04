import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, ArrowUp, AtSign, Paperclip, X } from 'lucide-react'
import { useStore } from '@renderer/state/context'
import type { Session } from '@shared/types'

/** A partial `@name` immediately before the caret — the same trigger the app's
 *  composer uses, so the gesture is identical in both places. */
const MENTION_AT_CARET = /@([\w-]*)$/

/** Recent conversations worth offering on a small surface. Beyond this the list
 *  stops being a menu and becomes a screen, which is what the app is for. */
const MAX_SESSIONS = 3

export interface MenuPlacement {
  vertical: 'above' | 'below'
  horizontal: 'left' | 'center' | 'right'
}

/**
 * Pop-up chat: the mascot's own composer.
 *
 * A conversation without the window — pick a session, or start one, and type
 * from wherever you happen to be. The message is handed to the app window to
 * send, because that is where the transcript, the transport and the streaming
 * reply live; a turn started from the overlay would stream to nobody.
 *
 * No workspace control here on purpose. Choosing a folder is a decision about
 * what an agent may touch, and it belongs somewhere you can see what you are
 * agreeing to rather than on a card floating over your desktop.
 */
export function MascotMenu({
  onClose,
  cardRef,
  placement,
  text,
  setText,
  target,
  setTarget
}: {
  onClose: () => void
  /** Handed up so the overlay's click-through hit test can measure this card.
   *  It is positioned absolutely, so any wrapper around it has no height and a
   *  ref on that wrapper measures an empty box — which is how the card ended up
   *  unclickable the first time. */
  cardRef?: React.Ref<HTMLDivElement>
  /** Which way to open, so a mascot parked in a corner does not push the card
   *  off the screen. */
  placement: MenuPlacement
  /* Held by the overlay rather than here, so closing the card and opening it
   * again does not lose a half-written message or the session it was for. */
  text: string
  setText: (next: string) => void
  target: string | null
  setTarget: (id: string) => void
}): React.JSX.Element {
  const { sessions, agents, settings, dispatch } = useStore()
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const recent = useMemo(
    () =>
      [...sessions]
        .filter((s) => !s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SESSIONS),
    [sessions]
  )

  const chosen = target ?? recent[0]?.id ?? null

  // The window only just became focusable, so the caret has to be asked for
  // rather than assumed — without this the card opens and swallows the first
  // thing you type.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const mentionable = agents.filter((a) =>
    mentionQuery ? a.id.toLowerCase().includes(mentionQuery.toLowerCase()) : true
  )

  const addMention = (id: string): void => {
    setText(text.replace(MENTION_AT_CARET, `@${id} `))
    setMentionQuery(null)
    inputRef.current?.focus()
  }

  const append = (extra: string): void => {
    setText(`${text}${text && !text.endsWith(' ') ? ' ' : ''}${extra}`)
    inputRef.current?.focus()
  }

  const attach = (): void => {
    void window.mochi?.pickPaths('file').then((paths) => {
      if (paths.length > 0) append(`${paths.join(' ')} `)
    })
  }

  /** A fresh session, created here so the message has somewhere to land. Written
   *  through the store, which persists and tells the app window — the same path
   *  the New session screen uses. */
  const startNew = (): string => {
    const id = `s-${Date.now().toString(36)}`
    const next: Session = {
      id,
      title: 'from the desktop',
      kind: 'chat',
      type: settings.defaultSessionType,
      agentId: settings.defaultAgentId,
      subagentIds: [],
      pinned: false,
      busy: false,
      updatedAt: Date.now(),
      threadId: `t-${Date.now().toString(36)}`
    }
    dispatch({ type: 'sessions', sessions: [next, ...sessions] })
    setTarget(id)
    return id
  }

  const send = (): void => {
    const body = text.trim()
    if (!body) return
    const sessionId = chosen ?? startNew()
    void window.mochi?.sendToSession(sessionId, body)
    setText('')
    onClose()
  }

  return (
    <div
      ref={cardRef}
      className="mo-menu"
      data-v={placement.vertical}
      data-h={placement.horizontal}
      role="dialog"
      aria-label="Pop-up chat"
    >
      <div className="mo-menu-head">
        <span className="mo-menu-title">Send to</span>
        <button className="mo-menu-x" aria-label="Close" onClick={onClose}>
          <X size={12} strokeWidth={2.2} />
        </button>
      </div>

      <div className="mo-menu-sessions">
        {recent.map((s) => (
          <button
            key={s.id}
            className="mo-menu-session"
            data-on={s.id === chosen}
            onClick={() => setTarget(s.id)}
          >
            <span className="mo-menu-session-name">{s.title}</span>
            <span className="meta">{agents.find((a) => a.id === s.agentId)?.name ?? s.agentId}</span>
          </button>
        ))}
        <button className="mo-menu-session mo-menu-new" onClick={() => startNew()}>
          <Plus size={11} strokeWidth={2.2} />
          <span className="mo-menu-session-name">New session</span>
        </button>
      </div>

      {mentionQuery !== null && mentionable.length > 0 && (
        <div className="mo-menu-mentions">
          {mentionable.slice(0, 4).map((a) => (
            <button key={a.id} className="mo-menu-mention" onClick={() => addMention(a.id)}>
              @{a.id}
            </button>
          ))}
        </div>
      )}

      <textarea
        ref={inputRef}
        className="mo-menu-input"
        rows={2}
        value={text}
        placeholder="Say something…"
        onChange={(e) => {
          setText(e.target.value)
          const at = MENTION_AT_CARET.exec(e.target.value.slice(0, e.target.selectionStart))
          setMentionQuery(at ? at[1] : null)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          // Same contract as the app composer: Enter sends, Shift+Enter breaks
          // the line. Worth matching exactly — muscle memory does not know which
          // window it is in.
          if (e.shiftKey) return
          e.preventDefault()
          if (mentionQuery !== null && mentionable[0]) {
            addMention(mentionable[0].id)
            return
          }
          send()
        }}
      />

      <div className="mo-menu-bar">
        <button className="mo-menu-icon" aria-label="Attach a file" onClick={attach}>
          <Paperclip size={13} strokeWidth={1.8} />
        </button>
        <button
          className="mo-menu-icon"
          aria-label="Mention an agent"
          onClick={() => {
            append('@')
            setMentionQuery('')
          }}
        >
          <AtSign size={13} strokeWidth={1.8} />
        </button>
        <span className="mo-menu-spacer" />
        <button className="mo-menu-send" disabled={!text.trim()} onClick={send}>
          Send
          <ArrowUp size={12} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  )
}
