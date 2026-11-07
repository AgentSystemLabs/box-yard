import type { Task } from "./types.js"

/**
 * A task update on /api/stream for a connection that was already sent the task whole (server/hub.ts): only the fields
 * that changed since the last update, and the ones it no longer has. Only clients that opened the stream with
 * `?patches=1` (the web app) get these; the rest keep getting `{ type: "task", task }` every time.
 */
export interface TaskPatchEvent {
  type: "task.patch"
  id: string
  patch: Partial<Task>
  unset?: (keyof Task)[]
}

/** The task as a whole `task` event would have sent it: `base` (the stream's last copy) with the patch on top. */
export function applyTaskPatch(base: Task, ev: TaskPatchEvent): Task {
  const task: Partial<Task> = { ...base, ...ev.patch }
  for (const key of ev.unset ?? []) delete task[key]
  return task as Task
}
