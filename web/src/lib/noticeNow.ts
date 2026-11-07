// What a task's question, pull request or failure card in the Coordinator's transcript says now
// (components/NoticeNow.tsx): read from the task as it stands, not from when the notice came in. Only the task's newest
// such card can ask for anything, so one card per task ever does; an older one, or one whose task has moved on, says
// where the task is now and goes quiet. The rules are pure, so they're unit tested.
import { createContext, useContext, useMemo, useRef } from "react"
import type { Task } from "../../../shared/types"
import { noticeKind, type NoticeKind } from "./captainTranscript"
import { badgeStatus, prStateOf, type BadgeStatus } from "./prState"
import type { CoordinatorRow } from "./chatUpdates"

/** The notices that can wait on Cody: a question to answer, a pull request to review, a failure to retry. */
export type AskKind = "needs_input" | "pr" | "failed"
const ASK_KINDS: ReadonlySet<NoticeKind> = new Set<AskKind>(["needs_input", "pr", "failed"])
export const isAskKind = (kind: NoticeKind): kind is AskKind => ASK_KINDS.has(kind)

/** What a task needs for its card to ask for anything. */
export type NoticeTask = Pick<Task, "status" | "prUrl" | "prState">

export type NoticeNow =
  /** It waits on Cody: the status word, and the card's one action. */
  | { live: true; kind: AskKind; label: string }
  /** Moved on (answered, retried, merged) or a newer card took over: where the task is now. */
  | { live: false; status: BadgeStatus }

/** The status word a live card leads with. */
export const LIVE_LABEL: Record<AskKind, string> = {
  needs_input: "Needs your answer",
  pr: "Ready for your review",
  failed: "Failed",
}

/** Whether `task` still waits on Cody for what a `kind` notice said. */
function waits(kind: AskKind, task: NoticeTask): boolean {
  if (kind === "needs_input") return task.status === "needs_input"
  if (kind === "failed") return task.status === "failed"
  const pr = prStateOf(task)
  return task.status === "pr_ready" && (pr === "open" || pr === "draft")
}

/**
 * A `kind` notice's card, for `task` as it stands. `newest`: it's the task's newest question, PR or failure in the
 * transcript. Null when there's nothing to say: another kind of notice, or a task the app doesn't know (deleted, or
 * not loaded yet), whose card stays as it came in.
 */
export function noticeNow(kind: NoticeKind, task: NoticeTask | null | undefined, newest: boolean): NoticeNow | null {
  if (!isAskKind(kind) || !task) return null
  if (newest && waits(kind, task)) return { live: true, kind, label: LIVE_LABEL[kind] }
  return { live: false, status: badgeStatus(task) }
}

/** Each task's newest question, PR or failure notice in `rows`, by task id. */
export function newestAsks(rows: readonly CoordinatorRow[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.type !== "message" || r.message.role !== "notice") continue
    const m = r.message
    const taskId = m.meta?.taskId
    if (typeof taskId === "string" && m.meta?.captain !== true && isAskKind(noticeKind(m.content, m.meta))) out.set(taskId, m.id)
  }
  return out
}

const sameMap = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

/**
 * newestAsks over the transcript's rows, the same object while it says the same, so the cards that read it re-render
 * only when a task's newest card changes, not on every row that streams in.
 */
export function useNewestAsks(rows: readonly CoordinatorRow[]): ReadonlyMap<string, string> {
  const last = useRef<ReadonlyMap<string, string> | null>(null)
  return useMemo(() => {
    const next = newestAsks(rows)
    if (last.current && sameMap(last.current, next)) return last.current
    return (last.current = next)
  }, [rows])
}

/** The transcript's newestAsks (CoordinatorTranscript provides it). Null elsewhere: those cards say nothing new. */
export const NewestAsks = createContext<ReadonlyMap<string, string> | null>(null)

/** Whether message `id` is its task's newest question, PR or failure, or null outside the transcript. */
export function useIsNewestAsk(taskId: string | null, id: string): boolean | null {
  const newest = useContext(NewestAsks)
  if (!newest || !taskId) return null
  return newest.get(taskId) === id
}
