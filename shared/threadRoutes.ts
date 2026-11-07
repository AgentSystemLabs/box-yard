// Where a reply thread sent each of Cody's messages (server/sideThreads.ts). The chat's own agent (the Coordinator,
// or the project's Captain) reads each message in the thread's turn and either answers it there, has Box Yard send it
// to the task's agent word for word, or posts it in the main chat, where it can act. The decision is kept on the
// message (SideThreadMessage.meta) so the thread shows it as a chip, and Cody can send it the other way with one tap.

/**
 * "thread": answered in the thread. "agent": sent to the task's agent. "chat": posted in the main chat (the
 * Coordinator's, or the Captain's). "failed": the turn that should have routed it hit an error.
 */
export type ThreadRoute = "thread" | "agent" | "chat" | "failed"

export interface ThreadRouteInfo {
  route: ThreadRoute
  /** "router": the Coordinator or Captain decided. "cody": Cody re-routed it. */
  by: "router" | "cody"
  /** The task it went to (route "agent"). */
  taskId: string | null
  /** The task's queued message it became, so a re-route can take it back before the agent reads it. */
  inputId: string | null
  /** The main chat's message it became (route "chat"). */
  chatMessageId: string | null
  /** A forward Cody took back before the agent (or the chat) read it. */
  recalled: boolean
  /** Asked here instead, but the agent (or the chat) had already read it. */
  delivered: boolean
}

/** The route a thread message carries, or null (a message from before routing, or one still being routed). */
export function routeOf(meta: Record<string, unknown> | null | undefined): ThreadRouteInfo | null {
  const route = meta?.route
  if (route !== "thread" && route !== "agent" && route !== "chat" && route !== "failed") return null
  const str = (v: unknown) => (typeof v === "string" && v ? v : null)
  return {
    route,
    by: meta?.routedBy === "cody" ? "cody" : "router",
    taskId: str(meta?.routeTaskId),
    inputId: str(meta?.routeInputId),
    chatMessageId: str(meta?.routeChatMessageId),
    recalled: meta?.routeRecalled === true,
    delivered: meta?.routeDelivered === true,
  }
}

/** The meta keys for a route, merged over the message's other meta. */
export function routeMeta(info: Partial<ThreadRouteInfo> & { route: ThreadRoute }): Record<string, unknown> {
  return {
    route: info.route,
    routedBy: info.by ?? "router",
    routeTaskId: info.taskId ?? null,
    routeInputId: info.inputId ?? null,
    routeChatMessageId: info.chatMessageId ?? null,
    routeRecalled: info.recalled ?? false,
    routeDelivered: info.delivered ?? false,
  }
}

/** Where Cody can send a message from a reply thread with one tap (POST /api/threads/:id/messages/:messageId/route). */
export type RerouteTarget = "thread" | "agent" | "chat"

/** The directive a routing turn answers with instead of an answer: `[[route:agent]]` or `[[route:chat]]`. */
const DIRECTIVE = /\[\[\s*route\s*:\s*(agent|chat)\s*\]\]/i

/** A routing turn's reply: the route it asked for (null: it answered), and what's left of the text without it. */
export function parseRouteDirective(text: string): { route: "agent" | "chat" | null; rest: string } {
  const m = DIRECTIVE.exec(text)
  if (!m) return { route: null, rest: text }
  return { route: m[1]!.toLowerCase() as "agent" | "chat", rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() }
}

/**
 * Whether streamed text so far may still turn out to be a directive: a routing turn holds its live text back while it
 * might, so the thread never flashes `[[route:agent]]`.
 */
export function mayBeDirective(text: string): boolean {
  const t = text.trimStart().toLowerCase().replace(/\s+/g, "")
  if (!t) return true
  const head = "[[route:"
  return t.length < head.length ? head.startsWith(t) : t.startsWith(head)
}
