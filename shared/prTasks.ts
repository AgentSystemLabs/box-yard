// Which tasks worked on a pull request (GET /api/prs/:owner/:repo/:number/tasks, server/prTasks.ts), so a PR's
// details in Box Yard say which agents did the work. Read from what Box Yard already records; nothing is stored.

/**
 * How a task worked on the PR. `opened`: it reported the PR first. `pushed`: it reported the same PR later (its
 * create_pull_request pushed to it). `branch`: it worked on the PR's head branch without reporting the PR (its
 * branch, or the branch its turn-end push found checked out). `merge`: it was sent a Merge PR request for it.
 */
export type PrTaskRole = "opened" | "pushed" | "branch" | "merge"

/** Strongest first: a task's roles are listed in this order. */
export const PR_TASK_ROLES: readonly PrTaskRole[] = ["opened", "pushed", "branch", "merge"]

export const PR_TASK_ROLE_LABEL: Record<PrTaskRole, string> = {
  opened: "Opened it",
  pushed: "Pushed to it",
  branch: "Worked on its branch",
  merge: "Asked to merge it",
}

export interface PrTask {
  taskId: string
  /** At least one, in PR_TASK_ROLES order. */
  roles: PrTaskRole[]
  /** The model its latest turn ran on, else the one picked for its next turn; null when Box Yard doesn't know. */
  model: string | null
  /** When it first touched the PR: its first report of it or Merge PR request, or when it started (`branch` only). */
  since: number
}

export interface PrTasksAnswer {
  /** The PR, as https://github.com/<owner>/<repo>/pull/<number>. */
  url: string
  /** Its head branch as the tasks that reported it said, or null when none did. */
  branch: string | null
  /** The task that opened it first, then the rest by `since`. */
  tasks: PrTask[]
}

/** A GitHub PR URL as "owner/repo/number" in lower case, so a fragment, query, trailing slash or other case still matches. */
export function prKey(url: string | null | undefined): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url ?? "")
  return m ? `${m[1]}/${m[2]}/${Number(m[3])}`.toLowerCase() : null
}
