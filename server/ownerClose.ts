import type { Attachment, CaptainMessage, ChatMessage, Task, TaskMessage } from "../shared/types.js"
import type { Hub } from "./hub.js"
import type { Store } from "./store.js"
import type { TaskManager } from "./tasks.js"
import { errorMessage } from "./util/retry.js"

/** A deliberately bounded whole-message command, never a search through prose, quotes or attachments. */
export function ownerCloseTarget(content: string): string | null {
  if (/[\r\n]/.test(content.trim())) return null
  const text = content.trim().replace(/[.!?]$/, "").replace(/,? please$/i, "").trim()
  const command = text.replace(/^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/i, "")
  const close = /^close\s+(.+)$/i.exec(command)
  const mark = /^mark\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed)$/i.exec(command)
  return (close?.[1] ?? mark?.[1])?.trim() ?? null
}

export type OwnerCloseChat =
  | { kind: "coordinator"; projectId?: string }
  | { kind: "captain"; projectId: string }
  | { kind: "task"; taskId: string; projectId: string }

const HELP = 'Name one task by its full task_… ID or unique exact title (for example, close task_abc123 or mark "Fix login" as done). In its own task chat, you can say "close this task".'

/** Exact lookup only. In particular, never use Store.findTask's fuzzy/most-recent fallback for an owner action. */
export function resolveOwnerClose(store: Pick<Store, "getTask" | "listTasks">, target: string, chat: OwnerCloseChat): Task | string {
  if (/^this task$/i.test(target)) {
    if (chat.kind !== "task") return HELP
    target = chat.taskId
  }
  const ref = target.replace(/^(?:the\s+)?(?:(?:failed|superseded)\s+)?task\s+(?:(?:titled|named|called)\s+)?/i, "")
  const quoted = /^(?:"([^"]+)"|'([^']+)'|“([^”]+)”|`([^`]+)`)$/u.exec(ref)
  const name = quoted ? quoted.slice(1).find((s) => s !== undefined)! : ref
  if (!quoted && /^(?:(?:this|that|the|all|these|those|latest|last|failed|superseded)\b|it$|them$)/i.test(name)) return HELP
  const candidates = /^task_[A-Za-z0-9-]{6,40}$/.test(name)
    ? [store.getTask(name)].filter((t): t is Task => Boolean(t))
    : store.listTasks({ projectId: chat.projectId }).filter((t) => t.title.toLowerCase() === name.toLowerCase())
  if (candidates.length !== 1) return candidates.length ? `That title identifies more than one task. ${HELP}` : `No exact task match. ${HELP}`
  const task = candidates[0]!
  if (chat.projectId && task.projectId !== chat.projectId) return "Out of scope: this chat can only mark tasks in its own project done."
  if (chat.kind === "task" && task.id !== chat.taskId) return "A task chat can only mark its own task done. Send the request directly to the Captain or Coordinator for another task."
  return task
}

/**
 * Called ONLY by the three authenticated owner chat POST routes, before queueing an agent turn. This is the authority
 * boundary: source labels, queued edits, forwarded messages, hooks, schedules and MCP calls must never invoke it.
 * No capability or approval string is exposed to a model, persisted for reuse, or inferred from chat history.
 */
export async function closeFromOwnerChat(
  deps: { store: Store; tasks: Pick<TaskManager, "closeTask">; hub: Pick<Hub, "broadcast">; authenticatedOwner: boolean },
  chat: OwnerCloseChat,
  content: string,
  options: { id?: string; attachments?: Attachment[] } = {},
): Promise<ChatMessage | CaptainMessage | TaskMessage | null> {
  const target = ownerCloseTarget(content)
  if (!target) return null
  const { store, tasks, hub } = deps
  const meta = { ownerAction: "close_task", ...(options.attachments?.length ? { attachments: options.attachments } : {}) }
  const add = (role: "user" | "assistant", text: string) => {
    // Results carry only title/id/state: even status-only Coordinator chats must not acquire task content here.
    if (chat.kind === "task") {
      const message = store.addTaskMessage(chat.taskId, role === "assistant" ? "event" : role, text, meta)
      hub.broadcast({ type: "task.message", message })
      return message
    }
    if (chat.kind === "captain") {
      const message = store.addCaptainMessage(chat.projectId, role, text, { ...meta, source: "cody" }, role === "user" ? options.id : undefined)
      hub.broadcast({ type: "captain.message", message })
      return message
    }
    const message = store.addChat(role, text, meta, role === "user" ? options.id : undefined)
    hub.broadcast({ type: "chat.message", message })
    return message
  }
  // Persist the owner request first, also rejecting duplicate client message IDs before any side effect.
  const message = add("user", content)
  const task = resolveOwnerClose(store, target, chat)
  let result: string
  if (!deps.authenticatedOwner) result = "Chat closing requires configured owner sign-in. Use Mark done, or configure sign-in and send this request again."
  else if (typeof task === "string") result = task
  else if (task.status === "done") result = `Task "${task.title}" (${task.id}) is already done.`
  else {
    try {
      await tasks.closeTask(task.id)
      result = `Marked task "${task.title}" (${task.id}) done. Its sub-tasks close with it. Use Reopen to pick it back up.`
    } catch (err) {
      // Do not serialize arbitrary manager/provider errors into a status-only chat.
      console.warn(`[box-yard] owner chat close ${task.id}: ${errorMessage(err)}`)
      result = `Could not finish marking task ${task.id} done. Check its current state before retrying.`
    }
  }
  add("assistant", result)
  // Task routes return the task, not this message; the other routes return their usual user-chat message shape.
  return message
}
