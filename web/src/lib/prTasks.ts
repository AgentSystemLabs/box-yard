// The tasks that worked on a pull request, for its details (PrAgents.tsx): the server's answer (server/prTasks.ts)
// joined with the live task list, so titles, status and where they run stay current while the details are open.
import { useQuery } from "@tanstack/react-query"
import type { Task } from "../../../shared/types"
import { PR_TASK_ROLE_LABEL, prKey, type PrTaskRole, type PrTasksAnswer } from "../../../shared/prTasks"
import { api } from "./api"

export interface PrAgentRow {
  task: Task
  /** Empty until the server answers. */
  roles: PrTaskRole[]
  /** The model its latest turn ran on (or will run on), when known. */
  model: string | null
}

/** GET /api/prs/:owner/:repo/:number/tasks for a PR URL, or null for anything that isn't a GitHub PR. */
export function prTasksPath(url: string | null | undefined): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url ?? "")
  return m ? `/api/prs/${m[1]}/${m[2]}/${Number(m[3])}/tasks` : null
}

export function usePrTasks(url: string | null | undefined) {
  const path = prTasksPath(url)
  return useQuery({
    queryKey: ["pr-tasks", prKey(url) ?? ""],
    queryFn: () => api<PrTasksAnswer>(path!),
    enabled: path !== null,
    staleTime: 10_000,
  })
}

/**
 * The rows to show: the server's tasks in its order, then any task whose current PR this is that the answer doesn't
 * have yet (it linked the PR since). Before the answer (or when it failed) that is every task linked to the PR now.
 * A task the list doesn't have (deleted) is left out.
 */
export function prAgentRows(url: string, answer: PrTasksAnswer | undefined, tasks: readonly Task[]): PrAgentRow[] {
  const key = prKey(url)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const rows: PrAgentRow[] = []
  for (const link of answer?.tasks ?? []) {
    const task = byId.get(link.taskId)
    if (task) rows.push({ task, roles: link.roles, model: link.model ?? task.model })
  }
  const listed = new Set(rows.map((r) => r.task.id))
  const linked = tasks.filter((t) => !listed.has(t.id) && key !== null && prKey(t.prUrl) === key).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  for (const task of linked) rows.push({ task, roles: answer ? [rows.some((r) => r.roles.includes("opened")) ? "pushed" : "opened"] : [], model: task.model })
  return rows
}

/** "Opened it · Asked to merge it". */
export const rolesText = (roles: readonly PrTaskRole[]) => roles.map((r) => PR_TASK_ROLE_LABEL[r]).join(" · ")
