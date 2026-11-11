// In-app replacement for window.confirm(): `await confirmDialog({...})` resolves true/false.
// One request shows at a time; <ConfirmHost> (mounted once in App) renders it with the shared Modal.
import { useSyncExternalStore } from "react"
import type { Task } from "../../../shared/types"

/** A task a confirm lists: drawn with its state's icon (TaskStatusIcon) and its title. */
export type ConfirmTask = Pick<Task, "id" | "title" | "icon" | "projectId" | "status">

export interface ConfirmRequest {
  title: string
  body?: string
  /** The confirm button's label, e.g. "Delete project". */
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button for destructive actions. */
  danger?: boolean
  /** Cancel has the focus as it opens, so Enter keeps things as they are: for one that stops work under way. */
  cancelFocus?: boolean
  /** The tasks it reaches, listed under the body: a few (`shown`), and how many more aren't (`more`). */
  tasks?: { shown: readonly ConfirmTask[]; more: number }
}

interface Pending extends ConfirmRequest {
  id: number
  resolve: (ok: boolean) => void
}

let queue: Pending[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...request, id: nextId++, resolve }]
    emit()
  })
}

/** Answers the request on screen and shows the next one, if any. */
export function settleConfirm(id: number, ok: boolean) {
  const item = queue.find((q) => q.id === id)
  if (!item) return
  queue = queue.filter((q) => q !== item)
  item.resolve(ok)
  emit()
}

export function currentConfirm(): Pending | undefined {
  return queue[0]
}

export function useCurrentConfirm() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    currentConfirm,
  )
}
