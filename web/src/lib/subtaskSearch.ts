// Task search lists top-level tasks first and sub-tasks in their own group below them (the palette and the sidebar's
// search), so a parent with many sub-tasks that share its words is never pushed out of view.
// Which tasks count as sub-tasks, their parents and the tops of their trees are worked out here. Pure, so unit tested.
import type { Task } from "../../../shared/types"

type TreeTask = Pick<Task, "id" | "title" | "parentTaskId" | "rootTaskId">

export interface TaskTree<T extends TreeTask> {
  /** A sub-task's parent. A task whose parent isn't in the list (deleted) is top-level here, like in the sidebar. */
  parent(t: T): T | undefined
  /** The top-level task a sub-task's tree hangs from; a top-level task's is itself. */
  root(t: T): T
}

/** Deeper than spawn_subtasks nests; a guard against a parent loop in bad data. */
const MAX_DEPTH = 12

export function taskTree<T extends TreeTask>(tasks: readonly T[]): TaskTree<T> {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const parent = (t: T) => (t.parentTaskId && t.parentTaskId !== t.id ? byId.get(t.parentTaskId) : undefined)
  return {
    parent,
    root(t) {
      let top = t
      for (let depth = 0, up = parent(top); up && depth < MAX_DEPTH; depth++, up = parent(top)) top = up
      return top
    },
  }
}

/** Every word of a lowercase query is in `title`: what lists a parent for its sub-tasks' sake. */
export const titleHasWords = (title: string, words: readonly string[]) => {
  const t = title.toLowerCase()
  return words.length > 0 && words.every((w) => t.includes(w))
}

/** "1 sub-task matches", "3 sub-tasks match": why a parent whose own title misses the search is listed. */
export const subtaskHitsLabel = (n: number) => (n === 1 ? "1 sub-task matches" : `${n} sub-tasks match`)
