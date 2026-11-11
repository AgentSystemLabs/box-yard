import { settleConfirm, useCurrentConfirm, type ConfirmRequest } from "../lib/confirm"
import { Modal } from "./Modal"
import { TaskStatusIcon } from "./TaskIcon"
import { Button, STATUS } from "./ui"

/** Mounted once in the app: shows whatever confirmDialog() is waiting on. */
export function ConfirmHost() {
  const req = useCurrentConfirm()
  if (!req) return null
  const answer = (ok: boolean) => settleConfirm(req.id, ok)
  return (
    <Modal
      key={req.id}
      size="sm"
      title={req.title}
      onClose={() => answer(false)}
      onSubmit={(e) => {
        e.preventDefault()
        answer(true)
      }}
      // The question is the whole dialog: on a narrow phone it wraps rather than losing its end.
      className="[&>header_h2]:whitespace-normal"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={() => answer(false)} autoFocus={req.cancelFocus}>
            {req.cancelLabel ?? "Cancel"}
          </Button>
          <Button type="submit" variant={req.danger ? "danger" : "primary"} autoFocus={!req.cancelFocus}>
            {req.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      {req.body && <p className="text-sm text-zinc-400">{req.body}</p>}
      {req.tasks && <ConfirmTasks tasks={req.tasks} />}
    </Modal>
  )
}

/** The tasks a confirm reaches, one a line: its state's icon and its title, cut to the line; then how many more. */
function ConfirmTasks({ tasks: { shown, more } }: { tasks: NonNullable<ConfirmRequest["tasks"]> }) {
  return (
    <ul data-testid="confirm-tasks" className="space-y-1.5 text-sm text-zinc-200">
      {shown.map((t) => (
        <li key={t.id} className="flex min-w-0 items-center gap-2">
          <TaskStatusIcon task={t} size="sm" label={STATUS[t.status].label} />
          <span className="min-w-0 truncate" title={t.title}>
            {t.title}
          </span>
        </li>
      ))}
      {more > 0 && <li className="pl-6 text-xs text-zinc-500">and {more} more</li>}
    </ul>
  )
}
