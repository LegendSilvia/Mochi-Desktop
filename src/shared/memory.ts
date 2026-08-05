/**
 * Who a piece of memory belongs to.
 *
 * Mastra groups threads, messages and semantic recall under a *resource* id, and
 * working memory hangs off one directly. Mochi has exactly one kind, and that is
 * deliberate: the resource names the agent, so what Fraux has learned about you
 * is not what Helper has learned.
 *
 * Sharing a conversation between agents does *not* mean sharing a resource. The
 * thread is what they have in common — same `threadId`, one transcript — and
 * Mastra keys messages and thread-scoped recall on that, not on the resource. A
 * shared resource would instead merge two agents' private notes about you and
 * file each one's replies under the other's name, which is the bug `2141ba4`
 * fixed. See `recallContext` for how the shared half is actually read.
 *
 * These strings are foreign keys into LibSQL rows that already exist on disk, so
 * changing the format orphans every session that used the old one. They live
 * here rather than at each call site because they used to be spelled out by hand
 * in the renderer and again in the IPC layer — one typo apart from silent loss.
 */

const PERSONAL = 'mochi-user'

/** The agent's own memory, across every conversation it has had. */
export function personalResource(agentId: string): string {
  return `${PERSONAL}:${agentId}`
}
