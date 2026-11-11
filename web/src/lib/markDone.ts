// One "Mark done" for every place that offers it (the task header's chip and ⓘ, a sidebar row's ✓): the task is done
// at once, with an Undo toast, and its close goes out when the undo window is over (useMarkTasksDone). The server
// closes its sub-tasks with it, at any depth, stopping the ones that run (TaskManager.closeTask). So when its own agent
// or any sub-task's is at work (or about to be), it asks first, naming them, with Cancel in the focus.
import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Task } from "../../../shared/types"
import { confirmDialog, type ConfirmRequest, type ConfirmTask } from "./confirm"
import { keys, useMarkTasksDone } from "./queries"

type Markable = Pick<Task, "id" | "title" | "status">
/** What the task list says of a task's place in its tree. */
type TreeTask = ConfirmTask & Pick<Task, "parentTaskId" | "rootTaskId" | "subtaskDepth">

/** Its agent is at work (or about to be): Mark done stops it. */
export const stopsWhenDone = (t: Pick<Task, "status">) => t.status === "working" || t.status === "starting" || t.status === "queued"

/** The most sub-tasks the confirm lists by name: past that, it lists one fewer and says how many more. */
export const LISTED_SUBTASKS = 5

/**
 * The task's sub-tasks, at any depth, that Mark done would stop: nearest first, then in the list's order. A sub-task is
 * under it when its parents lead up to it; one whose chain is cut (a parent the list doesn't have) counts when its tree
 * is the task's own (rootTaskId).
 */
export function runningSubtasks(taskId: string, tasks: readonly TreeTask[]): TreeTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const under = (t: TreeTask): boolean => {
    const seen = new Set<string>()
    for (let parent = t.parentTaskId; parent && !seen.has(parent); parent = byId.get(parent)?.parentTaskId) {
      if (parent === taskId) return true
      seen.add(parent)
      if (!byId.has(parent)) return t.rootTaskId === taskId
    }
    return false
  }
  return tasks
    .filter((t) => t.id !== taskId && stopsWhenDone(t) && under(t))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.subtaskDepth ?? 0) - (b.t.subtaskDepth ?? 0) || a.i - b.i)
    .map(({ t }) => t)
}

/** What Mark done asks before it stops a task's agent. */
export const stopAndMarkDone = (t: Markable): ConfirmRequest => ({
  title: "Stop it and mark it done?",
  body: `${t.title} is ${t.status === "queued" ? "queued" : "running"}. Mark done stops it and closes it.`,
  confirmLabel: "Stop and mark done",
  danger: true,
  cancelFocus: true,
})

/**
 * What Mark done asks first, or null when nothing would be stopped (then it's done at once, its resting sub-tasks with
 * it): how many sub-tasks run and which (a few, then how many more), that they stop, and that every sub-task under it
 * is marked done too.
 */
export function markDoneConfirm(task: Markable, tasks: readonly TreeTask[]): ConfirmRequest | null {
  const running = runningSubtasks(task.id, tasks)
  const self = stopsWhenDone(task)
  if (!running.length) return self ? stopAndMarkDone(task) : null
  const n = running.length
  const kids = n === 1 ? "a sub-task" : `${n} sub-tasks`
  const shown = n > LISTED_SUBTASKS ? running.slice(0, LISTED_SUBTASKS - 1) : running
  return {
    title: self ? "Stop it and its sub-tasks?" : n === 1 ? "Stop its running sub-task?" : `Stop its ${n} running sub-tasks?`,
    body: self
      ? `${task.title} is ${task.status === "queued" ? "queued" : "running"}, and so ${n === 1 ? "is a sub-task" : `are ${n} of its sub-tasks`}. Mark done stops them all, and marks the task and every sub-task under it done.`
      : `${task.title} has ${kids} still running. Mark done stops ${n === 1 ? "it" : "them"}, and marks the task and every sub-task under it done.`,
    tasks: { shown, more: n - shown.length },
    confirmLabel: "Stop and mark done",
    danger: true,
    cancelFocus: true,
  }
}

/** Mark a task done: resolves false when Cody said no to stopping its agent or its sub-tasks'. */
export function useMarkDone(): (task: Markable) => Promise<boolean> {
  const qc = useQueryClient()
  const mark = useMarkTasksDone()
  return useCallback(
    async (task) => {
      // The list as it is at the click, not at the last render: a sub-task that started since counts.
      const ask = markDoneConfirm(task, qc.getQueryData<Task[]>(keys.tasks) ?? [])
      if (ask && !(await confirmDialog(ask))) return false
      mark([task])
      return true
    },
    [qc, mark],
  )
}
