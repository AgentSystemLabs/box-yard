// A task always stores input in its queue first. That transport detail needn't turn an idle send into
// a queued card: keep its normal transcript line until delivery, unless the server reports a real wait.
import type { QueryClient } from "@tanstack/react-query"
import type { QueuedMessage, Task, TaskMessage } from "../../../shared/types"
import { keys } from "./queries"
import { placeMessage } from "./queued"

export const submissionId = (m: TaskMessage): string => typeof m.meta?.clientMessageId === "string" ? m.meta.clientMessageId : m.id
export const taskMustWait = (t: Task | undefined): boolean => !t || t.status === "working" || t.status === "starting" || Boolean(t.waitReason || t.compacting || t.compactPending)

/** Preserve the optimistic row's React key, including identical rapid sends: never match by text. */
export function placeTaskMessage(list: TaskMessage[], message: TaskMessage): TaskMessage[] {
  const id = submissionId(message)
  const pending = list.find((m) => m.meta?.pending && submissionId(m) === id)
  return placeMessage(pending ? list.map((m) => m === pending ? { ...m, id: message.id } : m) : list, message)
}

/** Delivery events precede the working task event, so any still-pending input waits for another turn. */
export function taskSubmissionWait(qc: QueryClient, task: Task) {
  if (task.status !== "working" && !task.waitReason && !task.compacting && !task.compactPending) return
  // Its queue row already exists. Drop the provisional line rather than retaining a hidden pending
  // copy after an edit/cancel; forwarding to the Captain has a separate lifecycle and stays put.
  qc.setQueryData<TaskMessage[]>(keys.taskMessages(task.id), (list) => list?.filter((m) => !m.meta?.pending || !m.meta.clientMessageId))
}

/** Queue fetches can race a POST or delivery. Keep only still-unconfirmed local rows, once each. */
export function reconcileTaskQueue(qc: QueryClient, taskId: string, rows: QueuedMessage[]): QueuedMessage[] {
  const messages = qc.getQueryData<TaskMessage[]>(keys.taskMessages(taskId)) ?? []
  const delivered = new Set(messages.filter((m) => !m.meta?.pending && !m.meta?.steerAccepted).map(submissionId))
  const fresh = rows.filter((m) => !m.clientMessageId || !delivered.has(m.clientMessageId))
  const known = new Set(fresh.map((m) => m.clientMessageId))
  const pending = qc.getQueryData<QueuedMessage[]>(keys.taskQueue(taskId))?.filter((m) => m.id.startsWith("tmp-") && !known.has(m.clientMessageId) && !delivered.has(m.clientMessageId ?? "")) ?? []
  return [...fresh, ...pending]
}
