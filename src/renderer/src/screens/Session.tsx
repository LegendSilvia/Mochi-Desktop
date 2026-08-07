import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Info,
  Lock,
  Network,
  Square,
  RotateCcw,
  AlertTriangle,
  Users,
  X
} from 'lucide-react'
import { useStore } from '@renderer/state/context'
import { DEFAULT_RECALL_TOP_K, DEFAULT_SETTINGS } from '@shared/defaults'
import { personalResource } from '@shared/memory'
import { KEYS } from '@renderer/lib/platform'
import { forgetMessages, loadMessages, saveMessages } from '@renderer/lib/history'
import {
  chatFor,
  chatOf,
  flushAllChats,
  forgetChat,
  noteActivity,
  onChatFinish
} from '@renderer/lib/chatRegistry'
import { ArtPlaceholder } from '@renderer/components/ui/Controls'
import { WidgetHost } from '@renderer/components/widgets/WidgetHost'
import { ToolGroup, ToolPart, type WorkPart } from '@renderer/components/chat/ToolPart'
import { isPresentational } from '@renderer/lib/toolKinds'
import { Thinking } from '@renderer/components/chat/Thinking'
import { SmoothText } from '@renderer/components/chat/SmoothText'
import { withMentions } from '@renderer/components/chat/mentions'
import { MessageActions } from '@renderer/components/chat/MessageActions'
import { AskDock, type PendingAsk } from '@renderer/components/chat/AskDock'
import { PermissionCard, type PermissionRequest } from '@renderer/components/chat/PermissionCard'
import { ModePicker, type ModePickerModel } from '@renderer/components/chat/ModePicker'
import { PERMISSION_MODES, coerceMode, type PermissionMode } from '@shared/permission-modes'
import * as devlog from '@renderer/lib/devlog'
import { useAgentArt } from '@renderer/lib/useAgentArt'
import './screens.css'
import '@renderer/components/widgets/widgets.css'

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

/**
 * Which agent said it.
 *
 * A transcript used to have exactly one possible speaker, so nothing recorded
 * who it was — the session's agent was the answer by construction. That stops
 * being true the moment an agent can pull another into the chat, and a reply
 * with no attribution is then unreadable: two agents, one avatar, no way to
 * tell which one just contradicted the other.
 *
 * `undefined` for every message written before this existed, and for one still
 * arriving; the caller falls back to the session's own agent, which is what
 * those messages meant.
 */
function speakerId(message: UIMessage): string | undefined {
  return (message.metadata as { agentId?: string } | undefined)?.agentId
}

/** A turn one agent handed to another, rather than one the user asked for. */
interface Handoff {
  from: string
  to: string
  /** Position in this chain. The user's own message is depth 0. */
  depth: number
}

function handoffOf(message: UIMessage | undefined): Handoff | undefined {
  return (message?.metadata as { handoff?: Handoff } | undefined)?.handoff
}

/** The chain hit its limit here. Rendered so the stop is visible: a chain that
 *  simply ends looks exactly like an agent with nothing more to say, and one of
 *  those is finished while the other was cut off. */
function chainStopOf(
  message: UIMessage
): { from: string; to: string; limit: number } | undefined {
  return (message.metadata as { chainStopped?: { from: string; to: string; limit: number } })
    ?.chainStopped
}

/**
 * The agent a message is *addressed to*, as opposed to one it merely mentions.
 *
 * Position is what separates the two. Any `@name` used to count, which made
 * talking about an agent indistinguishable from talking to one: Fraux writing
 * "I'll send @new-agent a single message instead" was explaining what it would
 * do, and handed Helper the turn while saying so. A tag at the start of a
 * message is who it is for; one at the end is a call-out to them; one buried in
 * a sentence is a reference to them.
 *
 * Both ends are needed. People type `@helper do this`, and the mention picker
 * appends its tag after whatever you have already written.
 */
