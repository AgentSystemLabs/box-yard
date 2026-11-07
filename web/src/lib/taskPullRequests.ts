import type { PrState, Task } from "../../../shared/types"

export interface TaskPullRequest {
  url: string
  tasks: Task[]
  /** Conflicting or unreported states stay unknown. No readiness is inferred. */
  state: PrState | null
}

export function taskPullRequests(tasks: readonly Task[], projectId: string | null): TaskPullRequest[] {
  const groups = new Map<string, Task[]>()
  for (const task of tasks) {
    if (!task.prUrl || (projectId && task.projectId !== projectId)) continue
    // Group the same PR even when one task linked a fragment or trailing slash.
    const match = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+\/pull\/\d+)(?:[/#?]|$)/i.exec(task.prUrl)
    if (!match) continue
    const url = `https://github.com/${match[1]!.toLowerCase()}`
    const linked = groups.get(url) ?? []
    linked.push(task)
    groups.set(url, linked)
  }
  return [...groups].map(([url, linked]) => {
    const tasks = [...linked].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const state = tasks[0]!.prState ?? null
    return { url, tasks, state: tasks.every((t) => (t.prState ?? null) === state) ? state : null }
  })
}

export const isPrHistory = (pr: TaskPullRequest) => pr.state === "merged" || pr.state === "closed"
export const comparePullRequests = (a: TaskPullRequest, b: TaskPullRequest) => b.tasks[0]!.updatedAt - a.tasks[0]!.updatedAt || a.url.localeCompare(b.url)
