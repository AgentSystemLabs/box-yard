import { Trash2 } from "lucide-react"
import type { Task } from "../../../shared/types"
import { useRestingDelete } from "../lib/restingDelete"
import { HEADER_CHIP, HEADER_FOLD, cx } from "./ui"

/** Explicit failed-task action in desktop rows and the header; touch rows use the swipe menu. */
export function DeleteFailedTaskButton({ task, header = false }: { task: Task; header?: boolean }) {
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
        header
          ? cx(HEADER_CHIP, HEADER_FOLD.chip, "border border-red-500/30 bg-red-500/5")
          : "mr-0.5 grid h-8 w-8 place-items-center self-center rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zinc-100 pointer-coarse:hidden",
      )}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void remove()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Trash2 className={cx("h-4 w-4", header && HEADER_FOLD.icon)} aria-hidden />
      {header && <span className={HEADER_FOLD.label}>{pending ? "Deleting…" : "Delete"}</span>}
    </button>
  )
}
