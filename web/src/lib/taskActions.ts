// Which state's action the task header's details (ⓘ) offer (Stop, Retry), and which tasks show Mark done outside it. Pure,
// so it is unit tested.
import type { TaskStatus } from "../../../shared/types"

export type PrimaryAction = "stop" | "done" | "retry" | null

/** Stop while it runs, Retry when it broke, Mark done otherwise. */
export function primaryAction(status: TaskStatus): PrimaryAction {
  if (status === "working" || status === "starting" || status === "queued") return "stop"
  if (status === "failed") return "retry"
  if (status === "done") return null
  return "done"
}

/**
 * Its agent finished its turn and it waits for Cody's review (idle, or with its PR open): only Cody marks a task done,
 * so the task header and its sidebar row offer Mark done in plain sight, not only in ⓘ.
 */
export const readyForReview = (status: TaskStatus) => status === "idle" || status === "pr_ready"
