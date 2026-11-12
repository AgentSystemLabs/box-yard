// How a task's pull request reads in the UI: GitHub's open / draft / merged / closed. Pure, so it is unit tested.
import type { PrState, Task, TaskStatus } from "../../../shared/types"
import { PR_COMMENTS_RULE, prCommentsLabel } from "../../../shared/prComments"

export type PrTask = Pick<Task, "prUrl" | "prState" | "prMergedAt" | "prMergedBy" | "prNewComments">

export const prNumber = (url: string | null | undefined) => /\/pull\/(\d+)/.exec(url ?? "")?.[1] ?? null

/** A PR the server hasn't checked yet (or can't, e.g. in mock mode) reads as open. */
export const prStateOf = (task: Pick<Task, "prUrl" | "prState">): PrState | null => (task.prUrl ? (task.prState ?? "open") : null)

const ago = (ts: number, now: number) => {
  const m = Math.round(Math.max(0, now - ts) / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export function prLabel(task: PrTask): string | null {
  const state = prStateOf(task)
  if (!state) return null
  const n = prNumber(task.prUrl)
  const num = n ? ` #${n}` : ""
  return state === "merged" ? `Merged${num}` : state === "closed" ? `Closed${num}` : state === "draft" ? `Draft${num}` : `PR${num}`
}

/**
 * How many comments were written on its PR since it was last opened from Box Yard (shared/prComments.ts says what
 * counts): 0 when there are none, when GitHub hasn't said yet, and for a merged or closed PR.
 */
export function prNewCommentsOf(task: Pick<Task, "prUrl" | "prState" | "prNewComments">): number {
  const state = prStateOf(task)
  return state === "open" || state === "draft" ? Math.max(0, task.prNewComments ?? 0) : 0
}

/** Tooltip, e.g. "Merged 12m ago by cody"; an open PR with new comments says how many, and what isn't counted. */
export function prTooltip(task: PrTask, now = Date.now()): string | null {
  const state = prStateOf(task)
  if (!state) return null
  const comments = prNewCommentsOf(task)
  const head =
    state === "merged"
      ? ["Merged", task.prMergedAt ? ago(task.prMergedAt, now) : "", task.prMergedBy ? `by ${task.prMergedBy}` : ""].filter(Boolean).join(" ")
      : state === "closed"
        ? "Closed without merging"
        : state === "draft"
          ? "Draft pull request"
          : "Open pull request"
  if (comments) return `${head}\n${prCommentsLabel(comments)}\n${PR_COMMENTS_RULE}\n${task.prUrl}`
  return `${head}\n${task.prUrl}`
}

/** The status pill to show: "merged" for a task that is done because its PR merged, else the task's status. */
export type BadgeStatus = TaskStatus | "merged"
export const badgeStatus = (task: Pick<Task, "status" | "prUrl" | "prState">): BadgeStatus =>
  task.status === "done" && task.prUrl && task.prState === "merged" ? "merged" : task.status
