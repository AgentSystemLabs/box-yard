import { Trash2 } from "lucide-react"
import type { Task } from "../../../shared/types"
import { useRestingDelete } from "../lib/restingDelete"
import { HEADER_CHIP, HEADER_FOLD, cx } from "./ui"

/** Failed-task header action; confirmation and queued-input consent are shared with other deletion surfaces. */
export function DeleteFailedTaskButton({ task, className }: { task: Task; className?: string }) {
  const { pending, remove } = useRestingDelete({ kind: "task", id: task.id, name: task.title, projectId: task.projectId })
  return (
    <button
      type="button"
      data-delete-task
      data-testid="delete-failed-task"
      aria-label={`Delete ${task.title}`}
      aria-haspopup="dialog"
      title={`Delete task: ${task.title}…`}
      disabled={pending}
      className={cx(
        "shrink-0 text-red-300 hover:bg-red-500/10 hover:text-red-200 disabled:cursor-wait disabled:opacity-50",
        HEADER_CHIP, HEADER_FOLD.chip, "border border-red-500/30 bg-red-500/5", className,
      )}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void remove()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Trash2 className={cx("h-4 w-4", HEADER_FOLD.icon)} aria-hidden />
      <span className={HEADER_FOLD.label}>{pending ? "Deleting…" : "Delete"}</span>
    </button>
  )
}
