import { taskSessionHref } from "./navigation"
export const REVEAL_CHAT_EVENT = "box-yard:reveal-chat"

type ChatRevealOptions = { scope: string; highlight?: boolean; target?: "message" | "day"; fallbackId?: string }
export type ChatReveal = string | ({ id: string } & ChatRevealOptions)

/** Render and reveal an older message. A scope targets one chat history's day rail. */
export function revealChatMessage(id: string, options?: ChatRevealOptions) {
  window.dispatchEvent(new CustomEvent<ChatReveal>(REVEAL_CHAT_EVENT, { detail: options ? { id, ...options } : id }))
}

export const REVEAL_QUEUE_EVENT = "box-yard:reveal-queue"
/** The task page's Queued rows: /tasks/:id#queue scrolls to them. */
export const QUEUE_HASH = "#queue"

/** Open a task's queued messages: go to its page and scroll to the Queued rows. */
export function revealTaskQueue(taskId: string, navigate: (to: string) => void) {
  navigate(`${taskSessionHref(taskId)}${QUEUE_HASH}`)
  // A task page that is already open scrolls on the event; one that mounts reads the hash.
  window.dispatchEvent(new CustomEvent(REVEAL_QUEUE_EVENT, { detail: taskId }))
}