function addressedTag(text: string, roster: string[], self?: string): string | null {
  const trimmed = text.trim()
  const ends = [/^@([\w-]+)\b/.exec(trimmed), /@([\w-]+)[\s.!?,:;]*$/.exec(trimmed)]
  for (const match of ends) {
    const id = match?.[1]
    if (id && id !== self && roster.includes(id)) return id
  }
  return null
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
    stickerPickerOpen,
    rules,
    stickerSrc
  } = useStore()
  const [input, setInput] = useState('')
  const [headMenu, setHeadMenu] = useState(false)
  const [headInfo, setHeadInfo] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** The partial `@name` being typed, or null when the picker was opened from
   *  the toolbar button instead. Drives the filter and the token replacement. */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  /** Which row the arrow keys are on. Reset whenever the list changes, so a
   *  narrowing filter cannot leave the highlight past the end of it. */
  const [mentionIndex, setMentionIndex] = useState(0)

  /**
   * The subscription's own model list, for the mode picker's Auto submenu.
   *
   * Fetched once per mount rather than gated on a menu opening — unlike the
   * settings-screen model picker, this one also has to answer whether the
   * *current* model supports the native classifier before the menu is ever
   * touched, so the summary pill can name a blocked model correctly on first
   * render instead of after a click.
   */
  const [subscriptionModels, setSubscriptionModels] = useState<ModePickerModel[]>([])
  useEffect(() => {
    void window.mochi?.anthropicModels().then((rows) => setSubscriptionModels(rows))
  }, [])

  /*
   * Approvals answered somewhere other than this card.
   *
   * Each card tracked its own decision in local state, so answering on the
   * desktop left the in-app card still offering Allow and Deny for a command
   * that had already run — the tool row above it said "done" while the card
   * below still asked. Main names the id whenever one settles, wherever it was
   * settled, and every surface showing it stands down.
   */
  const [settledApprovals, setSettledApprovals] = useState<string[]>([])
  useEffect(() => {
    return window.mochi?.onApproval((next) => {
      if (!('settled' in next)) return
      setSettledApprovals((prev) => (prev.includes(next.id) ? prev : [...prev, next.id]))
    })
  }, [])

  // Clicking anywhere else dismisses the header menu.
  useEffect(() => {
    if (!headMenu) return
    const close = (): void => setHeadMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [headMenu])

  useEffect(() => {
    if (!headInfo) return
    const close = (): void => setHeadInfo(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [headInfo])

  const agent = activeSession ? agentById(activeSession.agentId) : undefined

  // Mascot art for every agent, not just this session's. Shared with the
  // loadout and start-a-session screens — see `useAgentArt` for why the store's
  // `spriteSrc` cannot serve it.
  //
  // It used to load the one folder the session's agent uses, which is enough
  // right up until a reply comes from someone else: the transcript would then
  // show that agent's name over this one's face. There are a handful of agents
  // and each folder is loaded once, so asking for all of them costs nothing.
  const art = useAgentArt(agents.map((a) => a.spritePreset))
  const agentArt = agent ? art[agent.spritePreset] : null

  // The transport is rebuilt when the agent, the server port or the backend
  // changes. The port is chosen at runtime, so this cannot be a module-level
  // constant. Both routes speak the same UI-message-stream protocol; they differ
  // only in what pays — /chat bills an API key, /agent-sdk/chat draws on the
  // Claude subscription via the Agent SDK.
  /*
   * The subscription only pays for Anthropic, so the model decides the route as
   * much as the setting does.
   *
   * This read the setting alone, which meant picking any `openrouter/…` or
   * `openai/…` model sent the turn to a backend that cannot run it. The backend
   * refused correctly — but the only way out was to know that "Run on my Claude
   * subscription" had to be turned off globally, for every agent, to use one
   * non-Anthropic model. Falling through to the API-key backend per agent is
   * what the setting already means: use the subscription where it applies.
   */
  const onSubscription =
    settings.preferSubscription && (agent?.model ?? '').startsWith('anthropic/')
  const folder = activeSession?.workspacePath
  const threadId = activeSession?.threadId
  const preferSubscription = settings.preferSubscription
  const subagentIds = activeSession?.subagentIds

  /** The live sessions and agents, for callbacks that resolve after this render.
   *  Declared here because the transport below is one of them. */
  const sessionsRef = useRef(sessions)
  const agentsRef = useRef(agents)
  useEffect(() => {
    sessionsRef.current = sessions
    agentsRef.current = agents
  }, [sessions, agents])

  /*
   * Past conversations tagged in this message.
   *
   * Tagging a session is a reference, not an address — there is nobody in an old
   * thread to take a turn — so it is collected separately from `addressee`, and
   * every tag counts wherever it sits in the sentence. Resolved on this side
   * because the sidebar is the renderer's; main is handed ids and titles and can
   * look up nothing else about them.
   *
   * A callback rather than part of the transport memo: it has to read the
   * sessions as they are *now*, and the transport is rebuilt only when the
   * route changes — so a session created a minute ago would otherwise not be
   * taggable until something unrelated forced a rebuild.
   */
  const referencedSessions = useCallback(
    (list: UIMessage[]): Array<{ threadId: string; title: string }> => {
      const last = [...list].reverse().find((m) => m.role === 'user')
      if (!last) return []
      const out: Array<{ threadId: string; title: string }> = []
      for (const [, tag] of flattenText(last).matchAll(/@([\w-]+)/g)) {
        const found = sessionsRef.current.find((s) => s.id === tag && s.threadId)
        // Not the one you are in: it is already the conversation.
        if (found?.threadId && found.id !== activeSession?.id) {
          out.push({ threadId: found.threadId, title: found.title })
        }
      }
      return out
    },
    [activeSession?.id]
  )

  const transport = useMemo(() => {
    if (!server || !agent) return undefined

    /** Which backend an agent's own model puts it on. Per agent, because the
     *  subscription only covers Anthropic — see the note above. */
    const routeFor = (a: { model: string }): string =>
      preferSubscription && a.model.startsWith('anthropic/') ? 'agent-sdk/chat' : 'chat'

    /*
     * Who a message is addressed to.
     *
     * `@name` used to reach the session's agent like any other text, and it
     * answered by calling `delegate` — so the tagged agent's words arrived
     * quoted, second-hand, under someone else's name, having been told only
     * what the supervisor chose to pass on. Tagging is not delegation: it means
     * *that* agent takes this turn and answers as itself.
     *
     * Only agents already in the session are addressable; the mention picker
     * adds them on the way in. An unknown tag is left as plain text rather than
     * silently redirected, so a typo reaches the agent you were talking to.
     */
    const inSession = [
      agent,
      ...(subagentIds ?? []).map((id) => agents.find((a) => a.id === id))
    ].filter((a): a is NonNullable<typeof a> => Boolean(a))

    const addressee = (list: UIMessage[]): typeof agent => {
      const last = [...list].reverse().find((m) => m.role === 'user')
      if (!last) return agent
      const id = addressedTag(
        flattenText(last),
        inSession.map((a) => a.id)
      )
      return inSession.find((a) => a.id === id) ?? agent
    }

    // `referencedSessions` reads a ref, and the compiler cannot see that the
    // callback holding it runs at send time rather than during this render —
    // the transport is an object we hand to the SDK, not something rendered.
    // The ref is the point: a session created after the transport was built
    // still has to be taggable.
    // eslint-disable-next-line react-hooks/refs
    return new DefaultChatTransport({
      api: `${server.baseUrl}/${routeFor(agent)}/${agent.id}`,
      /**
       * Three things ride along with every turn that the default body omits.
       *
       * `requestContext.workspacePath` is what lets the Mastra backend resolve a
       * workspace at all — its agent is built once at startup and has no idea
       * which folder this session picked, so without this it runs with no file
       * tools. The Agent SDK backend ignores it and looks the folder up from the
       * persisted session instead.
       *
       * `memory` carries the thread. `Session.threadId` has existed since
       * sessions did and was never actually sent, which is why the Mastra
       * backend started every reply from nothing.
       */
      prepareSendMessagesRequest: ({ body, headers, messages, id }) => {
        // Resolved per turn, not per transport: who answers can change with
        // every message, and rebuilding the Chat to switch would drop the
        // transcript it is holding.
        const to = addressee(messages)
        return {
          api: `${server.baseUrl}/${routeFor(to)}/${to.id}`,
          headers,
          body: {
            ...body,
            id,
            messages,
            ...(folder ? { requestContext: { workspacePath: folder } } : {}),
            ...(() => {
              const refs = referencedSessions(messages)
              return refs.length ? { refs } : {}
            })(),
            // The thread is the session's; every agent in it shares that one.
            // The resource is the agent's own, so their memories stay separate —
            // main decides it from the URL rather than trusting this, but the
            // Mastra route still reads it from here.
            //
            // `thread`/`resource`, not `threadId`/`resourceId`: the Mastra route
            // spreads this straight into `agent.stream()`, whose `AgentMemoryOption`
            // uses those names. Under the old names it saw no thread at all, so
            // memory never came up — and the task-state processor, which requires
            // an active thread, failed every turn with "computeStateSignal
            // requires Mastra memory with an active resourceId and threadId".
            ...(threadId
              ? { memory: { thread: threadId, resource: personalResource(to.id) } }
              : {})
          }
        }
      }
    })
  }, [
    server,
    agent,
    agents,
    subagentIds,
    preferSubscription,
    folder,
    threadId,
    referencedSessions
  ])

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

  /**
   * The chat, held outside React so switching sessions does not abandon a turn.
   *
   * The registry owns the instances; this only names the one this session
   * wants. `transportKey` is what tells the registry a rebuild is warranted —
   * useMemo identity alone would rebuild on every render that touches its
   * dependencies, and a rebuild mid-turn is the loss we are fixing.
   */
  const transportKey = `${server?.baseUrl ?? ''}|${agent?.id ?? ''}|${
    onSubscription ? 'sdk' : 'mastra'
  }|${folder ?? ''}|${threadId ?? ''}`
  const chat = useMemo(
    () =>
      chatFor(activeSession?.id ?? 'no-session', transportKey, () => ({
        transport: transport ?? new DefaultChatTransport({ api: '' }),
        messages: initialMessages
      })),
    // `transport` and `initialMessages` are read through the builder, and both
    // are derived from these — listing them too would defeat the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSession?.id, transportKey]
  )

  const { messages, sendMessage, setMessages, regenerate, stop, status, error, clearError } =
    useChat({ chat })

  /*
   * Finishing is the registry's event now, not the hook's, because a turn can
   * finish while its session is off screen. Saving happens there; this is the
   * part that needs the mounted component.
   *
   * The queue is deliberately not drained on error: after a failure the user
   * should get to see it and decide, rather than have the queue push another
   * turn into whatever just broke. The chips stay put and go out after the next
   * reply.
   */
  /** Assistant messages already acted on, so a re-render or a second finish
   *  event cannot fire the same tag twice. */
  const passedRef = useRef<Set<string>>(new Set())

  /**
   * An agent tagging another hands it the turn.
   *
   * Same rule as the user's own tag — `@name` means that agent answers — so a
   * reply that ends "@helper can you check this?" enqueues exactly one turn for
   * Helper, carrying what was said as its prompt. It goes out as a user-role
   * message because that is the only role the backends read a prompt from, and
   * `metadata.handoff` is what tells the transcript to render it as a handoff
   * rather than as something you typed.
   *
   * Read through refs: this is registered once and would otherwise close over
   * the roster as it stood when the session mounted.
   */
  /** Settings saved before this existed have no value at all — the store merges
   *  shallowly — so the default is applied on read rather than assumed present. */
  const chainLimit = Math.max(
    1,
    Math.round(settings.tagChainLimit ?? DEFAULT_SETTINGS.tagChainLimit)
  )
  const passTheTag = useCallback((sessionId: string) => {
    const chat = chatOf(sessionId)
    const session = sessionsRef.current.find((s) => s.id === sessionId)
    if (!chat || !session) return

    const last = chat.messages[chat.messages.length - 1]
    if (!last || last.role !== 'assistant' || isFailure(last)) return
    if (!last.id || passedRef.current.has(last.id)) return

    const roster = [session.agentId, ...session.subagentIds]
    const from = speakerId(last) ?? session.agentId
    const to = addressedTag(flattenText(last), roster, from)
    if (!to) return

    passedRef.current.add(last.id)
    const depth = (handoffOf(chat.messages[chat.messages.length - 2])?.depth ?? 0) + 1

    // The cap is announced, not silent. A chain that simply stops looks exactly
    // like an agent that had nothing more to say, and the difference matters:
    // one is finished, the other was cut off mid-thought.
    if (depth > chainLimit) {
      chat.messages = [
        ...chat.messages,
        {
          id: `mochi-chain-${last.id}`,
          role: 'assistant',
          metadata: { chainStopped: { from, to, limit: chainLimit } },
          parts: []
        }
      ]
      // Written by hand: the registry saves on finish, and this lands after it.
      saveMessages(sessionId, chat.messages)
      return
    }

    /*
     * The tag leads, so the existing routing carries it, and the sentence after
     * says who is calling.
     *
     * Main strips an agent's own tag before the model sees it, so `@to` alone
     * arrived as a bare quote from nobody — the first agent to receive one
     * replied "Tag didn't render on your end", which is a fair complaint about
     * being handed a line with no speaker attached.
     */
    const fromName = agentsRef.current.find((a) => a.id === from)?.name ?? from
    void chat.sendMessage({
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `@${to} ${fromName} tagged you here and said:\n\n${flattenText(last)}`
        }
      ],
      metadata: { handoff: { from, to, depth } }
    })
  }, [chainLimit])

  useEffect(() => {
    onChatFinish((sessionId) => {
      devlog.push('chat', 'turn finished')
      // Tell the user the work is done if they have looked away. Main owns the
      // focus test — the overlay is a non-focusable window and cannot tell
      // "backgrounded" from "I am the overlay". A no-op when Mochi is in front.
      void window.mochi?.agentFinished(finishLineRef.current)
      // Agents passing the turn between themselves runs for every session, not
      // only the visible one: a chain that halts because you looked elsewhere
      // would be a stranger bug than one that runs on.
      passTheTag(sessionId)
      // Only this session's queue, and only while it is the one on screen — the
      // chips belong to the conversation you are looking at.
      if (sessionId === activeSession?.id) drainQueue()
    })
    return () => onChatFinish(null)
  }, [activeSession?.id, drainQueue, passTheTag])

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

  // Start the registry's periodic save whenever a turn begins, from any send
  // path. Watching `busy` rather than wrapping each call site means a turn
  // started by the queue, a retry or the mascot is covered the same way.
  useEffect(() => {
    if (busy) noteActivity()
  }, [busy])

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
      // And every session still working off screen. `liveRef` only ever holds
      // the one being rendered, so without this a background turn interrupted
      // by the window closing was lost with nothing written at all.
      flushAllChats()
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

  /** Sessions whose title has already been asked for, so a re-render cannot
   *  fire a second request. A ref rather than state precisely because writing
   *  state here is what broke this — see below. */
  const titleAsked = useRef<Set<string>>(new Set())
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

    /*
     * The guard is a ref, and the flag is written on arrival rather than before
     * the request.
     *
     * It used to set `autoTitled` first, to stop a re-render firing a second
     * request. But `autoTitled` is one of this effect's own dependencies, so
     * that write re-ran the effect, whose cleanup set `cancelled` — and the
     * title that came back was discarded by the very guard meant to protect it.
     * Sessions ended up flagged as titled while keeping the first thing you
     * typed, which is exactly what the sidebar was showing.
     */
    const sessionId = activeSession.id
    if (titleAsked.current.has(sessionId)) return
    titleAsked.current.add(sessionId)

    void fetch(`${server.baseUrl}/agent-sdk/title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body })
    })
      .then((r) => r.json() as Promise<{ title: string | null }>)
      .then(({ title }) => {
        if (!title) return
        // Applied by id against the latest sessions, not the array captured
        // when the request went out — a reply can land after you have moved on,
        // and it must rename the session it was about rather than the one you
        // are looking at.
        dispatch({
          type: 'sessions',
          sessions: sessionsRef.current.map((s) =>
            s.id === sessionId ? { ...s, title, autoTitled: true } : s
          )
        })
      })
      .catch(() => {
        // Let it be asked again next time rather than leaving the session
        // permanently stuck with whatever the user typed.
        titleAsked.current.delete(sessionId)
      })
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
   * Change the mode.
   *
   * Persisted first, because the persisted session is what the next turn reads
   * — the POST is only what makes a *running* turn switch too. Doing it the
   * other way round would leave a turn switched and the store disagreeing if
   * the write failed.
   */
  const setMode = (mode: PermissionMode, classifierModel?: string): void => {
    if (!activeSession) return
    dispatch({
      type: 'sessions',
      sessions: sessions.map((s) =>
        s.id === activeSession.id
          ? { ...s, mode, autoClassifierModel: mode === 'auto' ? classifierModel : undefined }
          : s
      )
    })
    if (!server) return
    void fetch(`${server.baseUrl}/agent-sdk/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeSession.id, mode })
    }).catch(() => {
      // No live run, or the run ended. The stored mode still applies next turn.
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
    // Only an agent joins the session. A tagged conversation is something to
    // read, not a participant — adding its id here would put a session in the
    // roster and let the router try to hand it a turn.
    const isAgent = agents.some((a) => a.id === id)
    if (isAgent && !activeSession.subagentIds.includes(id)) {
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

  /*
   * What `@` can reach: the other agents, and your past conversations.
   *
   * Two different acts behind one gesture, and the rows say which is which.
   * Tagging an agent gives it the turn. Tagging a session gives the agent that
   * conversation to read — there is nobody in an old thread to answer, so it is
   * a reference, and the row is labelled "read" rather than looking like
   * another participant.
   *
   * Sessions come after agents and are capped: the sidebar can hold hundreds,
   * and a picker you have to scroll is one you stop using. Typing narrows them,
   * which is how you reach the older ones.
   */
  const matches = (...fields: string[]): boolean =>
    !mentionQuery || fields.some((f) => f.toLowerCase().includes(mentionQuery.toLowerCase()))

  const mentionable: Array<{
    kind: 'agent' | 'session'
    id: string
    label: string
    hint: string
    initial: string
  }> = [
    ...agents
      .filter((a) => a.id !== agent.id && matches(a.id, a.name))
      .map((a) => ({
        kind: 'agent' as const,
        id: a.id,
        label: `@${a.id}`,
        hint: a.description,
        initial: a.name[0]
      })),
    ...sessions
      .filter(
        (s) => s.id !== activeSession.id && s.threadId && !s.archived && matches(s.title, s.id)
      )
      .slice(0, mentionQuery ? 6 : 4)
      .map((s) => ({
        kind: 'session' as const,
        id: s.id,
        label: s.title,
        hint: `earlier conversation with ${agentById(s.agentId)?.name ?? s.agentId}`,
        initial: '⏱'
      }))
  ]

  /**
   * The highlighted row, clamped rather than reset.
   *
   * A filter that narrows the list can leave the stored index past its end.
   * Resetting it would need an effect, and every hook here sits above an early
   * return — so the value is corrected where it is read instead, which is also
   * one less render.
   */
  const activeMention = Math.min(mentionIndex, Math.max(0, mentionable.length - 1))

  /**
   * Who said message `index`.
   *
   * The subscription route stamps the agent on the message, which is the answer
   * whenever it is there. Mastra's `chatRoute` has no hook for writing metadata,
   * and nothing written before that existed carries any — so the fallback reads
   * it off the question instead: the turn went to whoever the user tagged, and
   * to the session's own agent when nobody was.
   */
  const speakerAt = (index: number): string => {
    const recorded = messages[index] && speakerId(messages[index])
    if (recorded) return recorded
    for (let i = index; i >= 0; i--) {
      if (messages[i]?.role !== 'user') continue
      return (
        addressedTag(flattenText(messages[i]), [
          activeSession.agentId,
          ...activeSession.subagentIds
        ]) ?? activeSession.agentId
      )
    }
    return activeSession.agentId
  }

  /** Who the message being typed will go to — the same rule the transport uses,
   *  so the composer never promises one agent and send reaches another. */
  const addressed =
    agentById(
      addressedTag(input, [activeSession.agentId, ...activeSession.subagentIds]) ??
        activeSession.agentId
    ) ?? agent

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
    <WidgetHost
      session={activeSession}
      patch={patchSession}
      messages={messages}
      agent={agent}
      subagents={subagents.filter((s): s is NonNullable<typeof s> => Boolean(s))}
      subArt={art}
      rules={rules}
      stickerSrc={stickerSrc}
      onAddAgent={() => dispatch({ type: 'toggle', key: 'mentionOpen', value: true })}
    >
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
          {/* The stack of initials that used to sit here said the same thing as
              "+1 agent" beside the description, one line up, and said it worse:
              two agents sharing a mascot folder gave two identical letters. Who
              is in the room is now answered where it matters, by the name over
              each reply. */}
          <span className="session-spacer" />
          {/* Only once a folder is actually set. An empty strip saying "no
              folder" was permanent furniture in every chat that never needed
              one — the composer's folder button is where you set it, and this
              is only here to say where it points. */}
          {activeSession.workspacePath && (
            <button
              className="chip chip-btn"
              onClick={pickWorkspace}
              title={`${activeSession.workspacePath} — click to change`}
            >
              <FolderTree size={11} strokeWidth={1.9} className="ic-code" />
              <span className="mono repo-path">{activeSession.workspacePath}</span>
            </button>
          )}
          {activeSession.branch && (
            <span className="chip">
              <GitBranch size={11} strokeWidth={1.9} className="ic-code" />
              <span className="mono">{activeSession.branch}</span>
            </span>
          )}
          {/* Model, billing and memory are facts about the session, not
              controls — they never change while you are in it, so three chips
              spending header width on them all the time is a poor trade. Behind
              one icon, still one click away. */}
          <div className="head-info-wrap">
            <button
              className="tb-icon"
              aria-label="Session details"
              aria-expanded={headInfo}
              title="Model, billing and memory"
              onClick={(e) => {
                e.stopPropagation()
                setHeadInfo((v) => !v)
              }}
            >
              <Info size={15} strokeWidth={1.8} />
            </button>
            {headInfo && (
              <div className="head-info" onClick={(e) => e.stopPropagation()}>
                <div className="head-info-row">
                  <span className="meta">Model</span>
                  <span className="mono">{agent.model}</span>
                </div>
                <div className="head-info-row">
                  <span className="meta">Billed via</span>
                  <span className="mono">{onSubscription ? 'subscription' : 'api key'}</span>
                </div>
                <div className="head-info-row">
                  <span className="meta">Memory</span>
                  {/* Said per backend, because they do not share one. Mastra's
                      Memory is what the loadout switches configure, and it only
                      backs the API-key route — reporting "on" here while the
                      Agent SDK keeps its own transcript would credit those
                      switches with something they are not doing. */}
                  <span className="mono">
                    {activeSession.type === 'scratch'
                      ? 'scratch — nothing saved'
                      : onSubscription
                        ? 'kept by the agent sdk'
                        : [
                            agent.workingMemory ? 'working' : null,
                            agent.semanticRecall
                              ? `recall ×${agent.recallTopK ?? DEFAULT_RECALL_TOP_K}`
                              : null
                          ]
                            .filter(Boolean)
                            .join(' + ') || 'off'}
                  </span>
                </div>
                <div className="head-info-note meta">
                  {onSubscription
                    ? 'Running through the Claude Agent SDK on your Claude subscription — no API key involved. It keeps its own history, so the loadout’s memory and recall switches apply to the API-key backend.'
                    : 'Running through Mastra against the Anthropic API — billed per token to your API key.'}
                </div>
              </div>
            )}
          </div>
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
                    // The chat outlives this component now, so a delete has to
                    // reach it too — otherwise a turn keeps running for a
                    // session that no longer exists, and saves itself back.
                    forgetChat(activeSession.id)
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
            /* Where a chain of agents tagging each other was stopped. Shown as
               a line in the transcript rather than nothing at all: a silent stop
               is indistinguishable from an agent with nothing more to say. */
            const stopped = chainStopOf(message)
            if (stopped) {
              return (
                <div key={message.id ?? mi} className="msg-note">
                  <Users size={13} strokeWidth={1.9} />
                  <span>
                    Stopped here. {agentById(stopped.from)?.name ?? stopped.from} tagged{' '}
                    {agentById(stopped.to)?.name ?? stopped.to} after {stopped.limit}{' '}
                    {stopped.limit === 1 ? 'pass' : 'passes'} between agents. Say something to
                    carry on.
                  </span>
                </div>
              )
            }

            /* A turn one agent handed to another renders as nothing at all.
               It is a user-role message, because that is the only role the
               backends read a prompt from, but you did not type it — and a
               line announcing "Helper tagged Fraux" only repeats what the tag
               in the reply above and the name over the reply below already
               say. The names carry it; this was scaffolding. */
            if (message.role === 'user' && handoffOf(message)) return null

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

            /*
             * Who is speaking, and whether to say so.
             *
             * The name is printed when it changes rather than over every reply.
             * A solo session is still the common case, and "Fraux" stamped on
             * each of forty consecutive messages is noise that makes the one
             * time it matters — the message where the speaker actually changed —
             * harder to spot, not easier. A user message in between resets it,
             * so each answer is attributed.
             */
            const whoId = speakerAt(mi)
            const who = agentById(whoId) ?? agent
            const before = messages[mi - 1]
            const spokeBefore =
              before && before.role === 'assistant' && !isFailure(before)
                ? speakerAt(mi - 1)
                : null
            const namePart = message.parts.findIndex((p) => p.type === 'text')

            return (
              <div key={message.id ?? mi} className="msg-group" data-role={message.role}>
                {message.parts.map((part, pi) => {
                  if (part.type === 'text') {
                    // Only the agent's text is markdown. What the user typed is
                    // shown back exactly as typed — reinterpreting it would mean
                    // their asterisks silently disappear.
                    return message.role === 'user' ? (
                      <div key={pi} className="msg-user">
                        {withMentions(part.text)}
                      </div>
                    ) : (
                      <div key={pi} className="msg-agent">
                        <div className="msg-avatar">
                          {art[who.spritePreset] ? (
                            <img
                              className="avatar-art"
                              src={art[who.spritePreset] as string}
                              alt=""
                              draggable={false}
                            />
                          ) : (
                            <span className="agent-initial">{who.name[0]}</span>
                          )}
                        </div>
                        <div className="msg-body">
                          {pi === namePart && whoId !== spokeBefore && (
                            <span className="msg-who">{who.name}</span>
                          )}
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
                    Boolean(
                      t &&
                        ((t.startsWith('tool-') && !isPresentational(t)) ||
                          t === 'data-permission')
                    )

                  // Mochi's own tools stand alone at full size — a sticker is
                  // the mascot speaking, not a step in a job.
                  if (part.type.startsWith('tool-') && isPresentational(part.type)) {
                    return <ToolPart key={pi} part={part as unknown as ToolUIPart} />
                  }

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

                    // Grouped only when there is genuinely more than one tool.
                    // A single call plus its approval was still being wrapped,
                    // so a lone PowerShell command rendered as a group heading
                    // saying "PowerShell · 1 step" above a row saying
                    // "PowerShell" — a summary of one thing, restating it.
                    const toolCount = run.filter((p) => p.type.startsWith('tool-')).length
                    if (toolCount > 1 && server) {
                      return (
                        <ToolGroup
                          key={pi}
                          parts={run}
                          baseUrl={server.baseUrl}
                          staleApprovals={staleApprovals}
                          settledApprovals={settledApprovals}
                        />
                      )
                    }

                    // Ungrouped, but still the whole run: the loop skipped every
                    // part after the first, so rendering only `part` here would
                    // drop the approval that came with it.
                    return (
                      <React.Fragment key={pi}>
                        {run.map((p, ri) => {
                          if (p.type === 'data-permission') {
                            const req = (p as unknown as { data: PermissionRequest }).data
                            return server ? (
                              <PermissionCard
                                key={req?.id ?? ri}
                                request={req}
                                baseUrl={server.baseUrl}
                                agentName={agent.name}
                                stale={staleApprovals.has(req?.id) || settledApprovals.includes(req?.id)}
                              />
                            ) : null
                          }
                          const tp = p as ToolUIPart
                          return <ToolPart key={tp.toolCallId ?? ri} part={tp} />
                        })}
                      </React.Fragment>
                    )
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

          {/* `messages.length` is the index the reply *will* take, so this
              resolves the same way the message itself will once it arrives —
              no chance of the waiting line naming one agent and the answer
              landing under another. */}
          <Thinking
            messages={messages}
            status={status}
            who={agentById(speakerAt(messages.length))?.name}
          />
        </div>

        {mentionOpen && (
          <div className="mention-pop">
            <div className="mention-head">
              Tag an agent, or a past conversation
              {mentionQuery ? <span className="mono"> · @{mentionQuery}</span> : null}
            </div>
            {mentionable.length === 0 && (
              <div className="mention-empty meta">Nothing matches that.</div>
            )}
            {mentionable.map((row, i) => {
              const inSession =
                row.kind === 'agent' && activeSession.subagentIds.includes(row.id)
              return (
                <button
                  key={`${row.kind}-${row.id}`}
                  className="mention-row"
                  data-in={inSession}
                  data-active={i === activeMention}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => addMention(row.id)}
                >
                  <span className="mention-avatar">{row.initial}</span>
                  <span className="mention-text">
                    <span className="mention-name">{row.label}</span>
                    <span className="meta">{row.hint}</span>
                  </span>
                  {inSession && <span className="chip">in session</span>}
                  {row.kind === 'session' && <span className="chip">read</span>}
                </button>
              )
            })}
            <div className="mention-foot">
              Tagging an agent hands it the next turn. Tagging a conversation gives{' '}
              {agent.name} the relevant parts of it to read.
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
                    ? `${agentById(speakerAt(messages.length))?.name ?? agent.name} is working — your message will be queued…`
                    : `Message ${addressed.name}…`
              }
              onChange={onInputChange}
              onKeyDown={(e) => {
                /*
                 * 1–4 select a mode, but only in an empty composer.
                 *
                 * Without that guard the shortcut eats a digit out of every message that
                 * starts with one — "1. first thing" would silently switch to Manual and
                 * lose the character. An empty box is unambiguous: there is nothing there
                 * a digit could belong to.
                 */
                if (
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !e.altKey &&
                  e.currentTarget.value === '' &&
                  /^[1-4]$/.test(e.key)
                ) {
                  e.preventDefault()
                  setMode(PERMISSION_MODES[Number(e.key) - 1])
                  return
                }
                // While the picker is filtering a typed `@name`, Enter takes the
                // top match instead of sending a half-written mention.
                if (e.key === 'Escape' && mentionOpen) {
                  setMentionQuery(null)
                  dispatch({ type: 'toggle', key: 'mentionOpen', value: false })
                  return
                }
                /*
                 * Arrow keys move through the list, Enter takes what is
                 * highlighted.
                 *
                 * Enter used to take `mentionable[0]` unconditionally, so the
                 * picker could show six agents and only the first was reachable
                 * from the keyboard — everything else needed the mouse.
                 */
                if (mentionOpen && mentionable.length > 0) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const step = e.key === 'ArrowDown' ? 1 : -1
                    // Wraps, so holding one arrow reaches everything without
                    // having to know which end of the list you are at.
                    setMentionIndex(
                      () => (activeMention + step + mentionable.length) % mentionable.length
                    )
                    return
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addMention((mentionable[activeMention] ?? mentionable[0]).id)
                    return
                  }
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
              <ModePicker
                mode={coerceMode(activeSession?.mode)}
                backend={
                  preferSubscription && agent?.model.startsWith('anthropic/')
                    ? 'subscription'
                    : 'mastra'
                }
                models={subscriptionModels}
                currentModelId={agent?.model ?? ''}
                classifierModel={activeSession?.autoClassifierModel}
                onChange={setMode}
              />
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
    </WidgetHost>
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
