// A box's action buttons (BoxActionDialog): why they're disabled right now, and what the box holds.
import { TASK_STATUSES, type BoxInfo, type TaskStatus } from "../../../shared/types"

/** Tasks on a box grouped by status, in the usual status order, for the Clear/Delete confirmations. */
export function statusCounts(tasks: { status: TaskStatus }[]): { status: TaskStatus; count: number }[] {
  return TASK_STATUSES.map((status) => ({ status, count: tasks.filter((t) => t.status === status).length })).filter((s) => s.count > 0)
}

/** Why a box's Clean up / Clear / Resize / Delete buttons are disabled right now, or null when they aren't. */
export function boxBusyReason(box: Pick<BoxInfo, "operation" | "cleanup">): string | null {
  const op = box.operation ?? (box.cleanup?.status === "running" ? (box.cleanup.reason === "clear" ? "clear" : "cleanup") : null)
  if (op === "cleanup") return "A disk cleanup is running on this box"
  if (op === "clear") return "This box is being cleared"
  if (op === "delete") return "This box is being deleted"
  if (op === "resize") return "This box is being resized"
  if (op === "snapshot") return "A project snapshot is being taken of this box"
  return null
}
