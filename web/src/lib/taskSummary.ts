// The text line under a task card's title: the agent's summary, else what it is doing right now, else the gist of the prompt.
import { activityLine } from "../../../shared/activity"
import type { Task, TaskMessage } from "../../../shared/types"

/**
 * The task list with a task's `activity` moved on by one transcript message (live, between task events).
 * Returns the same list when nothing changes, so unrelated renders are skipped.
 */
export function withActivity(list: Task[] | undefined, message: TaskMessage): Task[] | undefined {
  if (!list || (message.role !== "assistant" && message.role !== "tool")) return list
  const i = list.findIndex((t) => t.id === message.taskId)
  const task = list[i]
  if (!task || task.summary !== null) return list
  const line = activityLine(message.role, message.content, message.meta)
  if (!line || line === task.activity) return list
  const next = list.slice()
  next[i] = { ...task, activity: line }
  return next
}
