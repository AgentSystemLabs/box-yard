// A task this browser stopped reads as stopped in the tasks cache from the click, not when its turn ends. Stopping a
// working turn is a box call or two (find the process, signal it), and the turn only ends when the server next reads
// the box's events: a second or more, while every copy the server sends (the POST's answer, SSE updates, a refetch)
// still says working. Those copies of the stopped turn are held back. The first copy that isn't that turn (it rested,
// or a new turn started) goes through; so does everything after a failed stop, or a stop the turn outlives.
// A turn is told apart by when it started (Task.turnStartedAt): a later copy of a turn that has ended is late too.
import { isFinalPrState, type Task, type TaskStatus } from "../../../shared/types"

/** How long a stop holds its task's copies back: past this the server's word wins again. */
export const STOP_GUARD_MS = 30_000

const running = (status: TaskStatus) => status === "working" || status === "starting"

/**
 * Stops on their way or waiting for their turn to end: the stopped turn's start (null: before its ledger row), when
 * Stop was clicked, and whether a server copy has said the turn ended.
 */
const stopping = new Map<string, { turnStartedAt: number | null; at: number; ended: boolean }>()

/**
 * The task as Stop leaves it: a running turn rests as its turn end will (PR ready with an open PR, else idle); a
 * queued task as the server settles it at once (idle, or failed when it never ran).
 */
export function stoppedPatch(t: Task): Partial<Task> {
  if (t.status === "queued") return { status: t.turnCount ? "idle" : "failed" }
  if (!running(t.status)) return {}
  return { status: t.prUrl && !isFinalPrState(t.prState) ? "pr_ready" : "idle", turnStartedAt: null }
}

/** Stop was clicked on `task` (as it was before): hold back the server's copies of its running turn. */
export function stopSent(task: Task) {
  if (running(task.status)) stopping.set(task.id, { turnStartedAt: task.turnStartedAt ?? null, at: Date.now(), ended: false })
}

/** The stop failed: the task is whatever the server says again. */
export function stopFailed(taskId: string) {
  stopping.delete(taskId)
}

/** A hold that ran out before any copy said its turn ended (the box never stopped it): ends it, true when it did. */
export function stopExpired(taskId: string): boolean {
  const hold = stopping.get(taskId)
  if (!hold || hold.ended || Date.now() - hold.at < STOP_GUARD_MS) return false
  return stopping.delete(taskId)
}

/** Whether a server copy is still the turn this browser stopped, so the cached (stopped) copy stays. */
export function staleAfterStop(incoming: Task): boolean {
  const hold = stopping.get(incoming.id)
  if (!hold) return false
  if (Date.now() - hold.at >= STOP_GUARD_MS) {
    stopping.delete(incoming.id)
    return false
  }
  const turn = incoming.turnStartedAt ?? null
  if (running(incoming.status)) {
    // The stopped turn: still running there, or ended and this copy is late.
    if (turn === hold.turnStartedAt) return true
    stopping.delete(incoming.id)
    return false
  }
  // It rested: this copy is news, and copies of the turn after it are late. A turn without a start can't be told
  // from the next one, so that hold just ends.
  if (hold.turnStartedAt === null) stopping.delete(incoming.id)
  else hold.ended = true
  return false
}

/** A fetched task list with the tasks this browser stopped kept as cached, where the fetch still has the stopped turn. */
export function keepStopped(list: Task[], cached: readonly Task[] | undefined): Task[] {
  if (!cached || !stopping.size) return list
  let out: Task[] | null = null
  list.forEach((t, i) => {
    if (!staleAfterStop(t)) return
    const mine = cached.find((c) => c.id === t.id)
    if (!mine) return
    out ??= list.slice()
    out[i] = mine
  })
  return out ?? list
}

/** Tests: forget every stop. */
export function resetStoppedTasks() {
  stopping.clear()
}
