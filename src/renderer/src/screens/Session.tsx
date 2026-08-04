import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type ToolUIPart, type UIMessage } from 'ai'
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
  Network,
  Square,
  RotateCcw,
  AlertTriangle,
  X
} from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { KEYS } from '@renderer/lib/platform'
import { forgetMessages, loadMessages, saveMessages } from '@renderer/lib/history'
import { ArtPlaceholder } from '@renderer/components/ui/Controls'
import { SessionPanel } from './SessionPanel'
import { ToolGroup, ToolPart, type WorkPart } from '@renderer/components/chat/ToolPart'
import { Thinking } from '@renderer/components/chat/Thinking'
import { SmoothText } from '@renderer/components/chat/SmoothText'
import { MessageActions } from '@renderer/components/chat/MessageActions'
import { AskDock, type PendingAsk } from '@renderer/components/chat/AskDock'
import { PermissionCard, type PermissionRequest } from '@renderer/components/chat/PermissionCard'
import * as devlog from '@renderer/lib/devlog'
import { useAgentArt } from '@renderer/lib/useAgentArt'
import './screens.css'

/** How often the transcript is written while a reply is still streaming. Bounds
 *  how much of a turn a session switch or a window close can cost — see the
 *  persistence block below. */
const STREAM_SAVE_MS = 700

interface AskInput {
  question?: string
  options?: string[]
  allowOther?: boolean
  multiple?: boolean
}

/** A turn that failed, recorded in the transcript so the gap is explained rather
 *  than silent. Marked in `metadata` so it round-trips through JSON and can be
 *  told apart from something the agent actually said. */
function isFailure(message: UIMessage): boolean {
  return (message.metadata as { mochiError?: boolean } | undefined)?.mochiError === true
}

/** A partial `@name` immediately before the caret — what opens and filters the
 *  mention picker while typing. */
const MENTION_AT_CARET = /@([\w-]*)$/
const MENTION_AT_END = /@([\w-]*)$/

function appendTag(value: string, id: string): string {
  return `${value}${value && !value.endsWith(' ') ? ' ' : ''}@${id} `
}

