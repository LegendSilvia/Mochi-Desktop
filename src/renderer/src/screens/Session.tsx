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
  Check,
  Lock,
  Network
} from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { KEYS, hasMod } from '@renderer/lib/platform'
import { ArtPlaceholder } from '@renderer/components/ui/Controls'
import { SessionPanel } from './SessionPanel'
import './screens.css'

/** AI SDK tool-part states, mapped to the words the design uses. */
const TOOL_STATE_LABEL: Record<string, string> = {
  'input-streaming': 'sending',
  'input-available': 'ready',
  'approval-requested': 'waiting on you',
  'approval-responded': 'answered',
  'output-available': 'done',
  'output-error': 'failed'
}

export function Session(): React.JSX.Element {
  const { activeSession, agentById, server, dispatch, mentionOpen, agents, sessions, fireSticker } =
    useStore()
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const agent = activeSession ? agentById(activeSession.agentId) : undefined

  // The transport is rebuilt when the agent or the server port changes. The port
  // is chosen at runtime, so this cannot be a module-level constant.
  const transport = useMemo(() => {
    if (!server || !agent) return undefined
    return new DefaultChatTransport({ api: `${server.baseUrl}/chat/${agent.id}` })
  }, [server, agent])

  const { messages, sendMessage, status, error } = useChat({
    transport,
    id: activeSession?.id
  })

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

  if (!activeSession || !agent) {
    return (
      <div className="screen-body empty-state">
        <p>No session open. Start one from the rail.</p>
      </div>
    )
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
          {activeSession.type !== 'scratch' && agent.workingMemory && (
            <span className="chip accent">memory on</span>
          )}
          {activeSession.type === 'scratch' && (
            <span className="chip">scratch · nothing saved</span>
          )}
          <button className="tb-icon" aria-label="Session menu">
            <MoreVertical size={15} strokeWidth={1.8} />
          </button>
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
                  const tool = part as unknown as ToolUIPart
                  const name = tool.type.split('-').slice(1).join('-')
                  const failed = tool.state === 'output-error'
                  return (
                    <div key={pi} className="tool-card">
                      <div className="tool-row">
                        {failed ? (
                          <span className="tool-x">!</span>
                        ) : (
                          <Check size={13} strokeWidth={2.2} className="tool-check" />
                        )}
                        <span className="mono tool-id">{name}</span>
                        <span className="mono tool-arg">
                          {tool.input ? JSON.stringify(tool.input) : ''}
                        </span>
                        <span className="mono tool-dur">
                          {TOOL_STATE_LABEL[tool.state ?? 'output-available']}
                        </span>
                      </div>
                      {failed && tool.errorText && (
                        <div className="tool-error mono">{tool.errorText}</div>
                      )}
                    </div>
                  )
                }
                return null
              })}
            </div>
          ))}

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
          <div className="composer">
            <textarea
              className="composer-input"
              rows={2}
              value={input}
              placeholder={`Message ${agent.name}…`}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hasMod(e)) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="composer-bar">
              <button className="composer-icon" aria-label="Attach">
                <Paperclip size={15} strokeWidth={1.8} />
              </button>
              <button className="composer-icon" aria-label="Workspace">
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
                onClick={() => fireSticker()}
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
            <span className="mono">{KEYS.stickerPicker()}</span> sticker picker ·{' '}
            <span className="mono">{KEYS.pushToTalk()}</span> hold to talk ·{' '}
            <span className="mono">{KEYS.hideMascot()}</span> hide mascot
          </div>
        </div>
      </div>

      <SessionPanel />
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
