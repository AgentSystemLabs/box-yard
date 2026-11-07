// What a collapsed column's strip lists once the sidebar is folded (Rails.tsx): the chat's strip, its Captain's tasks
// (every project's for the Coordinator) and their tree; a task's strip, its sub-tasks. While the sidebar lists them
// itself, a strip is only its name and its expand button.
import { rowMeta, type SidebarGroup, type SidebarRow } from "./sidebar"
import type { Project, Task } from "../../../shared/types"

/** One project's run of tasks on a chat's rail. */
export interface RailGroup {
  projectId: string
  tasks: Task[]
}

/**
 * The chat's rail: the tasks the sidebar lists under its Captain's project, or under every project for the Coordinator,
 * in the sidebar's order. The tasks open in panels (`open`) are always there, even when the sidebar only finds them
 * through search (a done one).
 */
export function chatRailGroups(groups: readonly SidebarGroup[], captain: string | null, open: readonly Task[]): RailGroup[] {
  const out: RailGroup[] = groups.filter((g) => captain === null || g.project.id === captain).map((g) => ({ projectId: g.project.id, tasks: g.rows.map((r) => r.task) }))
  for (const task of open) {
    if (out.some((g) => g.tasks.some((t) => t.id === task.id))) continue
    const home = out.find((g) => g.projectId === task.projectId)
    if (home) home.tasks = [...home.tasks, task]
    else if (captain === null || task.projectId === captain) out.push({ projectId: task.projectId, tasks: [task] })
  }
  return out
}

/** One project in the chat rail's tree: its tasks as the sidebar nests them. */
export interface RailTreeGroup {
  project: Project
  rows: SidebarRow[]
}

const listed = (rows: readonly SidebarRow[], id: string): boolean => rows.some((r) => r.task.id === id || (r.kids !== undefined && listed(r.kids, id)))

/**
 * The chat rail's tree (Rails.tsx RailTree): the projects its rail lists, each task with its sub-tasks nested under
 * it to any depth, as the sidebar draws them. Like the rail, it always has the tasks open in panels (`open`), even when
 * the sidebar doesn't list them (a done one, opened from the palette): a row of their own, last.
 */
export function railTreeGroups(groups: readonly SidebarGroup[], captain: string | null, open: readonly Task[], now: number): RailTreeGroup[] {
  const out = groups.filter((g) => captain === null || g.project.id === captain).map((g) => ({ project: g.project, rows: g.rows }))
  for (const task of open) {
    if (out.some((g) => listed(g.rows, task.id))) continue
    const row: SidebarRow = { task, dim: task.status === "idle" || task.status === "done", meta: rowMeta(task, now) }
    const home = out.find((g) => g.project.id === task.projectId)
    if (home) home.rows = [...home.rows, row]
    else if (captain === null || task.projectId === captain) {
      const project = groups.find((g) => g.project.id === task.projectId)?.project
      if (project) out.push({ project, rows: [row] })
    }
  }
  return out
}

/** A task's rail: its sub-tasks in the order they were spawned, finished ones too. */
export function taskRailTasks(tasks: readonly Task[], parentId: string): Task[] {
  return tasks.filter((t) => t.parentTaskId === parentId).sort((a, b) => a.createdAt - b.createdAt)
}