function flattenText(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n')
}

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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** The partial `@name` being typed, or null when the picker was opened from
   *  the toolbar button instead. Drives the filter and the token replacement. */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)

  // Clicking anywhere else dismisses the header menu.
  useEffect(() => {
    if (!headMenu) return
    const close = (): void => setHeadMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [headMenu])

  const agent = activeSession ? agentById(activeSession.agentId) : undefined

  // The agent's own mascot art. Shared with the loadout and start-a-session
  // screens — see `useAgentArt` for why the store's `spriteSrc` cannot serve it.
  const art = useAgentArt(agent ? [agent.spritePreset] : [])
  const agentArt = agent ? art[agent.spritePreset] : null

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

  /**
   * Approval cards that came off disk rather than off the wire.
   *
   * The promise each one was blocking died with the main process that parked it,
   * so a restored card is decoration — but it rendered with live buttons, which
   * invited the user to approve something that had stopped existing. Anything
   * arriving after mount is by definition from the current stream, so capturing
   * the ids present in the restored transcript is enough to tell them apart.
   */
  const staleApprovals = useMemo(() => {
    const ids = new Set<string>()
    for (const message of initialMessages) {
      for (const part of message.parts ?? []) {
        if (part.type !== 'data-permission') continue
        const id = (part as unknown as { data?: { id?: string } }).data?.id
        if (id) ids.add(id)
      }
    }
    return ids
  }, [initialMessages])

  /*
   * Messages typed while the agent is still working.
   *
   * Previously these went straight down the wire — the Send button was disabled
   * during `streaming`, but Enter bypassed it and `submitted` was never covered
   * at all, which is how three "hi"s ended up stacked mid-reply.
   *
   * The queue drains from the chat's own `onFinish` rather than an effect
   * watching `status`. Draining is a reaction to a turn ending, not state
   * synchronisation, and doing it in an effect cascades a render per item.
   * `queueRef` shadows the state because `onFinish` is bound once and would
   * otherwise close over an empty queue forever.
   */
  const [queue, setQueue] = useState<string[]>([])
  const queueRef = useRef<string[]>([])
  const sendRef = useRef<((text: string) => void) | null>(null)
  /** Read inside `onFinish`, which is bound once — a captured value would be the
   *  agent that was selected when the chat was created, not the current one. */
  const finishLineRef = useRef<string | undefined>(undefined)

  const drainQueue = useCallback(() => {
    const [next, ...rest] = queueRef.current
    if (next === undefined) return
    queueRef.current = rest
    setQueue(rest)
    sendRef.current?.(next)
  }, [])

  const { messages, sendMessage, setMessages, regenerate, stop, status, error, clearError } =
    useChat({
      transport,
      id: activeSession?.id,
      messages: initialMessages,
      // Deliberately not drained on error: after a failure the user should get
      // to see it and decide, rather than have the queue push another turn into
      // whatever just broke. The chips stay put and go out after the next reply.
      onFinish: () => {
        devlog.push('chat', 'turn finished')
        // Tell the user the work is done if they have looked away. Main owns the
        // focus test — the overlay is a non-focusable window and cannot tell
        // "backgrounded" from "I am the overlay". A no-op when Mochi is in front.
        void window.mochi?.agentFinished(finishLineRef.current)
        drainQueue()
      }
    })

  useEffect(() => {
    sendRef.current = (text: string) => sendMessage({ text })
  }, [sendMessage])

  /**
   * Stop, on both sides.
   *
   * `stop()` alone only aborts the fetch — it detaches this reader and leaves
   * the agent running in the main process, still spending the subscription and
   * still able to write files after the user asked it to stop. The POST reaches
   * the SDK's own `interrupt()`, which is the part that actually halts it.
   *
   * The queue is cleared too. Draining it into the gap left by a cancelled turn
   * is the opposite of what Stop means, and the interrupt cannot clear it for us
   * — Mochi's queue lives here, not in the SDK.
   */
  const stopEverything = useCallback((): void => {
    stop()
    queueRef.current = []
    setQueue([])
    const sessionId = activeSession?.id
    if (!server || !sessionId) return
    void fetch(`${server.baseUrl}/agent-sdk/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId })
    }).catch(() => {
      // The run may already have finished. Nothing to report — the local stop
      // has happened either way.
    })
  }, [stop, server, activeSession?.id])

  // The line the mascot says when a turn lands. Prefers the agent's generated
  // voice over a generic "done".
  useEffect(() => {
    const own = agent?.bubbleLines
    finishLineRef.current = own?.length
      ? own[Math.floor(Math.random() * own.length)]
      : agent
        ? `${agent.name} finished that one`
        : undefined
  }, [agent])

  const busy = status === 'streaming' || status === 'submitted'

  // Stream lifecycle and tool traffic, for the debug log. Both are no-ops unless
  // developer mode armed the buffer.
  useEffect(() => {
    devlog.push('chat', `status: ${status}`, {
      route: onSubscription ? 'agent-sdk' : 'mastra',
      messages: messages.length
    })
  }, [status, onSubscription, messages.length])

  useEffect(() => {
    if (error) devlog.push('error', 'chat error', error)
  }, [error])

  // Each tool call, once per state transition. Guarded on `isArmed` before the
  // scan because `messages` changes on every token — with the log off this must
  // cost nothing, not walk the whole thread per frame.
  const seenTools = useRef(new Set<string>())
  useEffect(() => {
    if (!devlog.isArmed()) return
    for (const message of messages) {
      for (const part of message.parts) {
        if (!part.type.startsWith('tool-')) continue
        const tool = part as unknown as { toolCallId?: string; state?: string; input?: unknown }
        if (!tool.toolCallId) continue
        const key = `${tool.toolCallId}:${tool.state ?? ''}`
        if (seenTools.current.has(key)) continue
        seenTools.current.add(key)
        devlog.push('tool', `${part.type.replace('tool-', '')} · ${tool.state ?? 'called'}`, tool.input)
      }
    }
  }, [messages])

  /*
   * Persistence — defect D1 in docs/debug-missing-replies.md.
   *
   * This used to early-return while streaming, so a turn that was still in
   * flight when you switched session or closed the window was never written.
   * It was also unrecoverable: `@ai-sdk/react` builds a brand-new `Chat`
   * whenever `id` changes and drops the old one, with no unmount hook to flush
   * from.
   *
   * The fix is to write during the stream too, throttled. Doing it per token
   * would re-serialise the whole thread on every frame, which is what the
   * original guard was avoiding; doing it every STREAM_SAVE_MS bounds the loss
   * to that interval instead of the whole turn.
   *
   * Deliberately not solved with a cleanup on an id-keyed effect: a ref shared
   * across renders already holds the *incoming* session's messages by the time
   * that cleanup runs, so it would write the new thread over the old one.
   */
  const lastWrite = useRef(0)
  useEffect(() => {
    const sessionId = activeSession?.id
    if (!sessionId) return
    if (busy) {
      const now = Date.now()
      if (now - lastWrite.current < STREAM_SAVE_MS) return
      lastWrite.current = now
    } else {
      lastWrite.current = 0
    }
    saveMessages(sessionId, messages)
  }, [messages, busy, activeSession?.id])

  // Closing the window is the same loss with a simpler cause: there was no
  // `beforeunload` handler anywhere in the renderer. This one is safe to drive
  // from a ref because an unload involves no session change — the ref and the
  // window are torn down together.
  const liveRef = useRef<{ id?: string; messages: UIMessage[] }>({ messages: [] })
  useEffect(() => {
    liveRef.current = { id: activeSession?.id, messages }
  }, [messages, activeSession?.id])
  useEffect(() => {
    const flush = (): void => {
      const { id, messages: live } = liveRef.current
      if (id) saveMessages(id, live)
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  // Defect D2. A failed turn *was* persisted — as the user's message with no
  // reply — so returning to the session was indistinguishable from a turn that
  // went missing. Record the failure in the transcript instead: the gap gets an
  // explanation, and Retry has something concrete to remove.
  useEffect(() => {
    if (status !== 'error' || !error) return
    setMessages((prev) => {
      if (prev.length > 0 && isFailure(prev[prev.length - 1])) return prev
      return [
        ...prev,
        {
          id: `mochi-error-${Date.now()}`,
          role: 'assistant',
          metadata: { mochiError: true },
          parts: [{ type: 'text', text: error.message || 'The agent did not reply.' }]
        } as UIMessage
      ]
    })
  }, [status, error, setMessages])

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

  // Let the agent name the session once the first exchange lands. Only ever
  // runs once per session, and never touches a title you set yourself.
  useEffect(() => {
    if (!server || !activeSession || activeSession.autoTitled) return
    if (status !== 'ready') return
    const firstUser = messages.find((m) => m.role === 'user')
    const firstReply = messages.find((m) => m.role === 'assistant')
    if (!firstUser || !firstReply) return

    const flatten = (m: (typeof messages)[number]): string =>
      m.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join(' ')

    const body = `User: ${flatten(firstUser)}\nAssistant: ${flatten(firstReply)}`.trim()
    if (body.length < 12) return

    let cancelled = false
    // Marked before the request so a re-render mid-flight can't fire a second one.
    patchSession({ autoTitled: true })
    void fetch(`${server.baseUrl}/agent-sdk/title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body })
    })
      .then((r) => r.json() as Promise<{ title: string | null }>)
      .then(({ title }) => {
        if (cancelled || !title) return
        patchSession({ title })
      })
      .catch(() => {
        /* keep the typed title */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, messages.length, activeSession?.id, activeSession?.autoTitled, server])

  // Deliver the message typed on the Start-a-session screen. Waits for the
  // transport, since sending before it exists silently drops the turn, and
  // clears immediately so a re-render can't send it twice.
  useEffect(() => {
    if (!pendingSend || !transport) return
    dispatch({ type: 'pending-send', text: null })
    sendMessage({ text: pendingSend })
  }, [pendingSend, transport, sendMessage, dispatch])

  /*
   * The questions the agent is waiting on.
   *
   * Derived from the transcript rather than held in state, which is what fixes
   * the repeat-answer bug: `askUser` never suspends the run (see
   * `mochi-tools.ts`), so an answer is just a user turn — and a question is
   * therefore open precisely while no user message follows it. Answering closes
   * it on the same render that appends the reply, so a second click has nothing
   * left to submit. It also survives a reload for free.
   */
  const pendingAsks = useMemo<PendingAsk[]>(() => {
    let lastUser = -1
    messages.forEach((m, i) => {
      if (m.role === 'user') lastUser = i
    })
    const asks: PendingAsk[] = []
    messages.forEach((message, i) => {
      if (i < lastUser || message.role !== 'assistant') return
      for (const part of message.parts) {
        if (part.type !== 'tool-askUser') continue
        const tool = part as unknown as { toolCallId?: string; input?: AskInput }
        const input = tool.input
        if (!input?.question || !input.options?.length) continue
        asks.push({
          id: tool.toolCallId ?? `${message.id}-${asks.length}`,
          question: input.question,
          options: input.options,
          allowOther: input.allowOther !== false,
          multi: input.multiple === true
        })
      }
    })
    return asks
  }, [messages])

  // Skipping is the escape hatch for a question the user would rather answer in
  // their own words. Keyed on tool call id so it cannot leak onto a later one.
  const [skipped, setSkipped] = useState<string[]>([])
  const openAsks = useMemo(
    () => pendingAsks.filter((a) => !skipped.includes(a.id)),
    [pendingAsks, skipped]
  )

  /**
   * Say something to the turn that is already running.
   *
   * `next` waits for it to finish, `now` redirects it. Both go to the run
   * itself rather than being held here until `onFinish`: the SDK understands
   * `priority` on a queued message, so the follow-up becomes the next turn on
   * the same connection instead of a second request the renderer has to
   * remember to make — which is how a reload used to lose everything typed
   * ahead.
   *
   * The chip is still local, because it is a receipt for something the user
   * typed, and it clears when the turn it was waiting behind finishes.
   */
  const speakInto = useCallback(
    (text: string, priority: 'now' | 'next'): void => {
      queueRef.current = [...queueRef.current, text]
      setQueue(queueRef.current)

      const sessionId = activeSession?.id
      if (!server || !sessionId) return
      void fetch(`${server.baseUrl}/agent-sdk/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, text, priority })
      })
        .then((r) => r.json())
        .then((r: { ok?: boolean }) => {
          // The turn finished between typing and sending, so nothing was
          // listening. Send it as an ordinary message rather than dropping it.
          if (r.ok) return
          queueRef.current = queueRef.current.filter((t) => t !== text)
          setQueue(queueRef.current)
          sendMessage({ text })
        })
        .catch(() => {
          queueRef.current = queueRef.current.filter((t) => t !== text)
          setQueue(queueRef.current)
        })
    },
    [server, activeSession?.id, sendMessage]
  )

  const dropQueued = useCallback((index: number) => {
    queueRef.current = queueRef.current.filter((_, i) => i !== index)
    setQueue(queueRef.current)
  }, [])

  const answerAsk = useCallback(
    (text: string) => {
      setSkipped([])
      sendMessage({ text })
    },
    [sendMessage]
  )

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
    const ask = openAsks[openAsks.length - 1]
    if (ask?.options[0]) {
      answerAsk(ask.options[0])
      return
    }
    send()
  }

  /** Retry drops the recorded failure first, so a second failure replaces it
   *  rather than stacking a wall of identical banners. */
  const retry = (): void => {
    setMessages((prev) => prev.filter((m) => !isFailure(m)))
    clearError()
    void regenerate()
  }

  /** Editing rewinds the thread to just before that message and puts its text
   *  back in the composer — the reply being edited away is no longer true, so
   *  keeping it would leave the agent answering a question you retracted. */
  const editMessage = (index: number): void => {
    setInput(flattenText(messages[index]))
    setMessages((prev) => prev.slice(0, index))
    clearError()
  }

  const patchSession = (next: Partial<typeof activeSession>): void => {
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) => (s.id === activeSession.id ? { ...s, ...next } : s))
    })
  }

  /**
   * Typing `@` opens the picker and filters it as you keep typing.
   *
   * Previously the picker was reachable only from the toolbar button, and
   * choosing an agent added it to `subagentIds` without ever putting an `@id`
   * into the message — so from the user's side, tagging with `@` simply did
   * nothing. Both halves are wired here.
   */
  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setInput(value)
    const caret = e.target.selectionStart ?? value.length
    const token = MENTION_AT_CARET.exec(value.slice(0, caret))
    setMentionQuery(token ? token[1] : null)
    if (token) {
      if (!mentionOpen) dispatch({ type: 'toggle', key: 'mentionOpen', value: true })
    } else if (mentionOpen && mentionQuery !== null) {
      dispatch({ type: 'toggle', key: 'mentionOpen', value: false })
    }
  }

  const addMention = (id: string): void => {
    if (!activeSession.subagentIds.includes(id)) {
      dispatch({
        type: 'sessions',
        sessions: sessions.map((s) =>
          s.id === activeSession.id ? { ...s, subagentIds: [...s.subagentIds, id] } : s
        )
      })
    }
    // Replace the partial token when one is being typed, otherwise append.
    // The replace is anchored to the end of the text rather than the caret, so
    // tagging mid-sentence after moving the cursor back is not yet handled.
    setInput((v) => (mentionQuery !== null ? v.replace(MENTION_AT_END, `@${id} `) : appendTag(v, id)))
    setMentionQuery(null)
    dispatch({ type: 'toggle', key: 'mentionOpen', value: false })
    inputRef.current?.focus()
  }

  const mentionable = agents.filter(
    (a) =>
      a.id !== agent.id &&
      (mentionQuery
        ? a.id.toLowerCase().includes(mentionQuery.toLowerCase()) ||
          a.name.toLowerCase().includes(mentionQuery.toLowerCase())
        : true)
  )

  const pickWorkspace = (): void => {
    void window.mochi?.pickPaths('folder').then((paths) => {
      if (paths[0]) patchSession({ workspacePath: paths[0], kind: 'code' })
    })
  }

  /** `steer` sends into the running turn instead of queueing behind it — the
   *  "no, do this instead" case, where waiting for the current answer is exactly
   *  what you do not want. Ignored when nothing is running. */
  const send = (steer = false): void => {
    const text = input.trim()
    if (!text) return
    if (!transport) return
    setInput('')
    if (busy) {
      const priority = steer ? 'now' : 'next'
      devlog.push('chat', `${priority === 'now' ? 'steered' : 'queued'} while busy`, {
        chars: text.length
      })
      speakInto(text, priority)
      return
    }
    devlog.push('chat', 'send', { chars: text.length })
    setSkipped([])
    sendMessage({ text })
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
            {agentArt ? (
              <img className="avatar-art" src={agentArt} alt="" draggable={false} />
            ) : (
              <span className="agent-initial">{agent.name[0]}</span>
            )}
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

        {/* Always shown. The agent runs with file tools in both backends, so
            "which folder am I pointed at" is not an advanced detail — it is the
            difference between a request working and hanging. Previously this
            strip only appeared when a branch was set, which meant the path was
            invisible in exactly the sessions where nothing had been configured. */}
        <div className="repo-strip">
          <FolderTree size={13} strokeWidth={1.8} className="ic-code" />
          {activeSession.workspacePath ? (
            <span className="mono repo-path" title={activeSession.workspacePath}>
              {activeSession.workspacePath}
            </span>
          ) : (
            <span className="meta">No folder set — the agent cannot reach your files</span>
          )}
          {activeSession.branch && (
            <>
              <GitBranch size={13} strokeWidth={1.8} className="ic-code" />
              <span className="mono">{activeSession.branch}</span>
            </>
          )}
          <span className="session-spacer" />
          <button className="pill-ghost" onClick={pickWorkspace}>
            {activeSession.workspacePath ? 'Change' : 'Set folder'}
          </button>
        </div>

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

          {messages.map((message, mi) => {
            if (isFailure(message)) {
              return (
                <div key={message.id ?? mi} className="msg-failure">
                  <AlertTriangle size={14} strokeWidth={1.9} />
                  <div className="msg-failure-body">
                    <strong>That turn did not go through.</strong>
                    <span className="meta">{flattenText(message)}</span>
                  </div>
                  <button className="pill-ghost" onClick={retry} disabled={busy}>
                    <RotateCcw size={13} strokeWidth={1.9} />
                    Retry
                  </button>
                </div>
              )
            }

            const source = flattenText(message)
            const isLast = mi === messages.length - 1
            return (
              <div key={message.id ?? mi} className="msg-group" data-role={message.role}>
                {message.parts.map((part, pi) => {
                  if (part.type === 'text') {
                    // Only the agent's text is markdown. What the user typed is
                    // shown back exactly as typed — reinterpreting it would mean
                    // their asterisks silently disappear.
                    return message.role === 'user' ? (
                      <div key={pi} className="msg-user">
                        {part.text}
                      </div>
                    ) : (
                      <div key={pi} className="msg-agent">
                        <div className="msg-avatar">
                          {agentArt ? (
                            <img className="avatar-art" src={agentArt} alt="" draggable={false} />
                          ) : (
                            <span className="agent-initial">{agent.name[0]}</span>
                          )}
                        </div>
                        <div className="msg-body">
                          {/* Only the reply currently arriving animates. `mi`
                              is the message index, so this is "the last message,
                              while the run is live" — anything else, including
                              every message in a restored transcript, renders
                              whole. */}
                          <SmoothText
                            text={part.text}
                            active={busy && mi === messages.length - 1}
                          />
                        </div>
                      </div>
                    )
                  }

                  /*
                   * An approval and the call it gates are one thing.
                   *
                   * They arrive as separate parts, and rendering them as
                   * separate cards meant the command sat in one box and the
                   * Allow button in another — with only the blocked path
                   * between them, so what you were approving was in a different
                   * card from the button approving it.
                   */
                  const isWork = (t?: string): boolean =>
                    Boolean(t && (t.startsWith('tool-') || t === 'data-permission'))

                  if (isWork(part.type)) {
                    // Already folded into a run that began earlier.
                    if (isWork(message.parts[pi - 1]?.type)) return null

                    // Everything up to the next thing that isn't work. The whole
                    // stretch between two replies is one step in the
                    // conversation, so it gets one card.
                    const run: WorkPart[] = []
                    for (let i = pi; i < message.parts.length; i++) {
                      if (!isWork(message.parts[i].type)) break
                      run.push(message.parts[i] as unknown as WorkPart)
                    }

                    if (run.length > 1 && server) {
                      return (
                        <ToolGroup
                          key={pi}
                          parts={run}
                          baseUrl={server.baseUrl}
                          staleApprovals={staleApprovals}
                        />
                      )
                    }

                    if (part.type === 'data-permission') {
                      const req = (part as unknown as { data: PermissionRequest }).data
                      return server ? (
                        <PermissionCard
                          key={pi}
                          request={req}
                          baseUrl={server.baseUrl}
                          stale={staleApprovals.has(req.id)}
                        />
                      ) : null
                    }
                    return <ToolPart key={pi} part={part as unknown as ToolUIPart} />
                  }
                  return null
                })}
                {source.trim() && (
                  <MessageActions
                    text={source}
                    onEdit={message.role === 'user' && !busy ? () => editMessage(mi) : undefined}
                    onRetry={
                      message.role === 'assistant' && isLast && !busy ? retry : undefined
                    }
                  />
                )}
              </div>
            )
          })}

          <Thinking messages={messages} status={status} />
        </div>

        {mentionOpen && (
          <div className="mention-pop">
            <div className="mention-head">
              Bring an agent in as a subagent
              {mentionQuery ? <span className="mono"> · @{mentionQuery}</span> : null}
            </div>
            {mentionable.length === 0 && (
              <div className="mention-empty meta">No agent matches that name.</div>
            )}
            {mentionable.map((a) => {
              const inSession = activeSession.subagentIds.includes(a.id)
              return (
                <button
                  key={a.id}
                  className="mention-row"
                  data-in={inSession}
                  onClick={() => addMention(a.id)}
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
          <AskDock
            asks={openAsks}
            disabled={busy}
            onAnswer={answerAsk}
            onSkip={() => setSkipped(pendingAsks.map((a) => a.id))}
          />

          {queue.length > 0 && (
            <div className="queue-strip">
              <span className="meta">
                {queue.length} queued · sends when {agent.name} finishes
              </span>
              {queue.map((q, i) => (
                <span key={`${i}-${q}`} className="queue-chip">
                  <span className="queue-text">{q}</span>
                  <button
                    className="queue-drop"
                    aria-label="Remove from queue"
                    onClick={() => dropQueued(i)}
                  >
                    <X size={11} strokeWidth={2.2} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="composer">
            <textarea
              ref={inputRef}
              className="composer-input"
              rows={2}
              value={input}
              disabled={openAsks.length > 0}
              placeholder={
                openAsks.length > 0
                  ? 'Pick an answer above, or choose to write your own…'
                  : busy
                    ? `${agent.name} is working — your message will be queued…`
                    : `Message ${agent.name}…`
              }
              onChange={onInputChange}
              onKeyDown={(e) => {
                // While the picker is filtering a typed `@name`, Enter takes the
                // top match instead of sending a half-written mention.
                if (e.key === 'Escape' && mentionOpen) {
                  setMentionQuery(null)
                  dispatch({ type: 'toggle', key: 'mentionOpen', value: false })
                  return
                }
                if (e.key === 'Enter' && mentionQuery !== null && mentionable[0]) {
                  e.preventDefault()
                  addMention(mentionable[0].id)
                  return
                }
                if (e.key !== 'Enter') return
                // Enter sends. Shift+Enter is the newline. Ctrl+Enter approves
                // the question the agent is currently waiting on.
                //
                // This tested `metaKey`, which on Windows is the Windows key —
                // so the newline was on Win+Enter, a chord the OS itself mostly
                // eats, and Shift+Enter sent the message like a bare Enter.
                if (e.shiftKey) return // default: newline
                e.preventDefault()
                // Alt+Enter redirects a turn that is already running. Not Shift
                // (newline) and not Ctrl (approve), both of which are taken.
                if (e.altKey) send(true)
                else if (e.ctrlKey) approveLatest()
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
                onClick={pickWorkspace}
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
              {busy && (
                <button className="pill-ghost" onClick={stopEverything} aria-label="Stop generating">
                  <Square size={12} strokeWidth={2.4} />
                  Stop
                </button>
              )}
              {/* Enabled while busy on purpose: sending now queues rather than
                  interleaving, so there is no reason to block typing ahead. */}
              <button
                className="pill-primary"
                // Wrapped: the click event would otherwise arrive as `steer`.
                onClick={() => send()}
                disabled={!input.trim() || !transport || openAsks.length > 0}
              >
                {busy ? 'Queue' : 'Send'}
                <ArrowUp size={14} strokeWidth={2.2} />
              </button>
            </div>
          </div>
          <div className="composer-hints meta">
            <span className="mono">{KEYS.send()}</span> send ·{' '}
            <span className="mono">{KEYS.newline()}</span> new line ·{' '}
            <span className="mono">{KEYS.approve()}</span> approve ·{' '}
            {/* Only while a turn is running — steering an idle session is just
                sending, and advertising it the rest of the time is noise. */}
            {busy && (
              <>
                <span className="mono">{KEYS.steer()}</span> steer now ·{' '}
              </>
            )}
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
