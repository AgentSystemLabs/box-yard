// A task's PR at a glance (shared/prDetails.ts): the one signal the header's PR chip carries, and the PR sheet's lines
// in words. Pure but for the hook, so it is unit tested.
import { useQuery } from "@tanstack/react-query"
import type { PrChecksState, PrDetails, PrDetailsAnswer, PrMergeState, PrReviewState } from "../../../shared/prDetails"
import type { Task } from "../../../shared/types"
import { api } from "./api"
import { prStateOf } from "./prState"

/** good: green · wait: amber (something is still running or someone has to act) · bad: red · quiet: gray. Purple stays Merged's. */
export type PrTone = "good" | "wait" | "bad" | "quiet"

export interface PrSignal {
  kind: "conflicts" | "failing" | "changes" | "pending" | "behind" | "blocked" | "passing"
  tone: PrTone
  label: string
}

/**
 * The one thing to know about an open PR before opening it, most urgent first: conflicts, failing checks, changes
 * requested, checks still running, behind its base, blocked by branch rules, then all checks passing. Null for a
 * merged or closed PR, and for an open one with nothing to say (no checks, GitHub still working it out).
 */
export function prSignal(d: PrDetails | null | undefined): PrSignal | null {
  if (!d || d.state === "merged" || d.state === "closed") return null
  const { checks } = d
  if (d.merge === "conflicts") return { kind: "conflicts", tone: "bad", label: `Conflicts with ${d.base || "its base"}` }
  if (checks.state === "failing") return { kind: "failing", tone: "bad", label: checks.failed > 1 ? `${checks.failed} checks failing` : "A check is failing" }
  if (d.review === "changes_requested") return { kind: "changes", tone: "bad", label: "Changes requested" }
  if (checks.state === "pending") return { kind: "pending", tone: "wait", label: "Checks running" }
  if (d.merge === "behind") return { kind: "behind", tone: "wait", label: `Behind ${d.base || "its base"}` }
  if (d.merge === "blocked") return { kind: "blocked", tone: "wait", label: d.review === "required" ? "Review required" : "Blocked by branch rules" }
  if (checks.state === "passing") return { kind: "passing", tone: "good", label: "Checks passing" }
  return null
}

export interface PrLine {
  tone: PrTone
  text: string
  /** A second, quieter line: what it means or what happens next. */
  hint?: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** "2 failing · 1 running · 10 passed · 1 skipped", toned by GitHub's rollup. */
export function checksLine(c: PrDetails["checks"]): PrLine {
  const tone: Record<PrChecksState, PrTone> = { failing: "bad", pending: "wait", passing: "good", none: "quiet" }
  if (c.state === "none") return { tone: "quiet", text: "No checks on its latest commit" }
  const parts = [c.failed && `${c.failed} failing`, c.pending && `${c.pending} running`, c.passed && `${c.passed} passed`, c.skipped && `${c.skipped} skipped`].filter(Boolean)
  const text = c.state === "passing" && !c.skipped && c.passed > 1 ? `All ${c.passed} passed` : parts.join(" · ") || (c.state === "failing" ? "Failing" : c.state === "pending" ? "Running" : "Passed")
  return { tone: tone[c.state], text }
}

/** Whether it merges cleanly into its base, and what Merge PR does about it when it doesn't. */
export function mergeLine(d: Pick<PrDetails, "merge" | "base">): PrLine {
  const base = d.base || "its base"
  const lines: Record<PrMergeState, PrLine> = {
    clean: { tone: "good", text: `No conflicts with ${base}` },
    conflicts: { tone: "bad", text: `Conflicts with ${base}`, hint: `Merge PR asks the agent to merge ${base} in and resolve them first.` },
    behind: { tone: "wait", text: `Behind ${base}`, hint: `Branch rules want it up to date with ${base}; Merge PR asks the agent to merge it in first.` },
    blocked: { tone: "wait", text: "Blocked by branch rules", hint: "GitHub waits on a required review or check." },
    unknown: { tone: "quiet", text: "GitHub is still checking for conflicts" },
  }
  return lines[d.merge]
}

export function reviewLine(review: PrReviewState): PrLine {
  const lines: Record<PrReviewState, PrLine> = {
    approved: { tone: "good", text: "Approved" },
    changes_requested: { tone: "bad", text: "Changes requested" },
    required: { tone: "wait", text: "Review required" },
    none: { tone: "quiet", text: "No review required" },
  }
  return lines[review]
}

export const filesText = (f: PrDetails["files"]) => `${plural(f.changed, "file")} changed`

export const prDetailsKey = (taskId: string) => ["task-pr", taskId] as const

/**
 * GET /api/tasks/:id/pr. The header asks while the PR is open or a draft and refreshes every minute while the page is
 * visible (the server asks GitHub at most every 20 s however many tabs ask); the sheet asks for a merged or closed one
 * when it opens. Both share one cache entry per task and PR.
 */
export function usePrDetails(task: Pick<Task, "id" | "prUrl" | "prState">, enabled: boolean) {
  const state = prStateOf(task)
  const live = state === "open" || state === "draft"
  return useQuery({
    queryKey: [...prDetailsKey(task.id), task.prUrl],
    queryFn: () => api<PrDetailsAnswer>(`/api/tasks/${encodeURIComponent(task.id)}/pr`),
    enabled: enabled && Boolean(task.prUrl),
    staleTime: 30_000,
    refetchInterval: live ? 60_000 : false,
  })
}
