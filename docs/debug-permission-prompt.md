# The permission prompt never appears — root cause

Backlog item 11. Investigated 2026-08-04. Verdict: **never wired**, not broken.
No code has been changed for this yet; the fix shape is at the end.

---

## Symptom

The agent says something like "a prompt should appear asking if you want to
allow me to write to that file location" and nothing surfaces. The turn then
stalls with no visible reason.

## Root cause — three things stacked

**1. There is no permission handler at all.**

The Claude Agent SDK's hook for this is `canUseTool`, described in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1376-1380` as:

> Custom permission handler for controlling tool usage. Called before each tool
> execution to determine if it should be allowed, denied, or prompt the user.

`canUseTool` appears **nowhere** in `src/`. Neither does `permissionMode`
(`sdk.d.ts:2092`, defaults to `'default'`). So when the SDK needs a decision it
has no one to ask, and the request has nowhere to go. The agent's line about a
prompt is it describing what normally happens in Claude Code, not something
Mochi ever registered for.

**2. `allowedTools` is being used as if it were a restriction list.**

`src/main/agent-sdk-route.ts:467-473` passes exactly five entries:

```ts
allowedTools: [
  `${TOOL_PREFIX}sendSticker`,
  `${TOOL_PREFIX}setMascotState`,
  `${TOOL_PREFIX}askUser`,
  `${TOOL_PREFIX}delegate`,
  `${TOOL_PREFIX}searchDocs`
],
```

But `sdk.d.ts:1368-1375` is explicit about what that option means:

> These tools will execute automatically **without asking the user for
> approval**. To restrict which tools are available, use the `tools` option
> instead.

So this is an **auto-approve** list, not an allowlist. Its actual effect is that
the five Mochi tools run unprompted — which is the intent — while `Read`,
`Write`, `Edit` and `Bash` are still very much available to the model and fall
through to the normal permission path. Which, per (1), is a dead end.

**3. Any attempt is invisible anyway.**

`src/main/agent-sdk-route.ts:499-503` drops every tool call whose name does not
start with `TOOL_PREFIX`:

```ts
} else if (block.type === 'tool_use' && block.id) {
  if (!(block.name ?? '').startsWith(TOOL_PREFIX)) {
    suppressed.add(block.id)
    continue
  }
```

That is deliberate — it exists to hide the harness's own plumbing tools — but it
also means a `Write` call produces no tool card. Combined with (1), the user
sees the agent go quiet with nothing to click and nothing to read.

## Why this reads as "writes hang"

Nothing hangs in the sense of a deadlocked promise the app owns. The SDK is
waiting on a decision that can never arrive, the renderer was never told a
decision was needed, and the tool card that would have shown the attempt was
filtered out. Three separate reasons for the same silence.

## Fix shape

Not built yet, and deliberately so: the approval UI is the same UI backlog item
17 needs for "an agent wants to bring in another agent", and both should be
designed once. See `docs/mastra-docs-inventory.md` §3 for the Mastra-route
equivalents.

The round trip has to cross the process boundary, because `canUseTool` runs in
the Electron main process and the answer comes from the renderer. The message
stream is one-directional, so the response needs its own channel:

1. `canUseTool` parks a promise in a map keyed by a request id and returns it.
2. The route writes a custom data part to the UI message stream carrying the id,
   tool name and input.
3. The renderer renders an approval card and the user chooses.
4. The renderer POSTs to a new `/agent-sdk/permission` route (or goes over IPC)
   with `{ id, behavior }`.
5. Main resolves the parked promise with a `PermissionResult` — `{behavior:
   'allow'}` or `{behavior: 'deny', message}` (`sdk.d.ts:2114`).

Worth knowing while designing it:

- `PermissionResult` also carries `updatedPermissions`, and `PermissionUpdate`
  supports `addRules` / `setMode` (`sdk.d.ts:2128+`). That is the native way to
  build "always allow edits in this folder" without inventing our own store.
- `@ai-sdk/react`'s `useChat` already exposes `addToolApprovalResponse`, and
  `ToolPart.tsx` already maps `approval-requested` / `approval-responded` in
  `TOOL_STATE_LABEL`. The wire format is understood by the renderer; nothing
  currently emits it. Using it would be cheaper than a bespoke data part.
- Suppression at `:499-503` must learn to distinguish "harness plumbing" from
  "a real file tool the user should see", or approved writes stay invisible.
- A timeout matters. A parked promise with no answer is a stalled turn, which is
  the bug we are fixing.
