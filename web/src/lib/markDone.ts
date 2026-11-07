// One "Mark done" for every place that offers it (the task header's ⓘ, a card's ✓, the card panel's ✓): the task is
// done at once, with an Undo toast, and its close goes out when the undo window is over (useMarkTasksDone). Closing a
// running or queued task also stops its agent, so that asks first.
import { useCallback } from "react"
import type { Task } from "../../../shared/types"
import { confirmDialog, type ConfirmRequest } from "./confirm"
import { useMarkTasksDone } from "./queries"

type Markable = Pick<Task, "id" | "title" | "status">

/** Its agent is at work (or about to be): Mark done stops it. */
export const stopsWhenDone = (t: Pick<Task, "status">) => t.status === "working" || t.status === "starting" || t.status === "queued"

/** What Mark done asks before it stops a task's agent. */
export const stopAndMarkDone = (t: Markable): ConfirmRequest => ({
  title: "Stop it and mark it done?",
  body: `${t.title} is ${t.status === "queued" ? "queued" : "running"}. Mark done stops it and closes it.`,
  confirmLabel: "Stop and mark done",
  danger: true,
})

/** Mark a task done: resolves false when Cody said no to stopping it. */
export function useMarkDone(): (task: Markable) => Promise<boolean> {
  const mark = useMarkTasksDone()
  return useCallback(
    async (task) => {
      if (stopsWhenDone(task) && !(await confirmDialog(stopAndMarkDone(task)))) return false
      mark([task])
      return true
    },
    [mark],
  )
}
