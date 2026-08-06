# Missing replies after switching/closing a session — root cause

## Symptom
Send a message, immediately switch session or close the window -> returning to that
session shows user messages with no assistant replies.

## Root cause (confirmed by reading code, not inferred)

Transcripts are persisted by exactly ONE effect, `src/renderer/src/screens/Session.tsx:78-81`:

    useEffect(() => {
      if (status === 'streaming' || status === 'submitted') return
      saveMessages(activeSession?.id, messages)
    }, [messages, status, activeSession?.id])

It (a) writes nothing while a turn is in flight, and (b) reads `messages` from the
*current* useChat instance.

`@ai-sdk/react@4.0.51` dist/index.js:322-327:

    const shouldRecreateChat = ... || ("id" in options && options.id != null
                                       && chatRef.current.id !== options.id)
    if (shouldRecreateChat) { chatRef.current = new Chat(chatOptions) }

Changing the id CONSTRUCTS A NEW Chat and drops the old one. There is no instance
registry and no cache. Verified: the only useEffect in useChat is the `resume` one —
no unmount cleanup, no abort on id change (grep over dist/index.js:273-420).

Therefore an in-flight turn is:
  - never written (the effect early-returned for the whole stream), AND
  - unwritable afterwards (the component no longer holds that Chat)
=> the user message AND the reply are lost irrecoverably, not merely unpersisted.

Window close is the same failure, simpler cause: there is NO beforeunload /
pagehide / visibilitychange handler anywhere in src/renderer (grep confirms none),
so nothing flushes on teardown.

## Secondary finding — explains the exact screenshot
The guard does NOT early-return on `status === 'error'`. An errored turn therefore
IS persisted, as a transcript containing the user's message with no reply — and it
overwrites the previously-good stored transcript. The reported screenshot (assistant
greeting, then two user turns, zero replies) is consistent with turns that errored.

So there are two distinct defects:
  D1 in-flight turns are discarded on session switch / window close
  D2 an errored turn overwrites good history with a reply-less transcript

## Not yet established
Why the turns errored in the first place (D2's trigger). Needs the app's error surfaced —
which is itself an argument for the requested debug logger.
