import { Chat } from '@ai-sdk/react'
import type { ChatTransport, UIMessage } from 'ai'
import { saveMessages } from './history'

/**
 * The chats, kept alive across session switches.
 *
 * `useChat` throws its `Chat` away and builds a new one whenever the `id` it is
 * given changes:
 *
 *     const shouldRecreateChat = ... || chatRef.current.id !== options.id
 *     if (shouldRecreateChat) chatRef.current = new Chat(chatOptions)
 *
 * Nothing aborts. The old instance keeps reading its stream to the end, so a
 * turn you walked away from still runs, still spends the window, still fires
 * its tools — and then delivers the answer into an object no one holds a
 * reference to any more. It is collected unseen, and because the save effect
 * only ever writes the *active* session, nothing reaches disk either. Switching
 * away mid-thought lost the reply outright.
 *
 * Holding the instances here means the orphan is not an orphan: come back and
 * the finished answer is waiting, and each chat saves itself on finish so the
 * reply survives even if you never come back at all.
 */

interface Entry {
  chat: Chat<UIMessage>
  /** Identity of the transport this chat was built with — see `chatFor`. */
  key: string
}

const live = new Map<string, Entry>()

type FinishFn = (sessionId: string) => void
let notify: FinishFn | null = null

/** The mounted session registers here so a finished turn can still drain its
 *  queue and raise a notification. Called for background sessions too, which is
 *  the case that most wants announcing. */
export function onChatFinish(fn: FinishFn | null): void {
  notify = fn
}

/**
 * The chat for a session, created once and reused.
 *
 * `key` describes the transport: which agent, which backend, which folder,
 * which thread. A change means later turns must go somewhere else, so the chat
 * is rebuilt — carrying its messages over, since the conversation did not end
 * just because its destination moved.
 *
 * Never mid-stream, though. Replacing a streaming chat would drop the reply on
 * the floor, which is the exact bug this file exists to fix.
 */
export function chatFor(
  sessionId: string,
  key: string,
  build: () => { transport: ChatTransport<UIMessage>; messages: UIMessage[] }
): Chat<UIMessage> {
  const existing = live.get(sessionId)
  if (existing) {
    const streaming = existing.chat.status === 'streaming' || existing.chat.status === 'submitted'
    if (existing.key === key || streaming) return existing.chat
  }

  const built = build()
  const chat: Chat<UIMessage> = new Chat<UIMessage>({
    id: sessionId,
    transport: built.transport,
    messages: existing ? existing.chat.messages : built.messages,
    onFinish: () => {
      // Only if this is still the session's chat. A rebuilt session leaves the
      // old instance holding a closure over the same id, and letting a
      // superseded chat finish would write its outdated messages over the newer
      // ones — losing a reply by saving, which is a worse bug than not saving.
      if (live.get(sessionId)?.chat !== chat) return
      // Written here rather than left to the component's effect, which only
      // ever sees whichever session is on screen.
      saveMessages(sessionId, chat.messages)
      notify?.(sessionId)
    }
  })
  live.set(sessionId, { chat, key })
  return chat
}

/** Drop a deleted session's chat. Without this the map is a leak that also
 *  resurrects a conversation the user asked to be rid of. */
export function forgetChat(sessionId: string): void {
  live.get(sessionId)?.chat.stop()
  live.delete(sessionId)
}

/**
 * Write every live chat to disk, including the ones off screen.
 *
 * The component's own flush can only save the session it is rendering, and a
 * background chat is only saved when it *finishes* — so closing the window
 * while a turn ran in another session lost that reply outright, which is the
 * same loss as the one this file was written for, arriving by a different door.
 *
 * Partial text is worth keeping: the process is about to die and take the turn
 * with it, so half an answer is strictly better than a question with none.
 */
export function flushAllChats(): void {
  for (const [sessionId, entry] of live) saveMessages(sessionId, entry.chat.messages)
}

/**
 * How often a still-streaming chat is written while nobody is watching it.
 *
 * Matches the foreground throttle, so a background turn is no more exposed than
 * the one on screen.
 */
const SWEEP_MS = 700

let sweep: ReturnType<typeof setInterval> | null = null

/**
 * Save streaming chats as they go, not only when they end.
 *
 * The unload flush covers closing the window, and `onFinish` covers a turn that
 * completes — between them sits the case neither catches: the app being killed
 * rather than closed. A crash, Task Manager, or the power going out runs no
 * handler at all, so a long reply that had been streaming for a minute was lost
 * whole.
 *
 * Only runs while something is actually streaming, and stops itself when
 * nothing is, so an idle Mochi does no periodic work.
 */
export function noteActivity(): void {
  ensureSweeping()
}

function ensureSweeping(): void {
  if (sweep) return
  sweep = setInterval(() => {
    let busy = false
    for (const [sessionId, entry] of live) {
      const status = entry.chat.status
      if (status !== 'streaming' && status !== 'submitted') continue
      busy = true
      saveMessages(sessionId, entry.chat.messages)
    }
    if (!busy && sweep) {
      clearInterval(sweep)
      sweep = null
    }
  }, SWEEP_MS)
}

/** True while a session that isn't on screen is still working. */
export function isChatBusy(sessionId: string): boolean {
  const status = live.get(sessionId)?.chat.status
  return status === 'streaming' || status === 'submitted'
}
