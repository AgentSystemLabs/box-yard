import type { TaskStatus } from "../../../shared/types"
import { cx } from "./ui"

/** One text node: CSS paints the working sweep without timers or per-character elements. */
export function TaskRowTitle({ title, status }: { title: string; status: TaskStatus | null }) {
  return <span data-task-row-title className={cx("col-start-2 row-start-1 min-w-0 truncate", status === "working" && "task-title-working", status === "failed" && "task-title-failed")}>{title}</span>
}
