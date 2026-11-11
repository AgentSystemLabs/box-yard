// Rearranging the sidebar (components/SidebarReorder.tsx): a project among the projects, a task among its project's
// tasks, a sub-task among its parent's. A row only ever moves within the list it's in: there is no way to say another
// project or parent, and the server refuses one. The order is saved on the server (PUT /api/projects/order, PUT
// /api/projects/:id/tasks/order), which sends it to every open client; nothing is kept in the browser. Which list a
// row is in, where a move takes it and what to say about it are pure, so they are unit tested.
import type { QueryClient } from "@tanstack/react-query"
import type { Project, Task } from "../../../shared/types"
import { api } from "./api"
import { applyOrder, sameOrder } from "./projectOrder"
import { keys } from "./queries"
import { captainKey, taskKey, type SidebarGroup, type SidebarRow } from "./sidebar"
import { toast } from "./toast"

/** One list a row can move in: its rows top to bottom, as the sidebar shows them. */
export interface OrderList {
  /** Projects (the list's, or More projects'), a project's tasks, or one task's sub-tasks. */
  kind: "projects" | "tasks" | "subtasks"
  /** The tasks' project. */
  projectId?: string
  /** The sub-tasks' parent. */
  parentTaskId?: string
  /** Each row's id (a project's or a task's), tree key and name, in order. */
  ids: string[]
  keys: string[]
  names: string[]
  /** Tasks only: some row has a place of Cody's, so "Automatic order" has something to undo. */
  placed: boolean
}

/** A row's place: its list, and where it is in it. */
export interface OrderSpot {
  list: OrderList
  index: number
}

export type OrderMove = "up" | "down" | "top" | "bottom"

type Groups = { shown: readonly SidebarGroup[]; others: readonly SidebarGroup[] }

const projectList = (groups: readonly SidebarGroup[]): OrderList => ({
  kind: "projects",
  ids: groups.map((g) => g.project.id),
  keys: groups.map((g) => captainKey(g.project.id)),
  names: groups.map((g) => g.project.name),
  placed: false,
})

const taskList = (rows: readonly SidebarRow[], projectId: string, parentTaskId?: string): OrderList => ({
  kind: parentTaskId ? "subtasks" : "tasks",
  projectId,
  parentTaskId,
  ids: rows.map((r) => r.task.id),
  keys: rows.map((r) => taskKey(r.task.id, "project")),
  names: rows.map((r) => r.task.title),
  placed: rows.some((r) => typeof r.task.sortOrder === "number"),
})

/**
 * The list the row with tree key `key` is in, and its place there. Null for a row that doesn't move: the Coordinator,
 * a fold's own row, and "Waiting on you", which is a queue in the order things need Cody.
 */
export function orderSpot(groups: Groups, key: string | null): OrderSpot | null {
  if (!key) return null
  for (const side of [groups.shown, groups.others]) {
    const index = side.findIndex((g) => captainKey(g.project.id) === key)
    if (index >= 0) return { list: projectList(side), index }
  }
  const find = (rows: readonly SidebarRow[], projectId: string, parent?: string): OrderSpot | null => {
    const index = rows.findIndex((r) => taskKey(r.task.id, "project") === key)
    if (index >= 0) return { list: taskList(rows, projectId, parent), index }
    for (const r of rows) {
      const below = r.kids && find(r.kids, projectId, r.task.id)
      if (below) return below
    }
    return null
  }
  for (const g of groups.shown) {
    const spot = find(g.rows, g.project.id)
    if (spot) return spot
  }
  return null
}

/** Where `move` takes the row at `index` of a list of `length`: its new index, or null when it's already there. */
export function moveTarget(index: number, length: number, move: OrderMove): number | null {
  const to = move === "up" ? index - 1 : move === "down" ? index + 1 : move === "top" ? 0 : length - 1
  return to < 0 || to >= length || to === index ? null : to
}

/** `list` with the item at `from` moved to `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item!)
  return out
}

/**
 * A drop between rows, as the index its row ends at. `slot` counts the rows above the gap (0: before the first, the
 * list's length: after the last), with the moving row still in its place. Null when it would stay where it is.
 */
export function slotTarget(from: number, slot: number): number | null {
  const to = slot > from ? slot - 1 : slot
  return to === from ? null : to
}

/**
 * Every project, in order, once the ones in `siblings` are in that order: they take the places they had between them,
 * so the projects of the other list (More projects, or the pinned and busy ones) stay where they are.
 */
export function projectOrderWith(all: readonly string[], siblings: readonly string[]): string[] {
  const moving = new Set(siblings)
  let next = 0
  return all.map((id) => (moving.has(id) ? siblings[next++]! : id))
}

/** What a screen reader hears after a move. */
export const movedText = (name: string, to: number, length: number) => `${name} moved to ${to + 1} of ${length}`

const failed = (err: unknown) => toast.error("Couldn't save the new order", err instanceof Error ? err.message : undefined)

/**
 * Save `ids` as `list`'s new order. The cache changes at once, so the row is where Cody put it before the server
 * answers; the answer comes over the event stream to every client, this one too. When the save fails, the server's
 * order is fetched again and a toast says so.
 */
export async function saveOrder(qc: QueryClient, list: OrderList, ids: readonly string[]): Promise<boolean> {
  if (list.kind === "projects") {
    const all = qc.getQueryData<Project[]>(keys.projects)?.map((p) => p.id) ?? list.ids
    const order = projectOrderWith(all, ids)
    if (sameOrder(all, order)) return true
    qc.setQueryData<Project[]>(keys.projects, (cached) => (cached ? applyOrder(cached, order) : cached))
    try {
      await api("/api/projects/order", { method: "PUT", body: { ids: order } })
      return true
    } catch (err) {
      failed(err)
      void qc.invalidateQueries({ queryKey: keys.projects })
      return false
    }
  }
  return saveTasks(qc, list, ids, false)
}

/** Clear the places of `list`'s tasks: back to the automatic order. */
export const resetOrder = (qc: QueryClient, list: OrderList) => saveTasks(qc, list, list.ids, true)

async function saveTasks(qc: QueryClient, list: OrderList, ids: readonly string[], auto: boolean): Promise<boolean> {
  const place = new Map(ids.map((id, i) => [id, auto ? null : i]))
  // Only a task whose place changes becomes a new object: the sidebar's rows are memo'd on their task.
  qc.setQueryData<Task[]>(keys.tasks, (cached) =>
    cached?.map((t) => {
      const to = place.get(t.id)
      return to === undefined || (t.sortOrder ?? null) === to ? t : { ...t, sortOrder: to }
    }),
  )
  try {
    await api(`/api/projects/${list.projectId}/tasks/order`, { method: "PUT", body: { parentTaskId: list.parentTaskId ?? null, ids, ...(auto ? { auto: true } : {}) } })
    return true
  } catch (err) {
    failed(err)
    void qc.invalidateQueries({ queryKey: keys.tasks })
    return false
  }
}
