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

/** True while a session that isn't on screen is still working. */
export function isChatBusy(sessionId: string): boolean {
  const status = live.get(sessionId)?.chat.status
  return status === 'streaming' || status === 'submitted'
}
