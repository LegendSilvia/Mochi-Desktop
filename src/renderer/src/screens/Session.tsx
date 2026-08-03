import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type ToolUIPart } from 'ai'
import {
  Paperclip,
  AtSign,
  Sticker as StickerIcon,
  Mic,
  ArrowUp,
  FolderTree,
  GitBranch,
  MoreVertical,
  Lock,
  Network
} from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { KEYS } from '@renderer/lib/platform'
import { forgetMessages, loadMessages, saveMessages } from '@renderer/lib/history'
import { ArtPlaceholder } from '@renderer/components/ui/Controls'
import { SessionPanel } from './SessionPanel'
import { ToolPart } from '@renderer/components/chat/ToolPart'
import { Thinking } from '@renderer/components/chat/Thinking'
import './screens.css'

export function Session(): React.JSX.Element {
  const {
    activeSession,
    agentById,
    server,
    dispatch,
    mentionOpen,
    agents,
    sessions,
    fireSticker,
    settings,
    library,
    pendingSend,
    stickerPickerOpen
  } = useStore()
  const [input, setInput] = useState('')
  const [headMenu, setHeadMenu] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // Clicking anywhere else dismisses the header menu.
  useEffect(() => {
    if (!headMenu) return
    const close = (): void => setHeadMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [headMenu])

  const agent = activeSession ? agentById(activeSession.agentId) : undefined

  // The transport is rebuilt when the agent, the server port or the backend
  // changes. The port is chosen at runtime, so this cannot be a module-level
  // constant. Both routes speak the same UI-message-stream protocol; they differ
  // only in what pays — /chat bills an API key, /agent-sdk/chat draws on the
  // Claude subscription via the Agent SDK.
  const onSubscription = settings.preferSubscription
  const transport = useMemo(() => {
    if (!server || !agent) return undefined
    const route = onSubscription ? 'agent-sdk/chat' : 'chat'
    return new DefaultChatTransport({ api: `${server.baseUrl}/${route}/${agent.id}` })
  }, [server, agent, onSubscription])

  // Seeded once per session id — useChat only reads `messages` when it builds a
  // new Chat, which is exactly when the id changes.
  const initialMessages = useMemo(() => loadMessages(activeSession?.id), [activeSession?.id])

  const { messages, sendMessage, status, error } = useChat({
    transport,
    id: activeSession?.id,
    messages: initialMessages
  })

  // Write the transcript back once the turn settles. Saving mid-stream would
  // rewrite the whole thread on every token for no benefit.
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') return
    saveMessages(activeSession?.id, messages)
  }, [messages, status, activeSession?.id])

  // Drive the mascot from the live stream. This is the wire that makes the
  // mascot mean something rather than being decoration.
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') {
      dispatch({ type: 'mascot-state', state: 'thinking', note: 'working on it' })
    } else if (status === 'error') {
      dispatch({ type: 'mascot-state', state: 'error', note: 'that did not work' })
    } else if (status === 'ready' && messages.length > 0) {
      dispatch({ type: 'mascot-state', state: 'idle', note: 'waiting on you' })
    }
  }, [status, messages.length, dispatch])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  // Deliver the message typed on the Start-a-session screen. Waits for the
  // transport, since sending before it exists silently drops the turn, and
  // clears immediately so a re-render can't send it twice.
  useEffect(() => {
    if (!pendingSend || !transport) return
    dispatch({ type: 'pending-send', text: null })
    sendMessage({ text: pendingSend })
  }, [pendingSend, transport, sendMessage, dispatch])

  if (!activeSession || !agent) {
    return (
      <div className="screen-body empty-state">
        <p>No session open. Start one from the rail.</p>
      </div>
    )
  }

  /**
   * Ctrl+Enter = approve. The thing worth approving is whatever the agent last
   * asked with `askUser`, so this answers it with its first option — the
   * affirmative one by convention. Falls back to sending what's typed when
   * there's no open question, so the chord is never a dead key.
   */
  const approveLatest = (): void => {
    for (let m = messages.length - 1; m >= 0; m--) {
      for (const part of messages[m].parts) {
        if (part.type !== 'tool-askUser') continue
        const input = (part as unknown as { input?: { options?: string[] } }).input
        const first = input?.options?.[0]
        if (first) {
          sendMessage({ text: first })
          return
        }
      }
    }
    send()
  }

  const patchSession = (next: Partial<typeof activeSession>): void => {
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) => (s.id === activeSession.id ? { ...s, ...next } : s))
    })
  }

  const send = (): void => {
    const text = input.trim()
    if (!text) return
    if (!transport) return
    sendMessage({ text })
    setInput('')
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) =>
        s.id === activeSession.id ? { ...s, updatedAt: Date.now() } : s
      )
    })
  }

  const subagents = activeSession.subagentIds.map(agentById).filter(Boolean)

  return (
    <div className="session">
      <div className="session-main">
        <header className="session-head">
          <div className="session-avatar">
            <span className="agent-initial">{agent.name[0]}</span>
          </div>
          <div className="session-head-text">
            <h1>{activeSession.title}</h1>
            <p>
              {agent.name} · {agent.description.split(' —')[0]}
              {subagents.length > 0 && (
                <>
                  {' · '}
                  <span className="warm">+{subagents.length} agent</span>
                </>
              )}
            </p>
          </div>
          {subagents.length > 0 && (
            <div className="avatar-stack">
              <span className="stack-avatar">{agent.name[0]}</span>
              {subagents.map((s) => (
                <span key={s!.id} className="stack-avatar">
                  {s!.name[0]}
                </span>
              ))}
            </div>
          )}
          <span className="session-spacer" />
          <span className="chip">{agent.model}</span>
          <span className="chip" title={onSubscription
            ? 'Running through the Claude Agent SDK on your Claude subscription — no API key involved.'
            : 'Running through Mastra against the Anthropic API — billed per token to your API key.'}>
            {onSubscription ? 'subscription' : 'api key'}
          </span>
          {activeSession.type !== 'scratch' && agent.workingMemory && (
            <span className="chip accent">memory on</span>
          )}
          {activeSession.type === 'scratch' && (
            <span className="chip">scratch · nothing saved</span>
          )}
          <div className="head-menu-wrap">
            <button
              className="tb-icon"
              aria-label="Session menu"
              aria-expanded={headMenu}
              onClick={() => setHeadMenu((v) => !v)}
            >
              <MoreVertical size={15} strokeWidth={1.8} />
            </button>
            {headMenu && (
              <div className="rail-menu" onClick={(e) => e.stopPropagation()}>
                <button
                  className="rail-menu-item"
                  onClick={() => {
                    patchSession({ pinned: !activeSession.pinned })
                    setHeadMenu(false)
                  }}
                >
                  {activeSession.pinned ? 'Unpin' : 'Pin'} this session
                </button>
                <button
                  className="rail-menu-item"
                  onClick={() => {
                    patchSession({ archived: true, pinned: false })
                    setHeadMenu(false)
                    dispatch({ type: 'screen', screen: 'new' })
                  }}
                >
                  Archive
                </button>
                <div className="rail-menu-sep" />
                <button
                  className="rail-menu-item danger"
                  onClick={() => {
                    forgetMessages(activeSession.id)
                    dispatch({
                      type: 'sessions',
                      sessions: sessions.filter((s) => s.id !== activeSession.id)
                    })
                    setHeadMenu(false)
                    dispatch({ type: 'screen', screen: 'new' })
                  }}
                >
                  Delete session
                </button>
              </div>
            )}
          </div>
        </header>

        {activeSession.branch && (
          <div className="repo-strip">
            <GitBranch size={13} strokeWidth={1.8} className="ic-code" />
            <span className="mono">{activeSession.workspacePath ?? 'workspace'}</span>
            <span className="mono dim">/</span>
            <span className="mono">{activeSession.branch}</span>
            <span className="chip">+22 −0</span>
            <span className="session-spacer" />
            <span className="mono dim">{activeSession.workspacePath}</span>
          </div>
        )}

        <div className="msg-list" ref={listRef}>
          {!server && (
            <div className="banner-warn">
              The Mastra server did not start, so this session cannot reach an agent. The mascot,
              studio and sticker screens still work.
            </div>
          )}

          {messages.length === 0 && server && (
            <div className="thread-divider">
              <span className="meta">
                new thread ·{' '}
                {activeSession.type === 'scratch' ? 'nothing will be saved' : 'working memory on'}
              </span>
            </div>
          )}

          {messages.map((message, mi) => (
            <div key={message.id ?? mi} className="msg-group">
              {message.parts.map((part, pi) => {
                if (part.type === 'text') {
                  return message.role === 'user' ? (
                    <div key={pi} className="msg-user">
                      {part.text}
                    </div>
                  ) : (
                    <div key={pi} className="msg-agent">
                      <div className="msg-avatar">
                        <span className="agent-initial">{agent.name[0]}</span>
                      </div>
                      <div className="msg-body">{part.text}</div>
                    </div>
                  )
                }

                if (part.type.startsWith('tool-')) {
                  return (
                    <ToolPart
                      key={pi}
                      part={part as unknown as ToolUIPart}
                      onChoose={(text) => sendMessage({ text })}
                    />
                  )
                }
                return null
              })}
            </div>
          ))}

          <Thinking messages={messages} status={status} />

          {error && <div className="banner-warn">{error.message}</div>}
        </div>

        {mentionOpen && (
          <div className="mention-pop">
            <div className="mention-head">Bring an agent in as a subagent</div>
            {agents
              .filter((a) => a.id !== agent.id)
              .map((a) => {
                const inSession = activeSession.subagentIds.includes(a.id)
                return (
                  <button
                    key={a.id}
                    className="mention-row"
                    data-in={inSession}
                    onClick={() => {
                      if (inSession) return
                      dispatch({
                        type: 'sessions',
                        sessions: sessions.map((s) =>
                          s.id === activeSession.id
                            ? { ...s, subagentIds: [...s.subagentIds, a.id] }
                            : s
                        )
                      })
                      dispatch({ type: 'toggle', key: 'mentionOpen', value: false })
                    }}
                  >
                    <span className="mention-avatar">{a.name[0]}</span>
                    <span className="mention-text">
                      <span className="mention-name">@{a.id}</span>
                      <span className="meta">{a.description}</span>
                    </span>
                    {inSession && <span className="chip">in session</span>}
                  </button>
                )
              })}
            <div className="mention-foot">
              {agent.name} stays the supervisor. It decides when to hand off, using each
              agent&apos;s description.
            </div>
          </div>
        )}

        <div className="composer-wrap">
          {stickerPickerOpen && (
            <div className="sticker-pop">
              <div className="sticker-pop-head">
                <span>Send a sticker</span>
                <span className="meta">{library?.stickers.length ?? 0} in your folder</span>
              </div>
              <div className="sticker-pop-grid">
                {(library?.stickers ?? []).map((s) => (
                  <button
                    key={s.id}
                    className="sticker-pop-tile"
                    title={s.name}
                    onClick={() => {
                      fireSticker({ stickerId: s.id, caption: s.name })
                      dispatch({ type: 'toggle', key: 'stickerPickerOpen', value: false })
                    }}
                  >
                    {s.src ? <img src={s.src} alt={s.name} /> : <span className="mono">{s.name}</span>}
                  </button>
                ))}
              </div>
              {(library?.stickers.length ?? 0) === 0 && (
                <p className="meta">
                  No stickers yet — drop some into your stickers folder and they show up here.
                </p>
              )}
            </div>
          )}
          <div className="composer">
            <textarea
              className="composer-input"
              rows={2}
              value={input}
              placeholder={`Message ${agent.name}…`}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                // Enter sends. Win/Cmd+Enter is the newline. Ctrl+Enter approves
                // the question the agent is currently waiting on.
                if (e.metaKey) return // default: newline
                e.preventDefault()
                if (e.ctrlKey) approveLatest()
                else send()
              }}
            />
            <div className="composer-bar">
              <button
                className="composer-icon"
                aria-label="Attach a file"
                title="Attach a file"
                onClick={() => {
                  void window.mochi?.pickPaths('file').then((paths) => {
                    if (!paths.length) return
                    // Paths go into the message text: both backends run with
                    // file tools, so naming the file is what lets the agent open
                    // it — an upload would have nowhere to land.
                    setInput((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}${paths.join(' ')} `)
                  })
                }}
              >
                <Paperclip size={15} strokeWidth={1.8} />
              </button>
              <button
                className="composer-icon"
                aria-label="Set the workspace folder"
                title={activeSession.workspacePath ?? 'Set the workspace folder'}
                data-on={Boolean(activeSession.workspacePath)}
                onClick={() => {
                  void window.mochi?.pickPaths('folder').then((paths) => {
                    if (paths[0]) patchSession({ workspacePath: paths[0], kind: 'code' })
                  })
                }}
              >
                <FolderTree size={15} strokeWidth={1.8} />
              </button>
              <button
                className="composer-icon"
                aria-label="Bring in an agent"
                data-on={mentionOpen}
                onClick={() => dispatch({ type: 'toggle', key: 'mentionOpen' })}
              >
                <AtSign size={15} strokeWidth={1.8} />
              </button>
              <button
                className="composer-icon"
                aria-label="Send a sticker"
                data-on={stickerPickerOpen}
                onClick={() => dispatch({ type: 'toggle', key: 'stickerPickerOpen' })}
              >
                <StickerIcon size={15} strokeWidth={1.8} />
              </button>
              <span className="composer-spacer" />
              <button className="composer-icon" aria-label="Hold to talk">
                <Mic size={15} strokeWidth={1.8} />
              </button>
              <button
                className="pill-primary"
                onClick={send}
                disabled={!input.trim() || !transport || status === 'streaming'}
              >
                Send
                <ArrowUp size={14} strokeWidth={2.2} />
              </button>
            </div>
          </div>
          <div className="composer-hints meta">
            <span className="mono">{KEYS.send()}</span> send ·{' '}
            <span className="mono">{KEYS.newline()}</span> new line ·{' '}
            <span className="mono">{KEYS.approve()}</span> approve ·{' '}
            <span className="mono">{KEYS.stickerPicker()}</span> sticker picker ·{' '}
            <span className="mono">{KEYS.hideMascot()}</span> hide mascot
          </div>
        </div>
      </div>

      <SessionPanel messages={messages} />
    </div>
  )
}

/** Small helper used by the delegation block, kept here so the design stays
 *  colocated with the screen that renders it. */
export function DelegationBlock({
  to,
  prompt,
  answer,
  iteration,
  elapsed
}: {
  to: string
  prompt: string
  answer: string
  iteration: string
  elapsed: string
}): React.JSX.Element {
  return (
    <div className="delegation">
      <div className="delegation-head">
        <Network size={13} strokeWidth={1.8} className="warm" />
        <span>
          delegated to <span className="mono">{to}</span>
        </span>
        <span className="session-spacer" />
        <span className="meta">
          iteration {iteration} · {elapsed}
        </span>
      </div>
      <div className="delegation-body">
        <div className="delegation-prompt">prompt → {prompt}</div>
        <div className="delegation-rule" />
        <div className="delegation-answer">{answer}</div>
        <div className="delegation-foot">
          <Lock size={11} strokeWidth={1.8} />
          memory isolated — {to} keeps only this exchange, not your whole thread
        </div>
      </div>
    </div>
  )
}

export { ArtPlaceholder }
