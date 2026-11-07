// Side threads: a question about a highlighted passage in the Coordinator chat or a Captain's chat, answered in a
// panel on the right (server/sideThreads.ts). This keeps their queries, the live events that update them, and which thread each chat has open.
import { useCallback, useSyncExternalStore } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { appendDraft } from "./composerDraft"
import { keys, newClientId, upsert } from "./queries"
import { toast } from "./toast"
import type { SideThread, SideThreadKind, SideThreadMessage, UiEvent } from "../../../shared/types"
import type { RerouteTarget } from "../../../shared/threadRoutes"

/** Which chat a thread hangs off: "coordinator", or the project id of a Captain's chat. */
export type ThreadChat = string
export const COORDINATOR_CHAT: ThreadChat = "coordinator"
export const chatOf = (projectId: string | null): ThreadChat => projectId ?? COORDINATOR_CHAT
const projectOf = (chat: ThreadChat) => (chat === COORDINATOR_CHAT ? null : chat)

export const threadKeys = {
  list: (chat: ThreadChat) => ["threads", chat] as const,
  messages: (id: string) => ["thread-messages", id] as const,
  stream: (id: string) => ["thread-stream", id] as const,
}

const NONE: SideThread[] = []

export function useThreads(chat: ThreadChat) {
  const projectId = projectOf(chat)
  return useQuery({
    queryKey: threadKeys.list(chat),
    queryFn: () => api<SideThread[]>(`/api/threads${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
    staleTime: Infinity,
  })
}

/** The threads on one message; a message row re-renders only when its own threads change. */
export function useMessageThreads(chat: ThreadChat, anchorId: string): SideThread[] {
  const q = useQuery({
    queryKey: threadKeys.list(chat),
    queryFn: () => api<SideThread[]>(`/api/threads${projectOf(chat) ? `?projectId=${encodeURIComponent(chat)}` : ""}`),
    staleTime: Infinity,
    select: (list: SideThread[]) => list.filter((t) => t.anchorId === anchorId),
  })
  return q.data ?? NONE
}

export function useThread(chat: ThreadChat, id: string | null): SideThread | null {
  const q = useThreads(chat)
  return (id && q.data?.find((t) => t.id === id)) || null
}

/** `enabled` false: a draft reply thread, which has no messages on the server yet. */
export function useThreadMessages(id: string, enabled = true) {
  return useQuery({ queryKey: threadKeys.messages(id), queryFn: () => api<SideThreadMessage[]>(`/api/threads/${id}/messages`), staleTime: Infinity, enabled })
}

export function useThreadStream(id: string) {
  return useQuery({ queryKey: threadKeys.stream(id), queryFn: () => "", initialData: "", staleTime: Infinity })
}

const patch = (qc: QueryClient, chat: ThreadChat, id: string, change: (t: SideThread) => Partial<SideThread>) =>
  qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => list?.map((t) => (t.id === id ? { ...t, ...change(t) } : t)))

const pendingMessage = (threadId: string, id: string, content: string): SideThreadMessage => ({ id, threadId, role: "user", content, meta: { pending: true }, createdAt: Date.now() })

/**
 * Start a thread on a message with its first message, and open it: a question about a highlighted passage, or (kind
 * "reply") a reply to the whole message, whose quote is the message. `reveal` false: the caller shows the thread
 * itself (a task's side questions in its panel), so the chat's side panel stays as it is.
 */
export function useAskThread(chat: ThreadChat, { reveal = true }: { reveal?: boolean } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; messageId: string; anchorId: string; quote: string; question: string; kind?: SideThreadKind }) =>
      api<{ thread: SideThread; message: SideThreadMessage }>("/api/threads", {
        body: { ...input, quote: input.kind === "reply" ? undefined : input.quote, projectId: projectOf(chat) },
      }),
    onMutate: (input) => {
      const now = Date.now()
      const thread: SideThread = {
        id: input.id,
        projectId: projectOf(chat),
        anchorId: input.anchorId,
        kind: input.kind ?? "ask",
        quote: input.quote.trim(),
        context: null,
        busy: true,
        replies: 1,
        unread: false,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => upsert(list ?? [], thread))
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(input.id), [pendingMessage(input.id, input.messageId, input.question.trim())])
      if (reveal) openThread(chat, input.id)
    },
    onError: (err: Error, input) => {
      qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => list?.filter((t) => t.id !== input.id))
      qc.removeQueries({ queryKey: threadKeys.messages(input.id) })
      if (openThreadId(chat) === input.id) closeThread(chat)
      toast.error("Couldn't ask", err.message)
    },
    onSuccess: ({ thread, message }, input) => {
      // A reply to a message that already had a reply thread went to that one.
      if (thread.id !== input.id) {
        dropThread(qc, chat, input.id)
        if (openThreadId(chat) === input.id) openThread(chat, thread.id)
        qc.removeQueries({ queryKey: threadKeys.messages(thread.id) })
      } else qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(thread.id), (list) => upsert(list ?? [], message))
      qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => upsert(list ?? [], thread))
    },
  })
}

export function useSendThreadMessage(chat: ThreadChat, id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; content: string }) => api<SideThreadMessage>(`/api/threads/${id}/messages`, { body: input }),
    onMutate: (input) => {
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(id), (list) => upsert(list ?? [], pendingMessage(id, input.id, input.content)))
      // Busy, and a new message reopens a resolved thread.
      patch(qc, chat, id, (t) => ({ busy: true, resolvedAt: null, replies: t.replies + 1 }))
    },
    onError: (err: Error, input) => {
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(id), (list) => list?.filter((m) => m.id !== input.id))
      toast.error("Couldn't send", err.message)
    },
    onSuccess: (message) => qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(id), (list) => upsert(list ?? [], message)),
  })
}

export const newThreadIds = () => ({ id: newClientId("thr"), messageId: newClientId("thm") })

/**
 * A task's side thread (kind "task", one per task, anchored on its id): Cody's questions to the Coordinator about the
 * task, answered from the task as it stands. The task's agent never sees them. Null until the first question.
 */
export function useTaskThread(taskId: string): SideThread | null {
  const q = useQuery({
    queryKey: threadKeys.list(COORDINATOR_CHAT),
    queryFn: () => api<SideThread[]>("/api/threads"),
    staleTime: Infinity,
    select: (list: SideThread[]) => list.find((t) => t.kind === "task" && t.anchorId === taskId) ?? null,
  })
  return q.data ?? null
}

/** Ask the Coordinator about a task: the first question starts its side thread, the next ones go on in it. */
export function useAskAboutTask(taskId: string, title: string) {
  const thread = useTaskThread(taskId)
  const start = useAskThread(COORDINATOR_CHAT, { reveal: false })
  const send = useSendThreadMessage(COORDINATOR_CHAT, thread?.id ?? "")
  const threadId = thread?.id ?? null
  return useCallback(
    (question: string) =>
      threadId
        ? send.mutateAsync({ id: newClientId("thm"), content: question })
        : start.mutateAsync({ ...newThreadIds(), anchorId: taskId, quote: title, question, kind: "task" }),
    [threadId, taskId, title, send.mutateAsync, start.mutateAsync],
  )
}

export function useThreadControl(chat: ThreadChat) {
  const qc = useQueryClient()
  return {
    /** Resolve (fold it away under its message and close it) or reopen. */
    resolve: async (id: string, resolved: boolean) => {
      const before = qc.getQueryData<SideThread[]>(threadKeys.list(chat))?.find((t) => t.id === id)
      patch(qc, chat, id, () => ({ resolvedAt: resolved ? Date.now() : null }))
      if (resolved && openThreadId(chat) === id) closeThread(chat)
      try {
        const thread = await api<SideThread>(`/api/threads/${id}/resolve`, { body: { resolved } })
        qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => (list ? upsert(list, thread) : list))
      } catch (err) {
        if (before) patch(qc, chat, id, () => ({ resolvedAt: before.resolvedAt }))
        toast.error(resolved ? "Couldn't resolve the thread" : "Couldn't reopen the thread", (err as Error).message)
      }
    },
    /** The thread is open: its answers are read. */
    seen: (id: string) => {
      patch(qc, chat, id, () => ({ unread: false }))
      void api(`/api/threads/${id}/seen`, { body: {} }).catch(() => {})
    },
    stop: (id: string) => void api(`/api/threads/${id}/stop`, { body: {} }).catch((err: Error) => toast.error("Couldn't stop", err.message)),
    remove: async (id: string) => {
      try {
        await api(`/api/threads/${id}`, { method: "DELETE" })
        if (openThreadId(chat) === id) closeThread(chat)
        dropThread(qc, chat, id)
      } catch (err) {
        toast.error("Couldn't delete the thread", (err as Error).message)
      }
    },
  }
}

function dropThread(qc: QueryClient, chat: ThreadChat, id: string) {
  qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => list?.filter((t) => t.id !== id))
  qc.removeQueries({ queryKey: threadKeys.messages(id) })
  qc.removeQueries({ queryKey: threadKeys.stream(id) })
}

/** Live events (lib/stream.ts). Returns false for an event that isn't a thread's. */
export function applyThreadEvent(qc: QueryClient, ev: UiEvent): boolean {
  switch (ev.type) {
    case "thread":
      qc.setQueryData<SideThread[]>(threadKeys.list(chatOf(ev.thread.projectId)), (list) => (list ? upsert(list, ev.thread) : list))
      if (!ev.thread.busy) qc.setQueryData(threadKeys.stream(ev.thread.id), "")
      return true
    case "thread.message":
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(ev.message.threadId), (list) => (list ? upsert(list, ev.message) : list))
      if (ev.message.role !== "user") qc.setQueryData(threadKeys.stream(ev.message.threadId), "")
      return true
    case "thread.delta":
      qc.setQueryData<string>(threadKeys.stream(ev.threadId), (prev) => (prev ?? "") + ev.text)
      return true
    case "thread.deleted":
      if (openThreadId(chatOf(ev.projectId)) === ev.threadId) closeThread(chatOf(ev.projectId))
      dropThread(qc, chatOf(ev.projectId), ev.threadId)
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------- the open thread, per chat

/**
 * A chat's open thread. `draft`: a reply thread not started yet (Reply on a message with no replies): the panel shows
 * the message and a composer, and the first reply creates the thread with this id. `expanded`: the panel covers the
 * whole chat.
 */
export interface OpenThread {
  id: string
  draft?: { anchorId: string; text: string }
  expanded?: boolean
  /**
   * Opened from Reply or "Reply quoting selection": a new number puts the caret in the box, after anything in it (the
   * quote), once. Showing the panel again (another chat and back, a question restored) leaves the focus where it is.
   */
  focus?: number
}

/** The draft store's key for a thread's box (lib/composerDraft.ts). */
export const threadDraftKey = (id: string) => `thread:${id}`

let open = new Map<ThreadChat, OpenThread>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const set = (chat: ThreadChat, value: OpenThread | null) => {
  const next = new Map(open)
  if (value) next.set(chat, value)
  else next.delete(chat)
  open = next
  emit()
}

export const openThreadId = (chat: ThreadChat) => open.get(chat)?.id ?? null
/** What a chat's panel shows, to put it back later (App: a question that gave way to pinned panels). */
export const openThreadState = (chat: ThreadChat) => open.get(chat) ?? null
export const restoreThread = (chat: ThreadChat, value: OpenThread) => set(chat, value)
export const openThread = (chat: ThreadChat, id: string) => set(chat, { id, expanded: open.get(chat)?.expanded })
let replies = 0

/**
 * Reply to a message: open its reply thread, or a draft of one when it has none yet, with the caret in its box (each
 * press, one already open too). `quote`: a passage of it (the selection's "Reply quoting"), which the composer starts with.
 */
export function openReply(qc: QueryClient, chat: ThreadChat, anchorId: string, text: string, quote?: string) {
  const existing = qc.getQueryData<SideThread[]>(threadKeys.list(chat))?.find((t) => t.kind === "reply" && t.anchorId === anchorId)
  const cur = open.get(chat)
  const drafted = !existing && cur?.draft?.anchorId === anchorId ? cur : null
  const id = existing?.id ?? drafted?.id ?? newClientId("thr")
  // The quote goes into the draft here, not when the panel mounts, so a panel shown again doesn't add it twice.
  if (quote) appendDraft(threadDraftKey(id), quote)
  set(chat, { id, ...(!existing && { draft: drafted?.draft ?? { anchorId, text } }), expanded: cur?.expanded, focus: ++replies })
}

/** A message of the chat's, in full, from what's loaded (the Coordinator's chat, or a Captain's). */
export function chatMessageText(qc: QueryClient, chat: ThreadChat, id: string): string | null {
  const list = qc.getQueryData<{ id: string; content: string }[]>(chat === COORDINATOR_CHAT ? keys.chat : keys.captainMessages(chat))
  return list?.find((m) => m.id === id)?.content ?? null
}

/**
 * Send one of Cody's messages in a reply thread the other way (shared/threadRoutes.ts): to the task's agent, into the
 * main chat, or back to be answered here. The live stream brings its new route; this shows it at once too.
 */
export function useRerouteThreadMessage(chat: ThreadChat, threadId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { messageId: string; to: RerouteTarget }) => api<SideThreadMessage>(`/api/threads/${threadId}/messages/${input.messageId}/route`, { body: { to: input.to } }),
    onSuccess: (message, input) => {
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(threadId), (list) => upsert(list ?? [], message))
      if (input.to === "thread") patch(qc, chat, threadId, () => ({ busy: true }))
    },
    onError: (err: Error, input) => toast.error(input.to === "thread" ? "Couldn't ask it here" : input.to === "agent" ? "Couldn't send it to the agent" : "Couldn't send it to the chat", err.message),
  })
}
/** The open thread covers the whole chat, or goes back beside it. */
export const toggleExpanded = (chat: ThreadChat) => {
  const cur = open.get(chat)
  if (cur) set(chat, { ...cur, expanded: !cur.expanded })
}
/** Close the panel: it's gone at once, with no slide out. */
export const closeThread = (chat: ThreadChat) => {
  if (open.has(chat)) set(chat, null)
}

export function useOpenThread(chat: ThreadChat): OpenThread | null {
  return useSyncExternalStore(
    subscribe,
    () => open.get(chat) ?? null,
    () => null,
  )
}

/** Whether a chat has a thread open: the Coordinator's dock makes room for it. */
export function useThreadShown(chat: ThreadChat): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open.has(chat),
    () => false,
  )
}
