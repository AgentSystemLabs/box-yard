import type { TaskStatus } from "../../../shared/types"
import { cx } from "./ui"

/** Titles keep their normal text color, except failed tasks; the task icon says when work is running. */
export function TaskRowTitle({ title, status }: { title: string; status: TaskStatus | null }) {
  return <span data-task-row-title className={cx("col-start-2 row-start-1 min-w-0 truncate", status === "failed" && "task-title-failed")}>{title}</span>
}
