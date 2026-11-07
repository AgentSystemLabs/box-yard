// Sidebar deletion follows the existing DELETE APIs. Keep queued/running work out of this shortcut, including
// descendants of a task and the Captain of a project. Recheck after the confirmation: live state may have changed.
import type { Task } from "../../../shared/types"

export type SidebarDeleteTarget = { kind: "task" | "project"; id: string; name: string; projectId: string }

export function sidebarDeleteTasks(target: SidebarDeleteTarget, tasks: readonly Task[]): Task[] {
  if (target.kind === "project") return tasks.filter((t) => t.projectId === target.id)
  const ids = new Set([target.id])
  // Use the complete list, including done/hidden children, without depending on its sort order or nesting depth.
  let added = true
  while (added) {
    added = false
    for (const t of tasks) if (t.parentTaskId && ids.has(t.parentTaskId) && !ids.has(t.id)) {
      ids.add(t.id)
      added = true
    }
  }
  return tasks.filter((t) => ids.has(t.id))
}

export function sidebarDeleteBlocked(target: SidebarDeleteTarget, tasks: readonly Task[], captainBusy: boolean): string | null {
  if (target.kind === "project" && captainBusy) return "Stop the Captain before deleting this project."
  const failed = target.kind === "task" && tasks.some((t) => t.id === target.id && t.status === "failed")
  if (sidebarDeleteTasks(target, tasks).some((t) => ["queued", "starting", "working"].includes(t.status) || t.turnStartedAt != null || t.compacting || t.compactPending || (t.pendingCount > 0 && !(failed && t.status === "failed")))) {
    return "Stop queued or running tasks before deleting."
  }
  return null
}

/** Failed launches retain their inputs. Deleting them needs explicit consent, rather than treating them as running. */
export function sidebarDeleteQueued(target: SidebarDeleteTarget, tasks: readonly Task[]): number {
  if (target.kind !== "task" || !tasks.some((t) => t.id === target.id && t.status === "failed")) return 0
  return sidebarDeleteTasks(target, tasks).reduce((n, t) => n + (t.status === "failed" ? t.pendingCount || 0 : 0), 0)
}
